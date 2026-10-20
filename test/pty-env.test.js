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

test('pty-env: an inherited SWITCHBOARD_HOT_RELOAD is stripped', () => {
  // A Switchboard started from a terminal of a hot-reload instance must not turn hot reload on by inheritance.
  const inherited = { PATH: '/usr/bin', SWITCHBOARD_HOT_RELOAD: '1' };
  assert.deepEqual(buildPtyEnv(inherited, 'linux'), { PATH: '/usr/bin' });
  assert.ok(CLAUDE_SESSION_VARS.includes('SWITCHBOARD_HOT_RELOAD'));
  assert.equal('SWITCHBOARD_HOT_RELOAD' in statsPtyEnv(buildPtyEnv(inherited, 'linux')), false);
});

// --- launch without Git Bash: the Windows fill-ins (task L) ---

const ptyEnvModule = require('../pty-env');

const GIT = { root: 'C:\\Program Files\\Git', bash: 'C:\\Program Files\\Git\\bin\\bash.exe' };
const FACTS = { git: GIT, locale: 'en_US.UTF-8', intl: 'en-US', ms: 5 };
const WIN_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\nodejs';

test('pty-env: with facts null, win32, darwin and linux give what they give without the parameter, two PATH keys included', () => {
  const sources = [
    { PATH: '/usr/bin' },
    { Path: WIN_PATH, PATH: 'C:\\other', USERPROFILE: 'C:\\Users\\u' },
    { LANG: '' },
  ];
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const source of sources) {
      assert.deepEqual(buildPtyEnv(source, platform, null), buildPtyEnv(source, platform), `${platform} ${JSON.stringify(source)}`);
    }
  }
  assert.deepEqual(buildPtyEnv({ Path: WIN_PATH, PATH: 'C:\\other' }, 'win32', null), { Path: WIN_PATH, PATH: 'C:\\other' });
});

test('pty-env: LANG is filled on win32 only when LANG, LC_ALL and LC_CTYPE are all unset, from locale.exe, else Intl, else C.UTF-8', () => {
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', FACTS).LANG, 'en_US.UTF-8');
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', { ...FACTS, locale: 'C.UTF-8' }).LANG, 'C.UTF-8');
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', { ...FACTS, locale: 'garbage', intl: 'de-DE' }).LANG, 'de_DE.UTF-8');
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', { ...FACTS, locale: null, intl: 'de-DE' }).LANG, 'de_DE.UTF-8');
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', { ...FACTS, locale: null, intl: 'und' }).LANG, 'C.UTF-8');
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', { ...FACTS, locale: null, intl: null }).LANG, 'C.UTF-8');
  for (const inherited of [{ LANG: 'de_DE.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8' }, { LC_CTYPE: 'fr_FR.UTF-8' }, { lang: 'pt_BR.UTF-8' }]) {
    const env = buildPtyEnv({ Path: WIN_PATH, ...inherited }, 'win32', FACTS);
    for (const [k, v] of Object.entries(inherited)) assert.equal(env[k], v, `${k} kept`);
    const langKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'LANG');
    assert.deepEqual(langKeys, Object.keys(inherited).filter((k) => k.toUpperCase() === 'LANG'), `no LANG added beside ${JSON.stringify(inherited)}`);
  }
});

test('pty-env: CLAUDE_CODE_GIT_BASH_PATH is filled on win32 with Git\'s bin\\bash.exe only when unset', () => {
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', FACTS).CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(buildPtyEnv({ Path: WIN_PATH, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\mine\\bash.exe' }, 'win32', FACTS).CLAUDE_CODE_GIT_BASH_PATH, 'D:\\mine\\bash.exe');
  const lower = buildPtyEnv({ Path: WIN_PATH, claude_code_git_bash_path: 'D:\\mine\\bash.exe' }, 'win32', FACTS);
  assert.equal(lower.claude_code_git_bash_path, 'D:\\mine\\bash.exe');
  assert.equal('CLAUDE_CODE_GIT_BASH_PATH' in lower, false, 'unset is checked case-insensitively');
});

test('pty-env: MSYSTEM is filled on win32 with MINGW64 only when unset', () => {
  assert.equal(buildPtyEnv({ Path: WIN_PATH }, 'win32', FACTS).MSYSTEM, 'MINGW64');
  assert.equal(buildPtyEnv({ Path: WIN_PATH, MSYSTEM: 'UCRT64' }, 'win32', FACTS).MSYSTEM, 'UCRT64');
});

test('pty-env: HOME is filled on win32 with the env\'s USERPROFILE only when unset', () => {
  assert.equal(buildPtyEnv({ Path: WIN_PATH, USERPROFILE: 'C:\\Users\\u' }, 'win32', FACTS).HOME, 'C:\\Users\\u');
  assert.equal(buildPtyEnv({ Path: WIN_PATH, USERPROFILE: 'C:\\Users\\u', HOME: 'H:\\' }, 'win32', FACTS).HOME, 'H:\\');
  const lower = buildPtyEnv({ Path: WIN_PATH, USERPROFILE: 'C:\\Users\\u', home: 'H:\\' }, 'win32', FACTS);
  assert.equal(lower.home, 'H:\\');
  assert.equal('HOME' in lower, false, 'unset is checked case-insensitively');
});

test('pty-env: PATH under Path: Git\'s cmd and bin go right before System32, a later Git\\cmd is moved, the end entries come once, and a second run adds nothing', () => {
  const source = { Path: 'C:\\nodejs;C:\\WINDOWS\\system32\\;C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\usr\\bin' };
  const env = buildPtyEnv(source, 'win32', FACTS);
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'), ['Path'], 'edited under its own key');
  assert.equal(env.Path, [
    'C:\\nodejs',
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\WINDOWS\\system32\\',
    'C:\\Windows',
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files\\Git\\mingw64\\bin',
  ].join(';'));
  assert.deepEqual(buildPtyEnv(env, 'win32', FACTS), env, 'a second run adds nothing');
});

test('pty-env: PATH with Git\\cmd both before and after System32 keeps one copy of it, before System32', () => {
  const env = buildPtyEnv({ Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\b' }, 'win32', FACTS);
  assert.equal(env.Path.split(';').filter((e) => e === 'C:\\Program Files\\Git\\cmd').length, 1, env.Path);
  assert.equal(env.Path, 'C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;C:\\Windows\\System32;C:\\b;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin');
  assert.deepEqual(buildPtyEnv(env, 'win32', FACTS), env, 'a second run adds nothing');
});

test('pty-env: with facts on win32, a source holding Path and PATH gives one key, the later one\'s value, edited', () => {
  const env = buildPtyEnv({ Path: 'C:\\old', PATH: 'C:\\nodejs;C:\\Windows\\System32' }, 'win32', FACTS);
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(env.PATH, 'C:\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;C:\\Windows\\System32;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin');
});

test('pty-env: with no System32 entry, Git\'s cmd and bin go to the front of PATH', () => {
  const env = buildPtyEnv({ Path: 'C:\\nodejs;C:\\tools' }, 'win32', FACTS);
  assert.equal(env.Path, 'C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;C:\\nodejs;C:\\tools;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin');
});

test('pty-env: without Git on win32 only LANG and HOME are filled', () => {
  const source = { Path: WIN_PATH, USERPROFILE: 'C:\\Users\\u' };
  const env = buildPtyEnv(source, 'win32', { git: null, locale: null, intl: 'en-GB', ms: 0 });
  assert.deepEqual(env, { Path: WIN_PATH, USERPROFILE: 'C:\\Users\\u', LANG: 'en_GB.UTF-8', HOME: 'C:\\Users\\u' });
});

test('pty-env: langFromLocaleTag turns a plain language-region tag into xx_YY.UTF-8 and refuses the rest', () => {
  const { langFromLocaleTag } = ptyEnvModule;
  assert.equal(langFromLocaleTag('en-US'), 'en_US.UTF-8');
  assert.equal(langFromLocaleTag('zh-Hans-CN'), null);
  assert.equal(langFromLocaleTag('sr-Latn-RS'), null);
  assert.equal(langFromLocaleTag('es-419'), null);
  assert.equal(langFromLocaleTag('en'), 'en.UTF-8');
  assert.equal(langFromLocaleTag('und'), null);
  assert.equal(langFromLocaleTag('en-US-u-hc-h23'), 'en_US.UTF-8');
});

test('pty-env: with facts off win32 nothing is filled', () => {
  for (const platform of ['darwin', 'linux']) {
    const source = { PATH: '/usr/bin', Path: '/x', USERPROFILE: '/home/u' };
    assert.deepEqual(buildPtyEnv(source, platform, FACTS), buildPtyEnv(source, platform), platform);
  }
  assert.deepEqual(buildPtyEnv({ PATH: '/usr/bin' }, 'linux', FACTS), { PATH: '/usr/bin' });
});
