const path = require('path');
const fs = require('fs');

// --- Cross-platform shell resolution ---
const isWindows = process.platform === 'win32';

function exeExists(p, fsLike = fs) {
  try {
    if (fsLike.existsSync(p)) return true;
    return !!fsLike.lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return false;
  }
}

function pwshCandidates(env) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.win32.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
  ];
  if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  if (env.USERPROFILE) candidates.push(path.win32.join(env.USERPROFILE, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  return candidates;
}

function findGitBash(env = process.env, fsLike = fs) {
  const candidates = [
    path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];
  if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  for (const bash of candidates) {
    if (exeExists(bash, fsLike)) return { root: path.win32.dirname(path.win32.dirname(bash)), bash };
  }
  return null;
}

function windowsEnvFacts(platform = process.platform, env = process.env, { fs: fsLike = fs, execFileSync = require('child_process').execFileSync, now = Date.now } = {}) {
  if (platform !== 'win32') return null;
  const git = findGitBash(env, fsLike);
  const localeSet = Object.keys(env).some((k) => ['LANG', 'LC_ALL', 'LC_CTYPE'].includes(k.toUpperCase()) && env[k]);
  let locale = null;
  let ms = 0;
  if (git && !localeSet) {
    const start = now();
    try {
      const out = execFileSync(path.win32.join(git.root, 'usr', 'bin', 'locale.exe'), ['-uU'], { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      locale = String(out).trim() || null;
    } catch {
      locale = null;
    }
    ms = now() - start;
  }
  let intl = null;
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    intl = null;
  }
  return { git, locale, intl, ms };
}

// Discover available shell profiles on this system.
// Returns an array of { id, name, path, args? } objects.
function discoverShellProfiles() {
  const profiles = [];

  if (isWindows) {
    const { execSync } = require('child_process');

    // CMD
    const comspec = process.env.COMSPEC || 'C:\\WINDOWS\\system32\\cmd.exe';
    if (fs.existsSync(comspec)) {
      profiles.push({ id: 'cmd', name: 'Command Prompt', path: comspec });
    }

    // PowerShell 7+ (pwsh)
    for (const p of pwshCandidates(process.env)) {
      if (exeExists(p)) {
        profiles.push({ id: 'pwsh', name: 'PowerShell 7', path: p });
        break;
      }
    }

    // Windows PowerShell 5.x
    const ps5 = path.join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(ps5)) {
      profiles.push({ id: 'powershell', name: 'Windows PowerShell', path: ps5 });
    }

    // Git Bash
    const gitBash = findGitBash();
    if (gitBash) {
      profiles.push({ id: 'git-bash', name: 'Git Bash', path: gitBash.bash });
    }

    // MSYS2
    if (fs.existsSync('C:\\msys64\\usr\\bin\\bash.exe')) {
      profiles.push({ id: 'msys2', name: 'MSYS2', path: 'C:\\msys64\\usr\\bin\\bash.exe' });
    }

    // WSL distributions
    try {
      const raw = execSync('wsl.exe --list --quiet', { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const distros = raw.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const distro of distros) {
        profiles.push({ id: 'wsl:' + distro, name: 'WSL — ' + distro, path: 'wsl.exe', args: ['-d', distro] });
      }
    } catch {}
  } else {
    // macOS / Linux: read /etc/shells for the canonical list
    const seen = new Set();
    const shellNames = {
      'zsh': 'Zsh', 'bash': 'Bash', 'sh': 'POSIX Shell',
      'fish': 'Fish', 'nu': 'Nushell', 'pwsh': 'PowerShell',
      'dash': 'Dash', 'ksh': 'Korn Shell', 'tcsh': 'tcsh', 'csh': 'C Shell',
    };
    try {
      const lines = fs.readFileSync('/etc/shells', 'utf8').split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      for (const shellPath of lines) {
        if (!fs.existsSync(shellPath)) continue;
        const base = path.basename(shellPath);
        // Deduplicate by basename (e.g. /bin/bash and /usr/bin/bash)
        if (seen.has(base)) continue;
        seen.add(base);
        const name = shellNames[base] || base;
        profiles.push({ id: base, name, path: shellPath });
      }
    } catch {
      // Fallback if /etc/shells is unreadable
      for (const [id, name, p] of [
        ['zsh', 'Zsh', '/bin/zsh'],
        ['bash', 'Bash', '/bin/bash'],
        ['sh', 'POSIX Shell', '/bin/sh'],
      ]) {
        if (fs.existsSync(p)) {
          profiles.push({ id, name, path: p });
        }
      }
    }
  }

  return profiles;
}

// Cache profiles (discovered once on startup, refreshed via IPC if needed)
let _shellProfiles = null;
function getShellProfiles() {
  if (!_shellProfiles) _shellProfiles = discoverShellProfiles();
  return _shellProfiles;
}

function resolveShell(profileId) {
  // If a profile is selected, use it
  if (profileId && profileId !== 'auto') {
    const profiles = getShellProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (profile && (profile.path === 'wsl.exe' || fs.existsSync(profile.path) || (isWindows && exeExists(profile.path)))) {
      return profile;
    }
  }

  // Auto: original detection logic
  if (isWindows) return require('./launch-plan').pickWindowsAuto(getShellProfiles(), process.env);

  // 1. Respect explicit SHELL env (set by Git Bash, MSYS2, WSL, etc.)
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return { id: 'auto', name: 'Auto', path: process.env.SHELL };
  }

  // Unix fallback chain
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(s)) return { id: 'auto', name: 'Auto', path: s };
  }
  return { id: 'auto', name: 'Auto', path: '/bin/sh' };
}

// Convert a Windows path to a WSL /mnt/ path
function windowsToWslPath(winPath) {
  if (!winPath) return winPath;
  // C:\Users\foo → /mnt/c/Users/foo
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(\/.*)/);
  if (match) return '/mnt/' + match[1].toLowerCase() + match[2];
  return normalized;
}

function isWslShell(shellPath) {
  const base = path.basename(shellPath).toLowerCase();
  return base === 'wsl.exe' || base === 'wsl';
}

// Shell-quote one argv token per shell family
function quoteArgForShell(shellPath, value) {
  const s = value == null ? '' : String(value);
  const base = path.basename(shellPath).toLowerCase();
  const isBashLike = base.includes('bash') || base.includes('zsh') || base === 'sh' || base === 'dash' || base === 'ksh' || base === 'fish' || base === 'nu' || isWslShell(shellPath);
  const isPowerShell = base.includes('powershell') || base.includes('pwsh');

  if (isBashLike) {
    // POSIX: wrap in single quotes, escape embedded single quotes as '\''
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  if (isPowerShell) {
    // PowerShell: single-quoted string, escape ' as ''
    return "'" + s.replace(/'/g, "''") + "'";
  }
  // cmd.exe: double-quote, escape " as \" and ^-escape shell metachars
  const escaped = s.replace(/"/g, '\\"').replace(/([&|<>^%])/g, '^$1');
  return '"' + escaped + '"';
}

function quoteArgvForShell(shellPath, argv) {
  return argv.map(a => quoteArgForShell(shellPath, a)).join(' ');
}

// Returns spawn args appropriate for the resolved shell
function shellArgs(shellPath, cmd, extraArgs, platform = process.platform) {
  const base = path.basename(shellPath).toLowerCase();
  const isBashLike = base.includes('bash') || base.includes('zsh') || base === 'sh';
  const isFish = base === 'fish';
  const isNushell = base === 'nu';

  // WSL: pass command via -- to the distribution shell
  // cwd is handled separately via --cd in the spawn call
  if (isWslShell(shellPath)) {
    if (cmd) return [...(extraArgs || []), '--', 'bash', '-l', '-i', '-c', cmd];
    return [...(extraArgs || []), '--', 'bash', '-l', '-i'];
  }

  if (cmd) {
    if (isBashLike) return ['-l', '-i', '-c', cmd];
    if (isFish) return ['-l', '-c', cmd];
    if (isNushell) return ['-l', '-c', cmd];
    if (base.includes('powershell') || base.includes('pwsh')) return platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', cmd] : ['-NoLogo', '-Command', cmd];
    return ['/C', cmd];
  }
  if (isBashLike) return ['-l', '-i'];
  if (isFish) return ['-l', '-i'];
  if (isNushell) return ['-l', '-i'];
  if (base.includes('powershell') || base.includes('pwsh')) return platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NoExit'] : ['-NoLogo', '-NoExit'];
  return [];
}

module.exports = { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgForShell, quoteArgvForShell, exeExists, pwshCandidates, findGitBash, windowsEnvFacts };
