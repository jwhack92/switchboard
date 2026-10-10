const test = require('node:test');
const assert = require('node:assert/strict');

const { spawnSync } = require('node:child_process');
const os = require('node:os');

const {
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
} = require('../launch-plan');
const shellProfiles = require('../shell-profiles');

// A fake fs: the paths in the list exist, nothing else does.
function fakeFs(paths) {
  const set = new Set(paths);
  return {
    existsSync: (p) => set.has(p),
    lstatSync: () => undefined,
  };
}

test('launch-plan: findExecutable takes the first absolute PATH folder that holds the name, in PATHEXT order', () => {
  const fs = fakeFs(['C:\\a\\claude.cmd', 'C:\\b\\claude.exe']);
  assert.deepEqual(
    findExecutable('claude', { Path: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, fs),
    { path: 'C:\\a\\claude.cmd', ext: '.cmd', direct: false },
  );
  const both = fakeFs(['C:\\a\\claude.exe', 'C:\\a\\claude.cmd', 'C:\\a\\claude.com']);
  assert.deepEqual(
    findExecutable('claude', { Path: 'C:\\a', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, both),
    { path: 'C:\\a\\claude.com', ext: '.com', direct: true },
  );
  assert.deepEqual(
    findExecutable('claude', { Path: 'C:\\a', PATHEXT: '.CMD;.EXE' }, both),
    { path: 'C:\\a\\claude.cmd', ext: '.cmd', direct: false },
  );
  // PATHEXT unset: .COM;.EXE;.BAT;.CMD
  assert.deepEqual(
    findExecutable('claude', { Path: 'C:\\a' }, fakeFs(['C:\\a\\claude.cmd', 'C:\\a\\claude.exe'])),
    { path: 'C:\\a\\claude.exe', ext: '.exe', direct: true },
  );
});

test('launch-plan: findExecutable skips claude.js and an extensionless claude in an earlier folder', () => {
  const fs = fakeFs(['C:\\a\\claude.js', 'C:\\a\\claude', 'C:\\a\\claude.vbs', 'C:\\b\\claude.exe']);
  assert.deepEqual(
    findExecutable('claude', { Path: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC' }, fs),
    { path: 'C:\\b\\claude.exe', ext: '.exe', direct: true },
  );
});

test('launch-plan: findExecutable skips a relative and a "." PATH entry', () => {
  const fs = fakeFs(['claude.exe', '.\\claude.exe', 'bin\\claude.exe', 'C:\\c\\claude.exe']);
  assert.deepEqual(
    findExecutable('claude', { Path: '.;bin;C:\\c' }, fs),
    { path: 'C:\\c\\claude.exe', ext: '.exe', direct: true },
  );
});

test('launch-plan: findExecutable unwraps a PATH entry in double quotes and searches it', () => {
  const fs = fakeFs(['C:\\x y\\claude.exe', 'C:\\z\\claude.exe']);
  assert.deepEqual(
    findExecutable('claude', { Path: '"C:\\x y";C:\\z' }, fs),
    { path: 'C:\\x y\\claude.exe', ext: '.exe', direct: true },
  );
});

test('launch-plan: findExecutable finds the PATH and PATHEXT keys in any case', () => {
  const fs = fakeFs(['C:\\a\\claude.exe', 'C:\\a\\claude.cmd']);
  for (const key of ['Path', 'PATH', 'path', 'pAtH']) {
    assert.deepEqual(
      findExecutable('claude', { [key]: 'C:\\a' }, fs),
      { path: 'C:\\a\\claude.exe', ext: '.exe', direct: true },
      key,
    );
  }
  for (const key of ['PATHEXT', 'PathExt', 'pathext']) {
    assert.deepEqual(
      findExecutable('claude', { Path: 'C:\\a', [key]: '.CMD' }, fs),
      { path: 'C:\\a\\claude.cmd', ext: '.cmd', direct: false },
      key,
    );
  }
});

test('launch-plan: findExecutable with both Path and PATH uses the later key', () => {
  const fs = fakeFs(['C:\\a\\claude.exe', 'C:\\b\\claude.exe']);
  assert.deepEqual(
    findExecutable('claude', { Path: 'C:\\a', PATH: 'C:\\b' }, fs),
    { path: 'C:\\b\\claude.exe', ext: '.exe', direct: true },
  );
  assert.deepEqual(
    findExecutable('claude', { PATH: 'C:\\b', Path: 'C:\\a' }, fs),
    { path: 'C:\\a\\claude.exe', ext: '.exe', direct: true },
  );
});

test('launch-plan: findExecutable resolves a name with a path against cwd, and an absolute name as given', () => {
  const fs = fakeFs(['C:\\proj\\tool.exe', 'C:\\tools\\x.exe', 'C:\\bin\\tool.exe']);
  assert.deepEqual(
    findExecutable('./tool.exe', { Path: 'C:\\bin' }, fs, { cwd: 'C:\\proj' }),
    { path: 'C:\\proj\\tool.exe', ext: '.exe', direct: true },
  );
  assert.deepEqual(
    findExecutable('C:\\tools\\x.exe', { Path: 'C:\\bin' }, fs, { cwd: 'C:\\proj' }),
    { path: 'C:\\tools\\x.exe', ext: '.exe', direct: true },
  );
});

test('launch-plan: findExecutable gives null when the name is not found', () => {
  const fs = fakeFs(['C:\\a\\other.exe']);
  assert.equal(findExecutable('claude', { Path: 'C:\\a;C:\\b' }, fs), null);
  assert.equal(findExecutable('claude', {}, fs), null);
});

// The argv cases of the Windows command line (CommandLineToArgvW rules).
const WCL_CASES = [
  '"two words"',
  '"',
  '""',
  '',
  'C:\\dir\\',
  'a\\\\"b',
  'line1\nline2',
  'two words',
  'x'.repeat(4000),
];

test('launch-plan: windowsCommandLine wraps every argument in quotes and escapes quotes and the backslashes before them', () => {
  assert.equal(windowsCommandLine(['"two words"']), String.raw`"\"two words\""`);
  assert.equal(windowsCommandLine(['"']), String.raw`"\""`);
  assert.equal(windowsCommandLine(['""']), String.raw`"\"\""`);
  assert.equal(windowsCommandLine(['']), '""');
  assert.equal(windowsCommandLine(['C:\\dir\\']), String.raw`"C:\dir\\"`);
  assert.equal(windowsCommandLine(['a\\\\"b']), String.raw`"a\\\\\"b"`);
  assert.equal(windowsCommandLine(['line1\nline2']), '"line1\nline2"');
  assert.equal(windowsCommandLine(['two words']), '"two words"');
  assert.equal(windowsCommandLine(['x'.repeat(4000)]), '"' + 'x'.repeat(4000) + '"');
  assert.equal(windowsCommandLine(['a', 'b c', '']), '"a" "b c" ""');
});

test('launch-plan: windowsCommandLine round trip through a real node child: the child sees exactly the arguments (Windows only)', { skip: process.platform !== 'win32' }, () => {
  const line = windowsCommandLine(['-p', 'JSON.stringify(process.argv.slice(1))', ...WCL_CASES]);
  const r = spawnSync(process.execPath, [line], {
    windowsVerbatimArguments: true,
    argv0: '"' + process.execPath + '"',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), WCL_CASES);
});

test('launch-plan: EXIT_SUFFIX has no leading separator, and withExitSuffix adds exactly one "; " or one newline', () => {
  assert.equal(EXIT_SUFFIX, '$ok=$?; $c=$LASTEXITCODE; exit $(if ($c) {$c} elseif ($ok) {0} else {1})');
  assert.equal(withExitSuffix('npm run x'), 'npm run x; ' + EXIT_SUFFIX);
  assert.equal(withExitSuffix('npm run x', { raw: false }), 'npm run x; ' + EXIT_SUFFIX);
  assert.equal(withExitSuffix('npm run x # note', { raw: true }), 'npm run x # note\n' + EXIT_SUFFIX);
  assert.equal(
    withExitSuffix('claude'),
    'claude; $ok=$?; $c=$LASTEXITCODE; exit $(if ($c) {$c} elseif ($ok) {0} else {1})',
  );
});

// pwsh 7 as the app finds it; null when none is installed.
function findPwsh() {
  return shellProfiles.pwshCandidates(process.env).find((p) => shellProfiles.exeExists(p)) || null;
}

// Runs `pwsh -NoLogo -NoProfile -Command <text>`: the pwsh path as a quoted
// argv0, the rest as ONE windowsCommandLine element.
function runPwsh(pwsh, text) {
  return spawnSync(pwsh, [windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', text])], {
    windowsVerbatimArguments: true,
    argv0: '"' + pwsh + '"',
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('launch-plan: the exit suffix in a real pwsh: a child\'s code passes on, a missing program or a failed statement never exits 0', (t) => {
  const pwsh = findPwsh();
  if (!pwsh) {
    t.skip('pwsh 7 not found');
    return;
  }
  const node = shellProfiles.quoteArgForShell(pwsh, process.execPath);

  const child3 = runPwsh(pwsh, withExitSuffix(`& ${node} -e 'process.exit(3)'`));
  assert.equal(child3.status, 3, `child exiting 3: ${child3.stderr}`);

  const missing = runPwsh(pwsh, withExitSuffix('cmd /c exit 0; switchboard-no-such-program-x7'));
  assert.notEqual(missing.status, 0, 'a missing program after a successful native command');
  assert.notEqual(missing.status, null, `pwsh did not end: ${missing.error}`);

  const failed = runPwsh(pwsh, withExitSuffix('Get-Item nope'));
  assert.equal(failed.status, 1, `a failing statement: ${failed.stderr}`);

  const ok = runPwsh(pwsh, withExitSuffix('cmd /c exit 0'));
  assert.equal(ok.status, 0, `success: ${ok.stderr}`);

  const raw = runPwsh(pwsh, withExitSuffix(`& ${node} -e 'process.exit(4)' # note`, { raw: true }));
  assert.equal(raw.status, 4, `raw text ending in a comment: ${raw.stderr}`);
});

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const PS51 = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CMD = 'C:\\WINDOWS\\system32\\cmd.exe';

test('launch-plan: commandForShell under PowerShell is & \'<exe>\' with quoted args, the bare token after a pre-launch, and single quotes doubled', () => {
  assert.equal(commandForShell(PWSH7, 'npm.cmd', ['run', 'x']), "& 'npm.cmd' 'run' 'x'");
  assert.equal(
    commandForShell(PWSH7, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', ['--session-id', 'abc']),
    "& 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd' '--session-id' 'abc'",
  );
  assert.equal(commandForShell(PS51, 'npm.cmd', ['run', 'x']), "& 'npm.cmd' 'run' 'x'");
  assert.equal(commandForShell(PWSH7, "C:\\it's\\tool.cmd", ["it's"]), "& 'C:\\it''s\\tool.cmd' 'it''s'");
  assert.equal(commandForShell(PWSH7, 'tool.cmd', []), "& 'tool.cmd'");
  assert.equal(
    commandForShell(PWSH7, 'claude', ['--session-id', 'abc'], { afterPreLaunch: true }),
    "claude '--session-id' 'abc'",
  );
  assert.equal(commandForShell(PWSH7, 'claude', [], { afterPreLaunch: true }), 'claude');
});

test('launch-plan: commandForShell under bash and cmd is today\'s quoted executable and quoted args', () => {
  for (const shell of ['/bin/bash', GIT_BASH, CMD, '/usr/bin/fish']) {
    assert.equal(
      commandForShell(shell, 'node', ['a b', "it's"]),
      shellProfiles.quoteArgForShell(shell, 'node') + ' ' + shellProfiles.quoteArgvForShell(shell, ['a b', "it's"]),
      shell,
    );
    assert.equal(commandForShell(shell, 'node', []), shellProfiles.quoteArgForShell(shell, 'node'), shell);
  }
  assert.equal(commandForShell('/bin/bash', 'node', ['a b']), "'node' 'a b'");
  assert.equal(commandForShell(CMD, 'node', ['a b']), '"node" "a b"');
});

const P_CMD = { id: 'cmd', name: 'Command Prompt', path: CMD };
const P_PWSH = { id: 'pwsh', name: 'PowerShell 7', path: PWSH7 };
const P_PS51 = { id: 'powershell', name: 'Windows PowerShell', path: PS51 };
const P_GIT = { id: 'git-bash', name: 'Git Bash', path: GIT_BASH };
const P_MSYS = { id: 'msys2', name: 'MSYS2', path: 'C:\\msys64\\usr\\bin\\bash.exe' };
const P_WSL = { id: 'wsl:Ubuntu', name: 'WSL — Ubuntu', path: 'wsl.exe', args: ['-d', 'Ubuntu'] };

test('launch-plan: pickWindowsAuto takes PowerShell 7, then Windows PowerShell, then Git Bash, then COMSPEC, then cmd.exe', () => {
  const auto = (path, picked) => ({ id: 'auto', name: 'Auto', path, args: [], picked });
  const env = { ComSpec: CMD };
  assert.deepEqual(pickWindowsAuto([P_CMD, P_PWSH, P_PS51, P_GIT, P_MSYS, P_WSL], env), auto(PWSH7, 'pwsh'));
  assert.deepEqual(pickWindowsAuto([P_GIT, P_PS51, P_PWSH], env), auto(PWSH7, 'pwsh'));
  assert.deepEqual(pickWindowsAuto([P_CMD, P_PS51, P_GIT, P_MSYS], env), auto(PS51, 'powershell'));
  assert.deepEqual(pickWindowsAuto([P_GIT, P_PS51], env), auto(PS51, 'powershell'));
  assert.deepEqual(pickWindowsAuto([P_CMD, P_GIT, P_MSYS, P_WSL], env), auto(GIT_BASH, 'git-bash'));
  // msys2 is no longer in Auto's list
  assert.deepEqual(pickWindowsAuto([P_CMD, P_MSYS, P_WSL], env), auto(CMD, null));
  for (const key of ['COMSPEC', 'ComSpec', 'comspec']) {
    assert.deepEqual(pickWindowsAuto([], { [key]: 'D:\\other\\cmd.exe' }), auto('D:\\other\\cmd.exe', null), key);
  }
  assert.deepEqual(pickWindowsAuto([], {}), auto('cmd.exe', null));
  assert.deepEqual(pickWindowsAuto([P_MSYS], {}), auto('cmd.exe', null));
});

test('launch-plan: markAutoPick marks the one profile Auto picks on win32, in copies; darwin and linux get the list as it is', () => {
  const profiles = [P_CMD, P_PWSH, P_PS51, P_GIT];
  const before = JSON.stringify(profiles);
  const marked = markAutoPick(profiles, 'win32', { ComSpec: CMD });
  assert.deepEqual(marked, [P_CMD, { ...P_PWSH, autoPick: true }, P_PS51, P_GIT]);
  assert.equal(marked.filter((p) => p.autoPick).length, 1);
  assert.equal(JSON.stringify(profiles), before, 'the input is not changed');
  assert.notEqual(marked, profiles);
  assert.deepEqual(markAutoPick([P_CMD, P_GIT], 'win32', {}), [P_CMD, { ...P_GIT, autoPick: true }]);
  assert.deepEqual(markAutoPick([P_CMD, P_MSYS], 'win32', {}), [P_CMD, P_MSYS]);

  const unix = [
    { id: 'zsh', name: 'Zsh', path: '/bin/zsh' },
    { id: 'pwsh', name: 'PowerShell', path: '/usr/local/bin/pwsh' },
  ];
  const unixBefore = JSON.stringify(unix);
  for (const platform of ['darwin', 'linux']) {
    const out = markAutoPick(unix, platform, {});
    assert.equal(out, unix, platform);
    assert.equal(JSON.stringify(out), unixBefore, platform);
  }
});

test('launch-plan: POWERSHELL_TERMINAL_ARGS are exactly the PowerShell plain-terminal start arguments', () => {
  assert.deepEqual(POWERSHELL_TERMINAL_ARGS, [
    '-NoLogo',
    '-NoProfile',
    '-NoExit',
    '-Command',
    "function global:claude { Write-Host 'To start a Claude session, use the + button in the sidebar.' -ForegroundColor Yellow; $global:LASTEXITCODE = 1 }",
  ]);
});

test('launch-plan: launchLogLine names the kind, the id or name, how and the file; a shell launch also the shell and the reason', () => {
  const notLink = { lstatSync: () => ({ isSymbolicLink: () => false }), readlinkSync: () => { throw new Error('not a link'); } };
  const direct = { how: 'direct', reason: null, file: 'C:\\bin\\claude.exe', args: '"/stats"', shell: null, error: null };
  assert.equal(
    launchLogLine({ kind: 'session', id: '0f6c3c1e-1111-4222-8333-944445555666', plan: direct }, notLink),
    '[launch] kind=session id=0f6c3c1e-1111-4222-8333-944445555666 how=direct file=C:\\bin\\claude.exe',
  );
  assert.equal(
    launchLogLine({ kind: 'stats', plan: direct }, notLink),
    '[launch] kind=stats how=direct file=C:\\bin\\claude.exe',
  );
  const shell = { how: 'shell', reason: 'cmd-shim', file: GIT_BASH, args: [], shell: GIT_BASH, error: null };
  assert.equal(
    launchLogLine({ kind: 'schedule', name: 'nightly report', plan: shell }, notLink),
    `[launch] kind=schedule name=nightly report how=shell file=${GIT_BASH} shell=${GIT_BASH} reason=cmd-shim`,
  );
  const none = { how: 'none', reason: 'not-found', file: null, args: null, shell: null, error: 'claude was not found on PATH' };
  assert.equal(
    launchLogLine({ kind: 'session', id: 'abc', plan: none }, notLink),
    '[launch] kind=session id=abc how=none reason=not-found',
  );
});

test('launch-plan: launchLogLine adds real=<target> from readlinkSync only when lstat says link and the target differs, and never throws', () => {
  const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
  const target = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe';
  const plan = { how: 'shell', reason: 'pre-launch', file: alias, args: '', shell: alias, error: null };
  const base = `[launch] kind=session id=abc how=shell file=${alias} shell=${alias} reason=pre-launch`;
  const link = { lstatSync: () => ({ isSymbolicLink: () => true }), readlinkSync: () => target };
  assert.equal(launchLogLine({ kind: 'session', id: 'abc', plan }, link), `${base} real=${target}`);

  const sameTarget = { lstatSync: () => ({ isSymbolicLink: () => true }), readlinkSync: () => alias };
  assert.equal(launchLogLine({ kind: 'session', id: 'abc', plan }, sameTarget), base);
  const notLink = { lstatSync: () => ({ isSymbolicLink: () => false }), readlinkSync: () => target };
  assert.equal(launchLogLine({ kind: 'session', id: 'abc', plan }, notLink), base);
  const lstatThrows = { lstatSync: () => { throw new Error('EACCES'); }, readlinkSync: () => target };
  assert.equal(launchLogLine({ kind: 'session', id: 'abc', plan }, lstatThrows), base);
  const readlinkThrows = { lstatSync: () => ({ isSymbolicLink: () => true }), readlinkSync: () => { throw new Error('EINVAL'); } };
  assert.equal(launchLogLine({ kind: 'session', id: 'abc', plan }, readlinkThrows), base);
  assert.equal(launchLogLine({ kind: 'session', id: 'abc', plan }, null), base);
});

// planLaunch on win32: the rows of SPEC 3.1 with fakes.
const WIN_ENV = { Path: 'C:\\bin;C:\\Windows\\System32' };
const GIT = { root: 'C:\\Program Files\\Git', bash: GIT_BASH };
const ARGS = ['--session-id', 'id-1'];
const FLAGS = ['--ide'];
const PRE = 'aws-vault exec p --';
const AUTO_PWSH = { id: 'auto', name: 'Auto', path: PWSH7, args: [], picked: 'pwsh' };
const AUTO_PS51 = { id: 'auto', name: 'Auto', path: PS51, args: [], picked: 'powershell' };
const NOT_FOUND = "claude was not found on PATH (searched the app's PATH; a PATH set only in a shell profile is not read)";
const EXE_FS = fakeFs(['C:\\bin\\claude.exe']);
const COM_FS = fakeFs(['C:\\bin\\claude.com']);
const CMD_FS = fakeFs(['C:\\bin\\claude.cmd']);
const NONE_FS = fakeFs([]);

function win(over) {
  return planLaunch({
    platform: 'win32', fs: EXE_FS, gitBash: GIT, binary: 'claude', args: ARGS, flags: FLAGS,
    profile: AUTO_PWSH, env: WIN_ENV, target: 'pty', ...over,
  });
}

// The PowerShell text of a pre-launch on a picked PowerShell: the bare token and the guarded exit.
const PRE_PS_TEXT = "aws-vault exec p -- claude '--session-id' 'id-1' --ide; " + EXIT_SUFFIX;
const BASH_TEXT = "claude '--session-id' 'id-1' --ide";
const PRE_BASH_TEXT = "aws-vault exec p -- claude '--session-id' 'id-1' --ide";

test('launch-plan: planLaunch on win32 starts a claude found as .exe or .com directly, with the flags appended as argv', () => {
  for (const [fs, file] of [[EXE_FS, 'C:\\bin\\claude.exe'], [COM_FS, 'C:\\bin\\claude.com']]) {
    for (const profile of [AUTO_PWSH, P_PWSH, P_PS51, P_GIT, P_CMD]) {
      assert.deepEqual(win({ fs, profile }), {
        how: 'direct', reason: null, file, args: '"--session-id" "id-1" "--ide"', shell: null, error: null,
      }, `${file} ${profile.id}`);
      assert.deepEqual(win({ fs, profile, target: 'child' }), {
        how: 'direct', reason: null, file, args: ['--session-id', 'id-1', '--ide'], shell: null, error: null,
      }, `${file} ${profile.id} child`);
    }
  }
  assert.equal(win({ flags: [] }).args, windowsCommandLine(ARGS));
  assert.equal(win({ args: ['say "two words"', 'C:\\dir\\'] }).args, windowsCommandLine(['say "two words"', 'C:\\dir\\', '--ide']));
});

test('launch-plan: planLaunch on win32 sends a claude found only as .cmd to a Git Bash login, else through the profile as today', () => {
  assert.deepEqual(win({ fs: CMD_FS }), {
    how: 'shell', reason: 'cmd-shim', file: GIT_BASH, args: ['-l', '-i', '-c', BASH_TEXT], shell: GIT_BASH, error: null,
  });
  assert.deepEqual(win({ fs: CMD_FS, gitBash: null }), {
    how: 'shell', reason: 'cmd-shim', file: PWSH7,
    args: windowsCommandLine(shellProfiles.shellArgs(PWSH7, BASH_TEXT, [], 'win32')),
    shell: PWSH7, error: null,
  });
  const child = win({ fs: CMD_FS, gitBash: null, profile: P_PWSH, target: 'child' });
  assert.ok(Array.isArray(child.args));
  assert.deepEqual(child.args, shellProfiles.shellArgs(PWSH7, BASH_TEXT, [], 'win32'));
  assert.equal(child.args[child.args.length - 1], BASH_TEXT, 'the -Command text is one element');
  assert.equal(child.args[child.args.length - 2], '-Command');
  assert.deepEqual(win({ fs: CMD_FS, gitBash: null, profile: P_CMD }), {
    how: 'shell', reason: 'cmd-shim', file: CMD,
    args: ['/C', 'claude "--session-id" "id-1" --ide'], shell: CMD, error: null,
  });
});

test('launch-plan: planLaunch on win32 spawns nothing when claude is not found and names PATH in the error', () => {
  const none = { how: 'none', reason: 'not-found', file: null, args: null, shell: null, error: NOT_FOUND };
  assert.deepEqual(win({ fs: NONE_FS }), none);
  assert.deepEqual(win({ fs: NONE_FS, target: 'child' }), none);
  assert.deepEqual(win({ fs: NONE_FS, preLaunchCmd: PRE }), none);
  assert.deepEqual(win({ fs: fakeFs(['C:\\bin\\claude.js', 'C:\\bin\\claude']) }), none);
});

test('launch-plan: planLaunch on win32 with a pre-launch command on Auto or Git Bash keeps the Git Bash login, else takes Auto\'s pick', () => {
  for (const profile of [AUTO_PWSH, P_GIT]) {
    assert.deepEqual(win({ preLaunchCmd: PRE, profile }), {
      how: 'shell', reason: 'pre-launch', file: GIT_BASH, args: ['-l', '-i', '-c', PRE_BASH_TEXT], shell: GIT_BASH, error: null,
    }, profile.id);
  }
  assert.deepEqual(win({ preLaunchCmd: PRE, gitBash: null }), {
    how: 'shell', reason: 'pre-launch', file: PWSH7,
    args: windowsCommandLine(shellProfiles.shellArgs(PWSH7, PRE_PS_TEXT, [], 'win32')),
    shell: PWSH7, error: null,
  });
});

test('launch-plan: planLaunch on win32 with a pre-launch on a picked PowerShell 7 writes the bare claude token and the guarded exit', () => {
  for (const gitBash of [GIT, null]) {
    const plan = win({ preLaunchCmd: PRE, profile: P_PWSH, gitBash });
    assert.deepEqual(plan, {
      how: 'shell', reason: 'pre-launch', file: PWSH7,
      args: windowsCommandLine(shellProfiles.shellArgs(PWSH7, PRE_PS_TEXT, [], 'win32')),
      shell: PWSH7, error: null,
    });
    assert.ok(!plan.args.includes('& '), 'never & after a pre-launch');
  }
});

test('launch-plan: planLaunch on win32 with a pre-launch on a picked Windows PowerShell 5.1 goes to Git Bash, else to 5.1', () => {
  assert.deepEqual(win({ preLaunchCmd: PRE, profile: P_PS51 }), {
    how: 'shell', reason: 'ps51', file: GIT_BASH, args: ['-l', '-i', '-c', PRE_BASH_TEXT], shell: GIT_BASH, error: null,
  });
  assert.deepEqual(win({ preLaunchCmd: PRE, profile: P_PS51, gitBash: null }), {
    how: 'shell', reason: 'ps51', file: PS51,
    args: windowsCommandLine(shellProfiles.shellArgs(PS51, PRE_PS_TEXT, [], 'win32')),
    shell: PS51, error: null,
  });
  assert.deepEqual(win({ preLaunchCmd: PRE, profile: AUTO_PS51, gitBash: null }).file, PS51);
  assert.equal(win({ preLaunchCmd: PRE, profile: AUTO_PS51, gitBash: null }).reason, 'pre-launch');
  const child = win({ preLaunchCmd: PRE, profile: P_PS51, gitBash: null, target: 'child' });
  assert.ok(Array.isArray(child.args));
  assert.equal(child.args[child.args.length - 1], PRE_PS_TEXT);
});

test('launch-plan: planLaunch on win32 with a pre-launch on cmd runs today\'s form through cmd', () => {
  for (const gitBash of [GIT, null]) {
    assert.deepEqual(win({ preLaunchCmd: PRE, profile: P_CMD, gitBash }), {
      how: 'shell', reason: 'pre-launch', file: CMD,
      args: ['/C', 'aws-vault exec p -- claude "--session-id" "id-1" --ide'], shell: CMD, error: null,
    });
  }
});

test('launch-plan: planLaunch for target child gives an array in every row that spawns; for target pty a string for direct and PowerShell forms, an array for Git Bash and cmd', () => {
  const rows = [
    {},
    { fs: COM_FS },
    { fs: CMD_FS },
    { fs: CMD_FS, gitBash: null },
    { fs: CMD_FS, gitBash: null, profile: P_PWSH },
    { fs: CMD_FS, gitBash: null, profile: P_PS51 },
    { fs: CMD_FS, gitBash: null, profile: P_CMD },
    { preLaunchCmd: PRE },
    { preLaunchCmd: PRE, gitBash: null },
    { preLaunchCmd: PRE, profile: P_PWSH },
    { preLaunchCmd: PRE, profile: P_PS51 },
    { preLaunchCmd: PRE, profile: P_PS51, gitBash: null },
    { preLaunchCmd: PRE, profile: P_CMD },
    { preLaunchCmd: PRE, profile: P_MSYS, gitBash: null },
    { shellCommand: 'claude "/stats"', args: ['/stats'], flags: [] },
    { shellCommand: 'claude "/stats"', args: ['/stats'], flags: [], fs: CMD_FS },
    { shellCommand: 'claude "/stats"', args: ['/stats'], flags: [], fs: CMD_FS, gitBash: null },
  ];
  for (const row of rows) {
    const child = win({ ...row, target: 'child' });
    assert.ok(Array.isArray(child.args), `child: ${JSON.stringify(row)}`);
    const pty = win({ ...row, target: 'pty' });
    const shell = pty.how === 'direct' ? null : pty.file;
    const wantString = pty.how === 'direct' || /powershell|pwsh/i.test(shell);
    assert.equal(typeof pty.args === 'string', wantString, `pty: ${JSON.stringify(row)}`);
    assert.equal(Array.isArray(pty.args), !wantString, `pty: ${JSON.stringify(row)}`);
  }
});

test('launch-plan: planLaunch for the Stats run on win32: claude.exe /stats directly, the shell command only in a fallback', () => {
  const stats = { binary: 'claude', args: ['/stats'], flags: [], shellCommand: 'claude "/stats"' };
  assert.deepEqual(win(stats), {
    how: 'direct', reason: null, file: 'C:\\bin\\claude.exe', args: '"/stats"', shell: null, error: null,
  });
  assert.deepEqual(win({ ...stats, fs: CMD_FS }), {
    how: 'shell', reason: 'cmd-shim', file: GIT_BASH, args: ['-l', '-i', '-c', 'claude "/stats"'], shell: GIT_BASH, error: null,
  });
});

// What main.js builds today (main.js:2347-2384 for a session, :1504 for Stats, :3188-3189 for the scheduler).
// shellArgs is called with the platform, as today's call runs on a host of that platform.
function todaySession(shell, extra, platform, { pre, ide, args }) {
  let claudeCmd = 'claude' + ' ' + shellProfiles.quoteArgvForShell(shell, args);
  if (pre) claudeCmd = pre + ' ' + claudeCmd;
  if (ide) claudeCmd += ' --ide';
  return { file: shell, args: shellProfiles.shellArgs(shell, claudeCmd, extra, platform) };
}

test('launch-plan: planLaunch on darwin and linux is byte for byte the spawn main.js builds today, pwsh from /etc/shells included', () => {
  const shells = ['/bin/zsh', '/bin/bash', '/usr/local/bin/pwsh', '/usr/bin/fish'];
  const userArgs = ['--session-id', 'id-1', '--append-system-prompt', "it's \"two words\"\nline 2"];
  for (const platform of ['darwin', 'linux']) {
    for (const shell of shells) {
      for (const pre of ['', PRE]) {
        for (const ide of [false, true]) {
          for (const target of ['pty', 'child']) {
            const plan = planLaunch({
              platform, fs: NONE_FS, gitBash: null, binary: 'claude', args: userArgs,
              flags: ide ? ['--ide'] : [], preLaunchCmd: pre, profile: { id: 'auto', name: 'Auto', path: shell },
              env: { PATH: '/usr/bin' }, target,
            });
            const label = `${platform} ${shell} pre=${!!pre} ide=${ide} ${target}`;
            const today = todaySession(shell, [], platform, { pre, ide, args: userArgs });
            assert.deepEqual({ file: plan.file, args: plan.args }, today, label);
            assert.equal(plan.how, 'shell', label);
          }
        }
      }
    }
    // Literal arrays: no -NoProfile off Windows.
    const pwshPlan = planLaunch({
      platform, fs: NONE_FS, gitBash: null, binary: 'claude', args: ['a'], flags: ['--ide'],
      profile: { id: 'pwsh', name: 'PowerShell', path: '/usr/local/bin/pwsh' }, env: {}, target: 'pty',
    });
    assert.deepEqual(pwshPlan.args, ['-NoLogo', '-Command', "claude 'a' --ide"]);
    const zshPlan = planLaunch({
      platform, fs: NONE_FS, gitBash: null, binary: 'claude', args: ['a'], preLaunchCmd: PRE,
      profile: { id: 'zsh', name: 'Zsh', path: '/bin/zsh' }, env: {}, target: 'pty',
    });
    assert.deepEqual(zshPlan.args, ['-l', '-i', '-c', "aws-vault exec p -- claude 'a'"]);
  }
});

test('launch-plan: planLaunch for Stats and the scheduler off Windows is today\'s shell command', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const shell of ['/bin/zsh', '/usr/local/bin/pwsh']) {
      const profile = { id: 'auto', name: 'Auto', path: shell, args: [] };
      const stats = planLaunch({
        platform, fs: NONE_FS, gitBash: null, binary: 'claude', args: ['/stats'],
        shellCommand: 'claude "/stats"', profile, env: {}, target: 'pty',
      });
      assert.deepEqual(
        { file: stats.file, args: stats.args },
        { file: shell, args: shellProfiles.shellArgs(shell, 'claude "/stats"', [], platform) },
      );
      const argv = ['-p', "it's", '--model', 'sonnet'];
      const sched = planLaunch({
        platform, fs: NONE_FS, gitBash: null, binary: 'claude', args: argv, profile, env: {}, target: 'child',
      });
      assert.deepEqual(
        { file: sched.file, args: sched.args },
        { file: shell, args: shellProfiles.shellArgs(shell, 'claude ' + shellProfiles.quoteArgvForShell(shell, argv), [], platform) },
      );
    }
    const zsh = planLaunch({
      platform, fs: NONE_FS, gitBash: null, binary: 'claude', args: ['/stats'],
      shellCommand: 'claude "/stats"', profile: { id: 'zsh', name: 'Zsh', path: '/bin/zsh' }, env: {}, target: 'pty',
    });
    assert.deepEqual(zsh.args, ['-l', '-i', '-c', 'claude "/stats"']);
  }
});

test('launch-plan: planTerminal on win32: PowerShell gets the + button message with -NoProfile and nothing typed; cmd nothing typed; Git Bash as today', () => {
  for (const shell of [PWSH7, PS51]) {
    assert.deepEqual(planTerminal({ platform: 'win32', profile: { path: shell, args: [] } }), {
      file: shell, args: windowsCommandLine(POWERSHELL_TERMINAL_ARGS), typeShim: false,
    });
  }
  assert.deepEqual(planTerminal({ platform: 'win32', profile: { path: CMD, args: [] } }), {
    file: CMD, args: [], typeShim: false,
  });
  assert.deepEqual(planTerminal({ platform: 'win32', profile: { path: GIT_BASH, args: [] } }), {
    file: GIT_BASH, args: ['-l', '-i'], typeShim: true,
  });
  assert.deepEqual(planTerminal({ platform: 'win32', profile: { path: 'wsl.exe', args: ['-d', 'Ubuntu'] } }), {
    file: 'wsl.exe', args: ['-d', 'Ubuntu', '--', 'bash', '-l', '-i'], typeShim: true,
  });
});

test('launch-plan: planTerminal off Windows is today\'s shellArgs(shell, undefined, extra) and the start-up line is typed', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const shell of ['/bin/zsh', '/bin/bash', '/usr/local/bin/pwsh', '/usr/bin/fish']) {
      assert.deepEqual(planTerminal({ platform, profile: { path: shell, args: [] } }), {
        file: shell, args: shellProfiles.shellArgs(shell, undefined, [], platform), typeShim: true,
      }, `${platform} ${shell}`);
    }
    assert.deepEqual(planTerminal({ platform, profile: { path: '/usr/local/bin/pwsh' } }).args, ['-NoLogo', '-NoExit']);
  }
});
