const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPtyEnv, CLAUDE_SESSION_VARS } = require('../pty-env');

test('strips Electron internals that break nested Electron / node-pty', () => {
  // Platform passed explicitly: with the default it would depend on where the
  // suite runs, and assert one thing on macOS and another everywhere else.
  const env = buildPtyEnv({
    ELECTRON_RUN_AS_NODE: '1',
    GOOGLE_API_KEY: 'secret',
    NODE_OPTIONS: '--inspect',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    WT_SESSION: 'abc',
    PATH: '/usr/bin',
  }, 'linux');
  assert.deepEqual(Object.keys(env).sort(), ['PATH']);
});

test('sets a UTF-8 LC_CTYPE when the parent env has no locale at all', () => {
  // The macOS Finder/Dock launch case: launchd sets no LANG, so pbcopy would
  // fall back to Mac OS Roman and mangle UTF-8 on the way to the clipboard.
  assert.equal(buildPtyEnv({ PATH: '/usr/bin' }, 'darwin').LC_CTYPE, 'UTF-8');
});

test('an inherited locale wins — we do not override the user', () => {
  for (const inherited of [{ LANG: 'de_DE.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8' }, { LC_CTYPE: 'fr_FR.ISO8859-1' }]) {
    const env = buildPtyEnv({ ...inherited }, 'darwin');
    assert.deepEqual(env, inherited);
  }
});

test('an empty locale value counts as absent', () => {
  // launchctl reports LANG as empty rather than unset on some macOS setups;
  // an empty string gives pbcopy nothing to work with either.
  assert.equal(buildPtyEnv({ LANG: '' }, 'darwin').LC_CTYPE, 'UTF-8');
});

// --- fork-only: inherited Claude Code session markers ----------------------
//
// Upstream's pty-env.js has no equivalent of this, so importing their file
// wholesale would delete it. The failure it prevents is not a crash: with
// CLAUDE_CODE_CHILD_SESSION inherited, the nested CLI decides it is a child,
// prints "Transcript saving is off", and writes no transcript — so the session
// never appears in Switchboard at all. A session that silently does not exist
// is not something anyone traces back to an env filter, which is exactly why
// this is pinned rather than left to review.

test('every inherited Claude Code session marker is stripped', () => {
  const source = { PATH: '/usr/bin' };
  for (const k of CLAUDE_SESSION_VARS) source[k] = 'inherited';
  const env = buildPtyEnv(source);
  for (const k of CLAUDE_SESSION_VARS) {
    assert.equal(env[k], undefined, `${k} survived into the PTY env`);
  }
  assert.equal(env.PATH, '/usr/bin');
});

test('the marker list still covers the ones that actively break a session', () => {
  // Named individually so that removing one from the list fails here rather
  // than silently shrinking the guarantee.
  for (const k of [
    'CLAUDE_CODE_CHILD_SESSION',      // suppresses transcript writing
    'CLAUDE_CODE_MESSAGING_SOCKET',   // points the child at the parent's IPC
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ID',
  ]) {
    assert.ok(CLAUDE_SESSION_VARS.includes(k), `${k} missing from CLAUDE_SESSION_VARS`);
  }
});

// --- the locale fallback is macOS-only, and that is load-bearing -----------
//
// Injecting LC_CTYPE=UTF-8 on Windows suppresses Git Bash's own locale
// autodetect (its lang.sh guard tests exactly this variable) and MSYS resolves
// the bare value to "C" — so the fallback meant to guarantee UTF-8 removes it
// on the platform this fork actually runs on. Measured: `printf '…→' | wc -m`
// gives 3 without it and 7 with it.

test('no locale is injected off macOS — it suppresses the detection it means to help', () => {
  for (const platform of ['win32', 'linux', 'freebsd']) {
    const env = buildPtyEnv({ PATH: '/usr/bin' }, platform);
    assert.equal(env.LC_CTYPE, undefined, `LC_CTYPE was injected on ${platform}`);
    assert.deepEqual(Object.keys(env), ['PATH']);
  }
});

test('an inherited locale is passed through untouched on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(buildPtyEnv({ LANG: 'en_US.UTF-8' }, platform).LANG, 'en_US.UTF-8');
  }
});

// --- the terminal identity values and the Stats environment (relaunch work, small fixes commit b) ---

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TERMINAL_IDENTITY_ENV, statsPtyEnv } = require('../pty-env');
const { ROOT, cut } = require('../test-support/source-cut');

const SIX = {
  TERM: 'xterm-256color', COLORTERM: 'truecolor',
  TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6',
  FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
};

test('pty-env: the six terminal identity values are defined once, frozen, with the values main.js had', () => {
  assert.deepEqual({ ...TERMINAL_IDENTITY_ENV }, SIX);
  assert.equal(Object.keys(TERMINAL_IDENTITY_ENV).length, 6);
  assert.equal(Object.isFrozen(TERMINAL_IDENTITY_ENV), true, 'one definition that no site can change');
  // A site spreads it into an object of its own, and may add to that.
  const site = { ...TERMINAL_IDENTITY_ENV };
  site.CLAUDE_CODE_SSE_PORT = '4001';
  assert.equal('CLAUDE_CODE_SSE_PORT' in TERMINAL_IDENTITY_ENV, false);
});

test('pty-env: statsPtyEnv exempts only /stats and keeps the base env', () => {
  const env = statsPtyEnv({ A: '1' });
  assert.equal(env.A, '1');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.MSYS2_ARG_CONV_EXCL, '/stats');
  assert.equal('MSYS_NO_PATHCONV' in env, false, 'the wide switch is not set');
  assert.deepEqual(env, { A: '1', ...SIX, MSYS2_ARG_CONV_EXCL: '/stats' }, 'the base, the six values, the one exemption, nothing else');

  // A value the base already has is kept, and /stats is added to it.
  assert.equal(statsPtyEnv({ MSYS2_ARG_CONV_EXCL: '/foo' }).MSYS2_ARG_CONV_EXCL, '/foo;/stats');
  // An empty value counts as none.
  assert.equal(statsPtyEnv({ MSYS2_ARG_CONV_EXCL: '' }).MSYS2_ARG_CONV_EXCL, '/stats');
});

test('pty-env: statsPtyEnv gives a new object, leaves the base as it was, and the six values win over the base\'s own', () => {
  const base = { PATH: 'C:\\fake\\bin', TERM: 'dumb', COLORTERM: 'no', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '0', FORCE_COLOR: '0', ITERM_SESSION_ID: 'inherited', MSYS2_ARG_CONV_EXCL: '/foo' };
  const before = { ...base };
  const env = statsPtyEnv(base);
  assert.notEqual(env, base);
  assert.deepEqual(base, before, 'the base, which every terminal shares, is not written to');
  assert.deepEqual(env, { PATH: 'C:\\fake\\bin', ...SIX, MSYS2_ARG_CONV_EXCL: '/foo;/stats' });
  // Two calls do not share an object.
  assert.notEqual(statsPtyEnv(base), env);
});

test('pty-env: Git Bash hands /stats to a native program unchanged and still converts other paths (Windows with Git Bash only, otherwise skipped)', (t) => {
  if (process.platform !== 'win32') return t.skip('not Windows');
  // Git Bash's own bash.exe by its full path, found the way shell-profiles.js finds it.
  // Never bare "bash": on Windows that can be the WSL launcher.
  const bash = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].find((p) => p && fs.existsSync(p));
  if (!bash) return t.skip('Git Bash is not installed');

  // A native program (this node) prints the two arguments bash handed it.
  const node = process.execPath.split(path.sep).join('/');
  const command = `"${node}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" /stats /c/Users`;
  // The base: this process's environment without either switch, so the control run is a true one.
  const base = { ...process.env };
  delete base.MSYS_NO_PATHCONV;
  delete base.MSYS2_ARG_CONV_EXCL;
  const argsWith = (env) => {
    const run = spawnSync(bash, ['-c', command], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, 'bash ran: ' + (run.error ? run.error.message : run.stderr));
    return JSON.parse(run.stdout);
  };

  // Control: without the exemption Git Bash rewrites /stats. If it does not on
  // this machine, the run below would prove nothing, so skip instead of passing blind.
  const control = argsWith(base);
  if (control[0] === '/stats') return t.skip('this Git Bash does not rewrite /stats: ' + JSON.stringify(control));
  assert.match(control[0], /^[A-Za-z]:[\\/].*[\\/]stats$/, 'the control run got a Windows path for /stats');

  const fixed = argsWith(statsPtyEnv(base));
  assert.equal(fixed[0], '/stats', 'with the exemption the argument arrives as written');
  assert.equal(fixed[1], control[1], 'another path is converted exactly as without it');
  assert.match(fixed[1], /^[A-Za-z]:[\\/]Users$/, '/c/Users is still converted to a Windows path');
});

test('pty-env: main.js names none of the six identity values itself: the two terminal sites spread TERMINAL_IDENTITY_ENV after the base, and stats-refresh is required as before', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const count = (needle) => main.split(needle).length - 1;

  // None of the six is a key of an environment object in main.js.
  for (const key of ['TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ITERM_SESSION_ID']) {
    assert.equal(new RegExp('(^|[^A-Za-z0-9_])' + key + '\\s*:', 'm').test(main), false, key + ' is written as a key in main.js');
  }
  // FORCE_COLOR is left once, with another value, for a child that is not a
  // terminal: the schedule runner's process.
  const forceColorLines = main.split(/\r?\n/).filter((line) => /(^|[^A-Za-z0-9_])FORCE_COLOR\s*:/.test(line));
  assert.deepEqual(forceColorLines.map((line) => line.trim()), ["env: { ...cleanPtyEnv, FORCE_COLOR: '0' },"]);
  // Nor are their values written there. The pty option name: 'xterm-256color' is a different thing and stays.
  for (const value of ["'truecolor'", 'iTerm.app', "'3.6.6'"]) assert.equal(count(value), 0, value + ' is written in main.js');
  assert.equal(count('xterm-256color'), count("name: 'xterm-256color'"), "'xterm-256color' is in main.js only as the pty option name");

  // One require, with exactly these names.
  assert.equal(count("const { buildPtyEnv, TERMINAL_IDENTITY_ENV, statsPtyEnv } = require('./pty-env');"), 1);
  // The plain and the Claude site: both inside the open-terminal handler, each
  // with the values AFTER the base, so they win over what the base holds.
  const open = cut('main.js', '// --- IPC: open-terminal ---', "ipcMain.handle('get-window-info', (event) => {");
  assert.equal((open.match(/\.\.\.cleanPtyEnv,\s*\.\.\.TERMINAL_IDENTITY_ENV,/g) || []).length, 2);
  assert.equal(count('...TERMINAL_IDENTITY_ENV'), 2, 'spread at those two sites and nowhere else in main.js');
  // The Claude site is still an object named ptyEnv (the /clear work adds a key to it).
  assert.match(open, /const ptyEnv = \{\s*\.\.\.cleanPtyEnv,\s*\.\.\.TERMINAL_IDENTITY_ENV,/);

  // stats-refresh.js is not part of this: its require stands where it stood, above the reloader line.
  const statsRequire = main.indexOf("const { runStatsCommand, refreshStatsCache } = require('./stats-refresh');");
  assert.ok(statsRequire !== -1, 'the stats-refresh require is unchanged');
  assert.ok(statsRequire < main.indexOf("require('electron-reloader')"), 'and still above the reloader line');
  assert.equal(fs.readFileSync(path.join(ROOT, 'stats-refresh.js'), 'utf8').includes('statsPtyEnv'), false, 'stats-refresh.js does not hold the environment');
});

test('pty-env: statsPtyEnv with a base that already steers the path conversion: MSYS_NO_PATHCONV is passed on as it is, and /stats is added to whatever MSYS2_ARG_CONV_EXCL holds', () => {
  // The wide switch, when the base has it, is the user's own: passed on as it is, neither removed nor changed.
  const wide = { PATH: 'C:\\fake\\bin', MSYS_NO_PATHCONV: '1' };
  assert.deepEqual(statsPtyEnv(wide), { PATH: 'C:\\fake\\bin', MSYS_NO_PATHCONV: '1', ...SIX, MSYS2_ARG_CONV_EXCL: '/stats' });
  assert.deepEqual(wide, { PATH: 'C:\\fake\\bin', MSYS_NO_PATHCONV: '1' }, 'the base is not written to');

  // '*' (exempt everything) and a list that already names /stats: the same one rule, the value plus ';/stats'.
  for (const [had, gives] of [['*', '*;/stats'], ['/stats', '/stats;/stats'], ['/foo;/stats', '/foo;/stats;/stats']]) {
    const base = { MSYS2_ARG_CONV_EXCL: had };
    assert.deepEqual(statsPtyEnv(base), { ...SIX, MSYS2_ARG_CONV_EXCL: gives }, had);
    assert.deepEqual(base, { MSYS2_ARG_CONV_EXCL: had }, had + ': the base is not written to');
  }
});

test('pty-env: an inherited SWITCHBOARD_TERMINAL_ID is stripped', () => {
  // A Switchboard started from inside a Switchboard terminal must not hand its parent's tag to every terminal.
  const inherited = { PATH: '/usr/bin', SWITCHBOARD_TERMINAL_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  assert.deepEqual(buildPtyEnv(inherited, 'linux'), { PATH: '/usr/bin' });
  assert.ok(CLAUDE_SESSION_VARS.includes('SWITCHBOARD_TERMINAL_ID'));
  // The Stats run is built from the stripped base, so it carries no tag either.
  // (statsPtyEnv is the name task 11 declared at the top of this file; it is not declared again.)
  assert.equal('SWITCHBOARD_TERMINAL_ID' in statsPtyEnv(buildPtyEnv(inherited, 'linux')), false);
});
