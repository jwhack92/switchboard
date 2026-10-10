'use strict';
// Launch without Git Bash (task L): the three places of main.js that no other
// test cuts, run in a vm against fakes (test-support/source-cut.js): the
// scheduler's runScheduleCommand, the base environment of every child, and the
// get-shell-profiles handler. The launch rules themselves are launch-plan.js's
// and have their own tests (test/launch-plan.test.js); here main.js is held to
// asking them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { cut, load, peek } = require('../test-support/source-cut');
const launchPlan = require('../launch-plan');
const { shellArgs, quoteArgvForShell } = require('../shell-profiles');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const once = (marker) => assert.equal(MAIN.split(marker).length - 1, 1, 'the marker stands once in main.js: ' + marker);

const SCHEDULE_START = 'function runScheduleCommand(';
const SCHEDULE_END = '// --- Global stop, process custody, shared usage poll';
const ENV_START = "const { buildPtyEnv, TERMINAL_IDENTITY_ENV, statsPtyEnv } = require('./pty-env');";
const ENV_END = '// The pty guard: the one gate for every terminal write, resize and kill';
const PROFILES_START = "ipcMain.handle('get-shell-profiles', () => {";
const PROFILES_END = "ipcMain.handle('get-effective-settings', (_event, projectPath) => {";

const CLAUDE_EXE = 'C:\\bin\\claude.exe';
const CLAUDE_CMD = 'C:\\bin\\claude.cmd';
const PATH_ERROR = "claude was not found on PATH (searched the app's PATH; a PATH set only in a shell profile is not read)";

function fakeLog() {
  const lines = [];
  const at = (level) => (...args) => { lines.push(level + ' ' + args.map((a) => (a && a.message ? a.message : String(a))).join(' ')); };
  return { lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

/** A Windows file system that holds only the files named. */
const windowsFs = (...files) => ({
  existsSync: (p) => files.includes(p),
  lstatSync: (p) => (files.includes(p) ? { isSymbolicLink: () => false } : undefined),
});

/** The scheduler's function, loaded with exactly the names it is handed. */
function bootScheduler({ host, profile = { id: 'auto', path: 'C:\\pwsh\\pwsh.exe', args: [] }, halted = false, cleanPtyEnv = { Path: 'C:\\bin;C:\\Windows\\System32' } }) {
  once(SCHEDULE_START);
  once(SCHEDULE_END);
  const log = fakeLog();
  const spawns = [];
  const events = [];
  const registered = [];
  const context = load(cut('main.js', SCHEDULE_START, SCHEDULE_END), {
    file: 'main.js',
    globals: {
      getSetting: () => ({ shellProfile: 'auto' }),
      SETTING_DEFAULTS: { shellProfile: 'auto' },
      resolveShell: () => profile,
      driverStore: {
        isHalted: () => (halted ? { halted: true, reason: 'stop in force' } : { halted: false }),
        appendEvent: (...args) => events.push(args),
      },
      log,
      cpSpawn: (file, args, options) => {
        const child = { pid: 7000 + spawns.length, stderr: { on() {} }, on() {} };
        spawns.push({ file, args, options });
        return child;
      },
      custody: { register: (entry) => registered.push(entry), unregister() {}, killTree() {} },
      cleanPtyEnv,
      LAUNCH_HOST: host,
      planLaunch: launchPlan.planLaunch,
      launchLogLine: launchPlan.launchLogLine,
    },
  });
  let done = 0;
  const run = (argv = ['-p', 'the task'], name = 'nightly') => context.runScheduleCommand(argv, 'C:\\proj', name, () => { done++; });
  return { run, log, spawns, events, registered, done: () => done, cleanPtyEnv };
}

test('main-launch-wiring: the scheduler asks launch-plan.js; the HALT gate decides first, a missing claude starts nothing, and every child gets an array', async (t) => {
  await t.test('halted: nothing is spawned, onDone is called once, SPAWN_VETOED is appended', () => {
    const s = bootScheduler({ host: { platform: 'win32', fs: windowsFs(CLAUDE_EXE), gitBash: null }, halted: true });
    s.run();
    assert.equal(s.spawns.length, 0);
    assert.equal(s.done(), 1);
    assert.deepEqual(s.events.map((e) => e[0]), ['SPAWN_VETOED']);
  });

  await t.test('on Windows with claude not found: nothing is spawned, an error is logged, onDone is called once', () => {
    const s = bootScheduler({ host: { platform: 'win32', fs: windowsFs(), gitBash: null } });
    s.run();
    assert.equal(s.spawns.length, 0);
    assert.equal(s.done(), 1);
    const errors = s.log.lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 1, 'one error line');
    assert.ok(errors[0].includes(PATH_ERROR), errors[0]);
  });

  await t.test('halted AND claude not found: the veto is what is logged (the gate decides first)', () => {
    const s = bootScheduler({ host: { platform: 'win32', fs: windowsFs(), gitBash: null }, halted: true });
    s.run();
    assert.equal(s.spawns.length, 0);
    assert.equal(s.done(), 1);
    assert.deepEqual(s.events.map((e) => e[0]), ['SPAWN_VETOED']);
    assert.equal(s.log.lines.filter((line) => line.includes('VETOED')).length, 1);
    assert.equal(s.log.lines.filter((line) => line.includes(PATH_ERROR)).length, 0, 'the not-found branch did not run');
  });

  await t.test('on Windows with claude.exe: cpSpawn starts it directly with an array, custody with the needle claude, and the two log lines', () => {
    const s = bootScheduler({ host: { platform: 'win32', fs: windowsFs(CLAUDE_EXE), gitBash: null } });
    s.run(['-p', 'two words'], 'nightly');
    assert.equal(s.spawns.length, 1);
    const { file, args, options } = s.spawns[0];
    assert.equal(file, CLAUDE_EXE);
    assert.ok(Array.isArray(args), 'child_process is handed an array');
    assert.deepEqual([...args], ['-p', 'two words']);
    assert.deepEqual({ ...options.env }, { ...s.cleanPtyEnv, FORCE_COLOR: '0' });
    assert.equal(s.registered.length, 1);
    assert.equal(s.registered[0].cmdlineNeedle, 'claude');
    assert.ok(s.log.lines.includes('info [schedule] Running: ' + CLAUDE_EXE + ' -p two words'), s.log.lines.join('\n'));
    assert.ok(s.log.lines.some((line) => line.startsWith('info [launch] kind=schedule name=nightly how=direct file=' + CLAUDE_EXE)), s.log.lines.join('\n'));
    assert.equal(s.done(), 0, 'the run is still going');
  });

  await t.test('on Windows with only claude.cmd, a pwsh profile and no Git Bash: cpSpawn still gets an array', () => {
    const s = bootScheduler({ host: { platform: 'win32', fs: windowsFs(CLAUDE_CMD), gitBash: null }, profile: { id: 'pwsh', path: 'C:\\pwsh\\pwsh.exe', args: [] } });
    s.run();
    assert.equal(s.spawns.length, 1);
    assert.equal(s.spawns[0].file, 'C:\\pwsh\\pwsh.exe');
    assert.ok(Array.isArray(s.spawns[0].args), 'an array, so .join and child_process both hold');
  });

  await t.test('on linux: cpSpawn(shell, shellArgs(...)) as today', () => {
    const profile = { id: 'bash', path: '/bin/bash', args: [] };
    const s = bootScheduler({ host: { platform: 'linux', fs: null, gitBash: null }, profile, cleanPtyEnv: { PATH: '/usr/bin' } });
    const argv = ['-p', 'the task'];
    s.run(argv);
    assert.equal(s.spawns.length, 1);
    assert.equal(s.spawns[0].file, '/bin/bash');
    assert.deepEqual([...s.spawns[0].args], shellArgs('/bin/bash', 'claude ' + quoteArgvForShell('/bin/bash', argv), [], 'linux'));
  });
});

test('main-launch-wiring: the base environment of every child is buildPtyEnv(process.env, platform, windowsEnvFacts()), with one [launch-env] line when there are facts', () => {
  once(ENV_START);
  once(ENV_END);
  const block = cut('main.js', ENV_START, ENV_END);
  const boot = (facts) => {
    const env = { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\u' };
    const calls = { facts: 0, build: [] };
    const built = { LANG: 'en_US.UTF-8', Path: 'C:\\Windows\\System32' };
    const log = fakeLog();
    const modules = {
      './pty-env': {
        buildPtyEnv: (...args) => { calls.build.push(args); return built; },
        TERMINAL_IDENTITY_ENV: {},
        statsPtyEnv: () => ({}),
      },
      './shell-profiles': { windowsEnvFacts: () => { calls.facts++; return facts; } },
    };
    const context = load(block, {
      file: 'main.js',
      globals: {
        process: { platform: 'win32', env },
        // One load of its own, without the pty harness: its require hands the fakes.
        require: (name) => {
          assert.ok(Object.prototype.hasOwnProperty.call(modules, name), 'the block required ' + name);
          return modules[name];
        },
        log,
      },
    });
    return { env, calls, built, log, cleanPtyEnv: peek(context, 'cleanPtyEnv') };
  };

  const facts = { git: { root: 'C:\\Git', bash: 'C:\\Git\\bin\\bash.exe' }, locale: 'en_US.UTF-8', intl: 'en-US', ms: 42 };
  const withFacts = boot(facts);
  assert.equal(withFacts.calls.facts, 1, 'windowsEnvFacts is called once');
  assert.equal(withFacts.calls.build.length, 1);
  assert.equal(withFacts.calls.build[0][0], withFacts.env);
  assert.equal(withFacts.calls.build[0][1], 'win32');
  assert.equal(withFacts.calls.build[0][2], facts);
  assert.equal(withFacts.cleanPtyEnv, withFacts.built, 'cleanPtyEnv is what buildPtyEnv gave');
  const envLines = withFacts.log.lines.filter((line) => line.includes('[launch-env]'));
  assert.equal(envLines.length, 1);
  assert.match(envLines[0], /^info \[launch-env\] lang=en_US\.UTF-8 from=(git|intl|default) ms=42$/);

  const noFacts = boot(null);
  assert.equal(noFacts.calls.facts, 1);
  assert.equal(noFacts.calls.build[0][2], null);
  assert.equal(noFacts.log.lines.filter((line) => line.includes('[launch-env]')).length, 0, 'no line without facts');
});

test('main-launch-wiring: get-shell-profiles marks the profile Auto picks on Windows, and answers the profiles as they are elsewhere', async () => {
  once(PROFILES_START);
  once(PROFILES_END);
  const block = cut('main.js', PROFILES_START, PROFILES_END);
  const profiles = [
    { id: 'cmd', name: 'Command Prompt', path: 'C:\\Windows\\System32\\cmd.exe' },
    { id: 'powershell', name: 'Windows PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    { id: 'pwsh', name: 'PowerShell 7', path: 'C:\\pwsh\\pwsh.exe' },
  ];
  const boot = (platform) => {
    const handlers = new Map();
    load(block, {
      file: 'main.js',
      globals: {
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
        getShellProfiles: () => profiles,
        markAutoPick: launchPlan.markAutoPick,
        process: { platform, env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' } },
        _shellProfiles: 'a stale list',
      },
    });
    return handlers.get('get-shell-profiles');
  };

  const onWindows = await boot('win32')();
  assert.deepEqual(onWindows.filter((p) => p.autoPick).map((p) => p.id), ['pwsh'], 'pwsh is marked');
  assert.deepEqual(onWindows.map((p) => p.id), ['cmd', 'powershell', 'pwsh']);

  const onLinux = await boot('linux')();
  assert.deepEqual([...onLinux], profiles);
  assert.equal(onLinux.some((p) => p.autoPick), false);
});
