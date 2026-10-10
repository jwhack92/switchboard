// main.js loads this file after its reloader line: a change here needs an app restart.
const path = require('path');
const { exeExists, quoteArgForShell, quoteArgvForShell, shellArgs } = require('./shell-profiles');

const DIRECT_EXTS = ['.com', '.exe'];
const SEARCH_EXTS = ['.com', '.exe', '.bat', '.cmd'];

function envValue(env, name) {
  const wanted = name.toLowerCase();
  let value;
  for (const key of Object.keys(env || {})) {
    if (key.toLowerCase() === wanted) value = env[key];
  }
  return value;
}

function isAbsoluteWindowsPath(p) {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(p);
}

function findExecutable(name, env, fs, { cwd } = {}) {
  const pathExt = envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  const exts = pathExt.split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => SEARCH_EXTS.includes(e));
  const nameExt = path.win32.extname(name).toLowerCase();
  const givenHasExt = SEARCH_EXTS.includes(nameExt);

  const tryIn = (base) => {
    if (givenHasExt && exeExists(base, fs)) {
      return { path: base, ext: nameExt, direct: DIRECT_EXTS.includes(nameExt) };
    }
    for (const ext of exts) {
      const candidate = base + ext;
      if (exeExists(candidate, fs)) {
        return { path: candidate, ext, direct: DIRECT_EXTS.includes(ext) };
      }
    }
    return null;
  };

  if (/[\\/]/.test(name)) {
    if (isAbsoluteWindowsPath(name)) return tryIn(name);
    if (!cwd) return null;
    return tryIn(path.win32.join(cwd, name));
  }

  const entries = String(envValue(env, 'PATH') || '').split(';');
  for (let entry of entries) {
    entry = entry.trim();
    if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    if (!entry || !isAbsoluteWindowsPath(entry)) continue;
    const found = tryIn(path.win32.join(entry, name));
    if (found) return found;
  }
  return null;
}

function windowsCommandLine(argv) {
  return argv.map((arg) => {
    const s = String(arg);
    let out = '"';
    let slashes = 0;
    for (const ch of s) {
      if (ch === '\\') {
        slashes++;
        continue;
      }
      if (ch === '"') {
        out += '\\'.repeat(slashes * 2 + 1) + '"';
      } else {
        out += '\\'.repeat(slashes) + ch;
      }
      slashes = 0;
    }
    return out + '\\'.repeat(slashes * 2) + '"';
  }).join(' ');
}

const EXIT_SUFFIX = '$ok=$?; $c=$LASTEXITCODE; exit $(if ($c) {$c} elseif ($ok) {0} else {1})';

function withExitSuffix(command, { raw = false } = {}) {
  return command + (raw ? '\n' : '; ') + EXIT_SUFFIX;
}

function isPowerShell(shellPath) {
  const base = path.win32.basename(String(shellPath)).toLowerCase();
  return base.includes('powershell') || base.includes('pwsh');
}

function commandForShell(shellPath, executable, args, { afterPreLaunch = false } = {}) {
  const quotedArgs = args.length ? ` ${quoteArgvForShell(shellPath, args)}` : '';
  if (isPowerShell(shellPath)) {
    if (afterPreLaunch) return `${executable}${quotedArgs}`;
    return `& ${quoteArgForShell(shellPath, executable)}${quotedArgs}`;
  }
  return `${quoteArgForShell(shellPath, executable)}${quotedArgs}`;
}

const WINDOWS_AUTO_ORDER = ['pwsh', 'powershell', 'git-bash'];

function pickWindowsAuto(profiles, env) {
  for (const id of WINDOWS_AUTO_ORDER) {
    const profile = (profiles || []).find((p) => p.id === id);
    if (profile) return { id: 'auto', name: 'Auto', path: profile.path, args: [], picked: id };
  }
  return { id: 'auto', name: 'Auto', path: envValue(env, 'COMSPEC') || 'cmd.exe', args: [], picked: null };
}

function markAutoPick(profiles, platform, env) {
  if (platform !== 'win32') return profiles;
  const { picked } = pickWindowsAuto(profiles, env);
  return profiles.map((p) => (picked && p.id === picked ? { ...p, autoPick: true } : { ...p }));
}

const POWERSHELL_TERMINAL_ARGS = ['-NoLogo', '-NoProfile', '-NoExit', '-Command', "function global:claude { Write-Host 'To start a Claude session, use the + button in the sidebar.' -ForegroundColor Yellow; $global:LASTEXITCODE = 1 }"];

function launchLogLine({ kind, id, name, plan }, fs) {
  let line = `[launch] kind=${kind}`;
  if (id) line += ` id=${id}`;
  else if (name) line += ` name=${name}`;
  line += ` how=${plan.how}`;
  if (plan.how === 'none') return `${line} reason=${plan.reason}`;
  line += ` file=${plan.file}`;
  if (plan.how === 'shell') line += ` shell=${plan.shell} reason=${plan.reason}`;
  try {
    if (fs.lstatSync(plan.file).isSymbolicLink()) {
      const real = fs.readlinkSync(plan.file);
      if (real && real !== plan.file) line += ` real=${real}`;
    }
  } catch {}
  return line;
}

function planLaunch({ platform, fs, gitBash, binary, args, flags = [], preLaunchCmd = '', profile, env, target = 'pty', shellCommand }) {
  const flagText = flags.map((f) => ' ' + f).join('');
  const todayCommand = (shellPath) => shellCommand
    || (preLaunchCmd ? preLaunchCmd + ' ' : '') + binary + ' ' + quoteArgvForShell(shellPath, args) + flagText;
  const throughShell = (shellPath, extraArgs, command, reason) => {
    const argv = shellArgs(shellPath, command, extraArgs, platform);
    const asString = platform === 'win32' && target === 'pty' && isPowerShell(shellPath);
    return { how: 'shell', reason, file: shellPath, args: asString ? windowsCommandLine(argv) : argv, shell: shellPath, error: null };
  };
  const profileArgs = profile.args || [];

  if (platform !== 'win32') return throughShell(profile.path, profileArgs, todayCommand(profile.path), 'not-windows');

  const found = findExecutable(binary, env, fs);
  if (!found) {
    return {
      how: 'none', reason: 'not-found', file: null, args: null, shell: null,
      error: `${binary} was not found on PATH (searched the app's PATH; a PATH set only in a shell profile is not read)`,
    };
  }
  const gitBashLogin = (reason) => throughShell(gitBash.bash, [], todayCommand(gitBash.bash), reason);
  const powerShellPreLaunch = (reason) => throughShell(profile.path, profileArgs,
    withExitSuffix(preLaunchCmd + ' ' + commandForShell(profile.path, binary, args, { afterPreLaunch: true }) + flagText), reason);

  if (preLaunchCmd) {
    if ((profile.id === 'auto' || profile.id === 'git-bash') && gitBash) return gitBashLogin('pre-launch');
    const base = path.win32.basename(String(profile.path)).toLowerCase();
    if (base.includes('pwsh')) return powerShellPreLaunch('pre-launch');
    if (base.includes('powershell')) return gitBash ? gitBashLogin('ps51') : powerShellPreLaunch(profile.id === 'auto' ? 'pre-launch' : 'ps51');
    return throughShell(profile.path, profileArgs, todayCommand(profile.path), 'pre-launch');
  }
  if (!found.direct) {
    if (gitBash) return gitBashLogin('cmd-shim');
    return throughShell(profile.path, profileArgs, todayCommand(profile.path), 'cmd-shim');
  }
  const argv = [...args, ...flags];
  return { how: 'direct', reason: null, file: found.path, args: target === 'pty' ? windowsCommandLine(argv) : argv, shell: null, error: null };
}

function planTerminal({ platform, profile }) {
  const extra = profile.args || [];
  if (platform === 'win32') {
    if (isPowerShell(profile.path)) {
      return { file: profile.path, args: windowsCommandLine(POWERSHELL_TERMINAL_ARGS), typeShim: false };
    }
    const base = path.win32.basename(String(profile.path)).toLowerCase();
    if (base === 'cmd.exe' || base === 'cmd') {
      return { file: profile.path, args: shellArgs(profile.path, undefined, extra, platform), typeShim: false };
    }
  }
  return { file: profile.path, args: shellArgs(profile.path, undefined, extra, platform), typeShim: true };
}

module.exports = {
  findExecutable,
  windowsCommandLine,
  EXIT_SUFFIX,
  withExitSuffix,
  commandForShell,
  pickWindowsAuto,
  markAutoPick,
  POWERSHELL_TERMINAL_ARGS,
  launchLogLine,
  planLaunch,
  planTerminal,
};
