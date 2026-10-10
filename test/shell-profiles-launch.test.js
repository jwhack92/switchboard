const test = require('node:test');
const assert = require('node:assert/strict');

const shellProfiles = require('../shell-profiles');

// A fake fs: `files` exist for existsSync, `links` only for lstatSync (as the Store alias does, D8).
function fakeFs(files = [], links = []) {
  const fileSet = new Set(files);
  const linkSet = new Set(links);
  return {
    existsSync: (p) => fileSet.has(p),
    lstatSync: (p) => (fileSet.has(p) || linkSet.has(p) ? { isSymbolicLink: () => linkSet.has(p) } : undefined),
  };
}

test('shell-profiles: exeExists is true for a file existsSync sees, and for a link only lstat sees', () => {
  const { exeExists } = shellProfiles;
  assert.equal(exeExists('C:\\a\\pwsh.exe', fakeFs(['C:\\a\\pwsh.exe'])), true);
  const storeAlias = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
  assert.equal(exeExists(storeAlias, fakeFs([], [storeAlias])), true, 'existsSync false, lstat a stat');
  assert.equal(exeExists('C:\\none\\pwsh.exe', fakeFs()), false, 'both missing');
  const throwing = {
    existsSync: () => false,
    lstatSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  };
  assert.equal(exeExists(storeAlias, throwing), false, 'lstat throwing');
});

test('shell-profiles: pwshCandidates lists Program Files 7, 7-preview, then both Store entries', () => {
  const env = { ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Local', USERPROFILE: 'C:\\Users\\u' };
  assert.deepEqual(shellProfiles.pwshCandidates(env), [
    'C:\\PF\\PowerShell\\7\\pwsh.exe',
    'C:\\PF\\PowerShell\\7-preview\\pwsh.exe',
    'C:\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
    'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
  ]);
});

test('shell-profiles: findGitBash finds Git under each of the three roots, root two levels above bin\\bash.exe, and null without one', () => {
  const { findGitBash } = shellProfiles;
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.deepEqual(findGitBash(env, fakeFs(['C:\\PF\\Git\\bin\\bash.exe'])),
    { root: 'C:\\PF\\Git', bash: 'C:\\PF\\Git\\bin\\bash.exe' });
  assert.deepEqual(findGitBash(env, fakeFs(['C:\\PF86\\Git\\bin\\bash.exe'])),
    { root: 'C:\\PF86\\Git', bash: 'C:\\PF86\\Git\\bin\\bash.exe' });
  assert.deepEqual(findGitBash(env, fakeFs(['C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'])),
    { root: 'C:\\Users\\u\\AppData\\Local\\Programs\\Git', bash: 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe' });
  assert.deepEqual(findGitBash(env, fakeFs(['C:\\PF86\\Git\\bin\\bash.exe', 'C:\\PF\\Git\\bin\\bash.exe'])),
    { root: 'C:\\PF\\Git', bash: 'C:\\PF\\Git\\bin\\bash.exe' }, 'Program Files first');
  assert.equal(findGitBash(env, fakeFs()), null);
});

test('shell-profiles: shellArgs on win32 puts -NoProfile right after -NoLogo for pwsh.exe and powershell.exe', () => {
  const { shellArgs } = shellProfiles;
  for (const ps of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']) {
    assert.deepEqual(shellArgs(ps, 'claude', [], 'win32'), ['-NoLogo', '-NoProfile', '-Command', 'claude'], ps);
    assert.deepEqual(shellArgs(ps, undefined, [], 'win32'), ['-NoLogo', '-NoProfile', '-NoExit'], ps);
  }
});

test('shell-profiles: shellArgs on darwin and linux gives pwsh exactly today\'s arrays', () => {
  const { shellArgs } = shellProfiles;
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(shellArgs('/usr/local/bin/pwsh', 'claude', [], platform), ['-NoLogo', '-Command', 'claude'], platform);
    assert.deepEqual(shellArgs('/usr/local/bin/pwsh', undefined, [], platform), ['-NoLogo', '-NoExit'], platform);
  }
});

test('shell-profiles: shellArgs for bash, zsh, sh, fish, nu, cmd and WSL is unchanged on win32, darwin and linux', () => {
  const { shellArgs } = shellProfiles;
  const rows = [
    ['/bin/bash', [], ['-l', '-i', '-c', 'claude'], ['-l', '-i']],
    ['C:\\Program Files\\Git\\bin\\bash.exe', [], ['-l', '-i', '-c', 'claude'], ['-l', '-i']],
    ['/bin/zsh', [], ['-l', '-i', '-c', 'claude'], ['-l', '-i']],
    ['/bin/sh', [], ['-l', '-i', '-c', 'claude'], ['-l', '-i']],
    ['/usr/bin/fish', [], ['-l', '-c', 'claude'], ['-l', '-i']],
    ['/usr/bin/nu', [], ['-l', '-c', 'claude'], ['-l', '-i']],
    ['C:\\WINDOWS\\system32\\cmd.exe', [], ['/C', 'claude'], []],
    ['wsl.exe', ['-d', 'Ubuntu'], ['-d', 'Ubuntu', '--', 'bash', '-l', '-i', '-c', 'claude'], ['-d', 'Ubuntu', '--', 'bash', '-l', '-i']],
  ];
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const [shell, extra, withCmd, withoutCmd] of rows) {
      assert.deepEqual(shellArgs(shell, 'claude', extra, platform), withCmd, `${shell} on ${platform}, with a command`);
      assert.deepEqual(shellArgs(shell, undefined, extra, platform), withoutCmd, `${shell} on ${platform}, without`);
    }
  }
});

test('shell-profiles: windowsEnvFacts is null off Windows', () => {
  const { windowsEnvFacts } = shellProfiles;
  assert.equal(windowsEnvFacts('linux'), null);
  assert.equal(windowsEnvFacts('darwin', { ProgramFiles: 'C:\\PF' }), null);
});

function factsFakes({ output = 'en_US.UTF-8\n', error = null, git = true } = {}) {
  const calls = [];
  const times = [1000, 1040];
  return {
    calls,
    fakes: {
      fs: fakeFs(git ? ['C:\\PF\\Git\\bin\\bash.exe'] : []),
      execFileSync: (file, args, options) => {
        calls.push({ file, args, options });
        if (error) throw error;
        return output;
      },
      now: () => (times.length ? times.shift() : 2000),
    },
  };
}

test('shell-profiles: windowsEnvFacts on win32 finds Git and runs its locale.exe -uU once, with a 1500 ms limit, when no locale variable is set', () => {
  const { windowsEnvFacts } = shellProfiles;
  const { calls, fakes } = factsFakes();
  const facts = windowsEnvFacts('win32', { ProgramFiles: 'C:\\PF' }, fakes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\PF\\Git\\usr\\bin\\locale.exe');
  assert.deepEqual(calls[0].args, ['-uU']);
  assert.equal(calls[0].options.timeout, 1500);
  assert.deepEqual(facts.git, { root: 'C:\\PF\\Git', bash: 'C:\\PF\\Git\\bin\\bash.exe' });
  assert.equal(facts.locale, 'en_US.UTF-8');
  assert.equal(facts.intl, Intl.DateTimeFormat().resolvedOptions().locale);
  assert.equal(facts.ms, 40);
});

test('shell-profiles: windowsEnvFacts does not run locale.exe when a locale variable is set, in any case, or when Git is missing', () => {
  const { windowsEnvFacts } = shellProfiles;
  for (const set of [{ LANG: 'de_DE.UTF-8' }, { LC_ALL: 'C.UTF-8' }, { LC_CTYPE: 'UTF-8' }, { lang: 'en_GB.UTF-8' }]) {
    const { calls, fakes } = factsFakes();
    const facts = windowsEnvFacts('win32', { ProgramFiles: 'C:\\PF', ...set }, fakes);
    assert.equal(calls.length, 0, JSON.stringify(set));
    assert.equal(facts.locale, null, JSON.stringify(set));
    assert.deepEqual(facts.git, { root: 'C:\\PF\\Git', bash: 'C:\\PF\\Git\\bin\\bash.exe' });
  }
  const { calls, fakes } = factsFakes({ git: false });
  const facts = windowsEnvFacts('win32', { ProgramFiles: 'C:\\PF' }, fakes);
  assert.equal(calls.length, 0, 'no Git');
  assert.equal(facts.git, null);
  assert.equal(facts.locale, null);
});

test('shell-profiles: windowsEnvFacts survives a throw or a timeout of locale.exe, and an empty answer', () => {
  const { windowsEnvFacts } = shellProfiles;
  const timeout = Object.assign(new Error('spawnSync locale.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
  for (const options of [{ error: new Error('boom') }, { error: timeout }, { output: '' }]) {
    const { calls, fakes } = factsFakes(options);
    let facts;
    assert.doesNotThrow(() => { facts = windowsEnvFacts('win32', { ProgramFiles: 'C:\\PF' }, fakes); });
    assert.equal(calls.length, 1);
    assert.equal(facts.locale, null);
    assert.deepEqual(facts.git, { root: 'C:\\PF\\Git', bash: 'C:\\PF\\Git\\bin\\bash.exe' });
  }
});

test('shell-profiles: on Windows a picked profile that only lstat sees (the Store pwsh) is used as picked, not replaced by Auto (Windows with such a profile only, otherwise skipped)', { skip: process.platform !== 'win32' }, (t) => {
  const fs = require('fs');
  const p = shellProfiles.getShellProfiles().find((x) => x.path !== 'wsl.exe' && !fs.existsSync(x.path) && shellProfiles.exeExists(x.path));
  if (!p) { t.skip('no profile that only lstat sees'); return; }
  assert.equal(shellProfiles.resolveShell(p.id).id, p.id);
});
