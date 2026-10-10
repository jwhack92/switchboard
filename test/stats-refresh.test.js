const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runStatsCommand, refreshStatsCache } = require('../stats-refresh');

function ptyFixture(t, { writeError = false, timeoutMs = 10000 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let onData, onExit, killed = 0;
  const writes = [];
  const result = runStatsCommand({
    spawn: () => ({
      write(value) {
        if (writeError) throw new Error('closed');
        writes.push(value);
      },
      kill() { killed++; },
      onData(fn) { onData = fn; return { dispose() {} }; },
      onExit(fn) { onExit = fn; return { dispose() {} }; },
    }),
    shell: '/bin/sh', args: ['-c', 'claude "/stats"'], options: {}, timeoutMs,
  });
  return { result, writes, data: value => onData(value), exit: code => onExit({ exitCode: code }), kills: () => killed };
}

// Includes the absolute-column escape sequences emitted by Claude 2.1.263.
const noSelected = '\x1b[2GAccessing workspace:\r\n/fake-home\r\n'
  + '\x1b[2G❯\x1b[4GNo,\x1b[8Gexit\r\n'
  + '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n';
const yesSelected = '\x1b[1D\x1b[4B\r\x1b[1C\x1b[4A No, exit\r'
  + '\x1b[1C\x1b[1B\x1b[38;2;153;204;255m❯\x1b[4GYes, I trust this folder\x1b[39m\r\n';

test('moves Down from No and only confirms after a fragmented Yes redraw', async t => {
  const p = ptyFixture(t);
  for (const byte of noSelected) p.data(byte);
  t.mock.timers.tick(1000);
  assert.deepEqual(p.writes, ['\x1b[B']);
  // Old accumulated output or unrelated chunks must not trigger Enter.
  p.data('\x1b[?2026h');
  t.mock.timers.tick(1000);
  assert.deepEqual(p.writes, ['\x1b[B']);
  for (const byte of yesSelected) p.data(byte);
  t.mock.timers.tick(100);
  assert.deepEqual(p.writes, ['\x1b[B', '\r']);
  p.data('Current\x1b[43Gstreak: 2 days');
  assert.deepEqual(await p.result, { error: null });
  t.mock.timers.tick(20000);
  assert.equal(p.kills(), 1);
  assert.equal(p.writes.length, 2);
});

test('preserves older numbered prompts that already highlight Yes', async t => {
  const p = ptyFixture(t);
  p.data('Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n');
  t.mock.timers.tick(1000);
  assert.deepEqual(p.writes, ['\r']);
  p.data('Longest streak: 5 days');
  assert.equal((await p.result).error, null);
});

test('an already trusted directory requires no keyboard input', async t => {
  const p = ptyFixture(t);
  p.data('Loading stats...\nCurrent streak: 2 days');
  assert.equal((await p.result).error, null);
  assert.deepEqual(p.writes, []);
});

test('does not accept a trust prompt whose selected option is unknown', async t => {
  const p = ptyFixture(t);
  p.data('Do you trust this folder?\nNo, exit\nYes, I trust this folder\n');
  t.mock.timers.tick(10000);
  assert.match((await p.result).error, /timed out/);
  assert.deepEqual(p.writes, []);
});

test('times out instead of confirming when Down never produces a Yes selection', async t => {
  const p = ptyFixture(t);
  p.data(noSelected);
  t.mock.timers.tick(1000);
  p.data(noSelected);
  t.mock.timers.tick(9000);
  assert.match((await p.result).error, /timed out/);
  assert.deepEqual(p.writes, ['\x1b[B']);
});

for (const exitCode of [0, 1, 127]) {
  test(`exit ${exitCode} before stats output fails and cancels pending trust input`, async t => {
    const p = ptyFixture(t);
    p.data(noSelected);
    p.exit(exitCode);
    assert.match((await p.result).error, /exited/);
    t.mock.timers.tick(20000);
    p.data(yesSelected);
    assert.deepEqual(p.writes, []);
    assert.equal(p.kills(), 1);
  });
}

test('reports a failed PTY write and stops the process', async t => {
  const p = ptyFixture(t, { writeError: true });
  p.data(noSelected);
  t.mock.timers.tick(1000);
  assert.match((await p.result).error, /trust prompt/);
  assert.equal(p.kills(), 1);
});

test('reports a failed spawn', async () => {
  const result = await runStatsCommand({ spawn() { throw new Error('ENOENT'); } });
  assert.match(result.error, /Could not start/);
});

function cacheFixture(t, date = '2026-08-20') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stats-cache.json');
  function write(lastComputedDate) {
    fs.writeFileSync(file, JSON.stringify({ lastComputedDate, totalSessions: 1 }));
  }
  if (date) write(date);
  return { file, write, now: () => new Date('2026-09-07T04:00:00Z') };
}

test('reports a completed command that leaves an old cache unchanged', async t => {
  const c = cacheFixture(t);
  const result = await refreshStatsCache(c.file, async () => ({ error: null }), c.now);
  assert.match(result.statsError, /did not advance/);
  assert.equal(result.stats.lastComputedDate, '2026-08-20');
});

test('accepts a cache date advancing even when the filesystem timestamp is unchanged', async t => {
  const c = cacheFixture(t);
  fs.utimesSync(c.file, 1000, 1000);
  const result = await refreshStatsCache(c.file, async () => {
    c.write('2026-09-06');
    fs.utimesSync(c.file, 1000, 1000);
    return { error: null };
  }, c.now);
  assert.equal(result.statsError, null);
  assert.equal(result.stats.lastComputedDate, '2026-09-06');
});

test('an unchanged cache through yesterday is normal on a repeat refresh', async t => {
  const c = cacheFixture(t, '2026-09-06');
  const result = await refreshStatsCache(c.file, async () => ({ error: null }), c.now);
  assert.equal(result.statsError, null);
});

test('a current cache does not hide a failed command', async t => {
  const c = cacheFixture(t, '2026-09-06');
  const result = await refreshStatsCache(c.file, async () => ({ error: 'Stats refresh timed out.' }), c.now);
  assert.match(result.statsError, /timed out/);
  assert.equal(result.stats.lastComputedDate, '2026-09-06');
});

test('keeps the last readable cache when the refreshed file is invalid', async t => {
  const c = cacheFixture(t);
  const result = await refreshStatsCache(c.file, async () => {
    fs.writeFileSync(c.file, '{');
    return { error: null };
  }, c.now);
  assert.match(result.statsError, /readable cache/);
  assert.equal(result.stats.lastComputedDate, '2026-08-20');
});

test('reports a missing cache for a first-time user without discarding the error', async t => {
  const c = cacheFixture(t, null);
  const result = await refreshStatsCache(c.file, async () => ({ error: 'Claude exited before stats finished.' }), c.now);
  assert.match(result.statsError, /exited/);
  assert.equal(result.stats, null);
});

test('a first successful cache creation succeeds', async t => {
  const c = cacheFixture(t, null);
  const result = await refreshStatsCache(c.file, async () => {
    c.write('2026-09-06');
    return { error: null };
  }, c.now);
  assert.equal(result.statsError, null);
});

// --- The refresh-stats handler of main.js (pin, Phase 1b of the relaunch work) ---
//
// Everything above tests stats-refresh.js. This tests the block of main.js that
// calls it: the handler behind the Stats page's refresh. main.js cannot be
// loaded here, so the block is cut out by two marker comments and run in a vm
// against fakes (test-support/source-cut.js).
//
// It pins: one run at a time, the folder the hidden command runs in, the
// command, and the environment the command gets. The environment is checked
// key by key and never for keys that are NOT there, so the pin still holds
// when the small fix builds that environment in pty-env.js and adds to it.
const sourceCut = require('../test-support/source-cut');

const STATS_HOME = path.join(os.tmpdir(), 'sb-pin-stats-home'); // a name only; nothing is written there
const STATS_CACHE_FILE = path.join(STATS_HOME, '.claude', 'stats-cache.json');
const STATS_COMMAND = 'claude "/stats"';
const BASH_PROFILE = { path: 'C:\\fake\\Git\\bin\\bash.exe', args: ['--from-the-profile'] };
// The six values a terminal child is given so it draws as in a real terminal (main.js, refresh-stats block).
const SIX_TERMINAL_VALUES = {
  TERM: 'xterm-256color', COLORTERM: 'truecolor',
  TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6',
  FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
};

/**
 * Loads the refresh-stats block and returns its handler with everything the
 * fakes saw. The hidden command "runs" until the test settles it: runs[i].finish(outcome).
 */
function bootRefreshStats({ base = { PATH: 'C:\\fake\\bin' }, settings = { shellProfile: 'bash-profile' }, profile = BASH_PROFILE, usage = async () => ({ fiveHour: 12 }) } = {}) {
  const block = sourceCut.cut('main.js', '// --- IPC: refresh-stats', '// --- IPC: get-usage');
  const realShellArgs = sourceCut.realOrStandIn('./shell-profiles').shellArgs;
  const handlers = new Map();
  const seen = { cacheFiles: [], runs: [], settingKeys: [], profileIds: [], shellArgs: [], spawned: [], warns: [], usageCalls: 0, failNextCache: null };
  sourceCut.load(block, {
    file: 'main.js',
    globals: {
      // main.js takes its names from pty-env.js in one require near the top.
      // The block gets whatever that module exports, so a name the fix adds
      // there (statsPtyEnv) is the real one here and not a missing global.
      ...sourceCut.realOrStandIn('./pty-env', {}),
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      fetchAndTransformUsage: () => { seen.usageCalls++; return usage(); },
      refreshStatsCache: async (file, run) => {
        seen.cacheFiles.push(file);
        if (seen.failNextCache) { const error = seen.failNextCache; seen.failNextCache = null; throw error; }
        const outcome = await run();
        return { stats: { lastComputedDate: '2026-09-06' }, statsError: outcome.error };
      },
      runStatsCommand: (opts) => new Promise((resolve) => { seen.runs.push({ opts, finish: resolve }); }),
      STATS_CACHE_PATH: STATS_CACHE_FILE,
      getSetting: (key) => { seen.settingKeys.push(key); return settings; },
      SETTING_DEFAULTS: { shellProfile: 'the-default-profile' },
      resolveShell: (id) => { seen.profileIds.push(id); return profile; },
      shellArgs: (...args) => { seen.shellArgs.push(args); return realShellArgs(...args); },
      pty: { spawn: (...args) => { seen.spawned.push(args); return 'the pty'; } },
      os: { homedir: () => STATS_HOME },
      cleanPtyEnv: base,
      ...sourceCut.realOrStandIn('./launch-plan', {}),
      LAUNCH_HOST: { platform: 'linux', fs: null, gitBash: null },
      log: { warn: (...args) => seen.warns.push(args), info() {}, error() {}, debug() {} },
    },
  });
  const handler = handlers.get('refresh-stats');
  assert.equal(typeof handler, 'function', 'the block registers the refresh-stats handler');
  return { refresh: () => handler({}), seen, realShellArgs };
}

test('stats refresh wiring (pin): one run at a time; the home folder; the command; an environment holding the base plus the six terminal values', async t => {
  await t.test('one run at a time: a second request while one runs gets the same answer and starts nothing', async () => {
    const { refresh, seen } = bootRefreshStats();
    const first = refresh();
    const second = refresh();
    const third = refresh();
    assert.equal(seen.runs.length, 1, 'the command was started once');
    assert.equal(seen.cacheFiles.length, 1);
    assert.equal(seen.usageCalls, 1, 'the usage numbers were asked for once');

    seen.runs[0].finish({ error: null });
    const answers = await Promise.all([first, second, third]);
    assert.equal(seen.runs.length, 1, 'still once after it finished');
    assert.equal(answers[1], answers[0], 'the same answer, not a copy');
    assert.equal(answers[2], answers[0]);
    assert.equal(answers[0].statsError, null);

    // The run is over, so the next request starts a new one.
    const next = refresh();
    assert.equal(seen.runs.length, 2, 'a request after the run starts the command again');
    seen.runs[1].finish({ error: null });
    assert.notEqual(await next, answers[0]);
    assert.equal(seen.usageCalls, 2);
  });

  await t.test('one run at a time: a run that fails does not block the next one', async () => {
    const { refresh, seen } = bootRefreshStats();
    seen.failNextCache = new Error('the cache read broke');
    await assert.rejects(refresh(), (e) => e.message === 'the cache read broke');
    assert.equal(seen.runs.length, 0);

    const next = refresh();
    assert.equal(seen.runs.length, 1, 'the request after a failed run starts the command');
    seen.runs[0].finish({ error: null });
    assert.equal((await next).statsError, null);
  });

  await t.test('the home folder, the stats cache file and the size of the hidden terminal', async () => {
    const { refresh, seen } = bootRefreshStats();
    const pending = refresh();
    const { options } = seen.runs[0].opts;
    assert.equal(options.cwd, STATS_HOME, 'runs in the home folder');
    assert.equal(options.name, 'xterm-256color');
    assert.equal(options.cols, 120);
    assert.equal(options.rows, 40);
    assert.deepEqual(seen.cacheFiles, [STATS_CACHE_FILE], 'the cache that is checked is STATS_CACHE_PATH');
    seen.runs[0].finish({ error: null });
    await pending;
  });

  // PIN 26, subtest changed on purpose by launch without Git Bash. Formerly: "the command: claude "/stats" through the shell profile of the settings, started with the pty".
  await t.test('the command: off Windows, claude "/stats" through the shell profile of the settings, as launch-plan.js builds it, started with the pty', async () => {
    const { refresh, seen, realShellArgs } = bootRefreshStats();
    const pending = refresh();
    const { opts } = seen.runs[0];

    assert.deepEqual(seen.settingKeys, ['global']);
    assert.deepEqual(seen.profileIds, ['bash-profile'], 'the shell profile chosen in the settings');
    assert.equal(opts.shell, BASH_PROFILE.path);
    assert.deepEqual([...opts.args], realShellArgs(BASH_PROFILE.path, STATS_COMMAND, BASH_PROFILE.args));
    assert.equal([...opts.args].filter((arg) => arg === STATS_COMMAND).length, 1, 'the command is one argument, as written');

    // spawn hands its arguments to the pty untouched and gives back what the pty gave.
    const spawnOptions = { cwd: STATS_HOME };
    assert.equal(opts.spawn('a-shell', ['-c', 'x'], spawnOptions), 'the pty');
    assert.equal(seen.spawned.length, 1);
    assert.equal(seen.spawned[0][0], 'a-shell');
    assert.deepEqual(seen.spawned[0][1], ['-c', 'x']);
    assert.equal(seen.spawned[0][2], spawnOptions);

    seen.runs[0].finish({ error: null });
    await pending;
  });

  // PIN 26, subtest changed on purpose by launch without Git Bash. Formerly: "the command: without saved settings the default profile is used, and a profile without arguments gives none".
  await t.test('the command: off Windows, without saved settings the default profile is used, and a profile without arguments gives none', async () => {
    for (const settings of [null, {}]) {
      const { refresh, seen } = bootRefreshStats({ settings, profile: { path: BASH_PROFILE.path } });
      const pending = refresh();
      assert.deepEqual(seen.profileIds, ['the-default-profile'], JSON.stringify(settings));
      assert.equal([...seen.runs[0].opts.args].at(-1), STATS_COMMAND);
      assert.deepEqual([...seen.runs[0].opts.args], sourceCut.realOrStandIn('./shell-profiles').shellArgs(BASH_PROFILE.path, STATS_COMMAND, []));
      seen.runs[0].finish({ error: null });
      await pending;
    }
  });

  await t.test('the environment holds the whole base and the six terminal values', async () => {
    // Names the base environment keeps: none that pty-env.js strips.
    const base = { PATH: 'C:\\fake\\bin;C:\\fake\\Git\\cmd', USERPROFILE: STATS_HOME, SB_PIN_BASE_VALUE: 'kept as it is', EMPTY_IN_BASE: '' };
    const before = { ...base };
    const { refresh, seen } = bootRefreshStats({ base });
    const pending = refresh();
    const { env } = seen.runs[0].opts.options;

    for (const [key, value] of Object.entries(before)) assert.equal(env[key], value, `base value ${key}`);
    for (const [key, value] of Object.entries(SIX_TERMINAL_VALUES)) assert.equal(env[key], value, `terminal value ${key}`);
    // No check that other keys are absent: the fix may add to this environment.

    assert.notEqual(env, base, 'the command gets its own object');
    assert.deepEqual(base, before, 'the base environment, which every terminal shares, is left as it was');
    seen.runs[0].finish({ error: null });
    await pending;
  });

  await t.test('the six terminal values win over what the base holds under the same names', async () => {
    const base = { PATH: 'C:\\fake\\bin', TERM: 'dumb', COLORTERM: 'no', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '0', FORCE_COLOR: '0', ITERM_SESSION_ID: 'inherited' };
    const { refresh, seen } = bootRefreshStats({ base });
    const pending = refresh();
    const { env } = seen.runs[0].opts.options;
    for (const [key, value] of Object.entries(SIX_TERMINAL_VALUES)) assert.equal(env[key], value, key);
    assert.equal(env.PATH, 'C:\\fake\\bin');
    assert.equal(base.TERM, 'dumb', 'the base is not written to');
    seen.runs[0].finish({ error: null });
    await pending;
  });

  await t.test('the answer: what the cache check gave, plus the usage numbers; a failed usage read gives an empty object', async () => {
    const usage = { fiveHour: 12 };
    const ok = bootRefreshStats({ usage: async () => usage });
    const pending = ok.refresh();
    ok.seen.runs[0].finish({ error: 'Stats refresh timed out.' });
    const answer = await pending;
    assert.equal(answer.statsError, 'Stats refresh timed out.');
    assert.equal(answer.stats.lastComputedDate, '2026-09-06');
    assert.equal(answer.usage, usage);
    assert.equal(ok.seen.warns.length, 1, 'a stats error is logged once as a warning');

    const noUsage = bootRefreshStats({ usage: async () => { throw new Error('offline'); } });
    const pendingNoUsage = noUsage.refresh();
    noUsage.seen.runs[0].finish({ error: null });
    const answerNoUsage = await pendingNoUsage;
    assert.equal(answerNoUsage.statsError, null);
    assert.deepEqual(Object.keys(answerNoUsage.usage), []);
    assert.equal(noUsage.seen.warns.length, 0);
  });
});

test('stats-refresh: the refresh-stats handler uses statsPtyEnv (wiring only)', async () => {
  // What the VALUE is, test/pty-env.test.js proves. This proves main.js uses it.
  const block = sourceCut.cut('main.js', '// --- IPC: refresh-stats', '// --- IPC: get-usage');
  assert.ok(block.includes('env: statsPtyEnv(cleanPtyEnv),'), 'the handler asks pty-env.js for its environment');
  assert.equal(block.includes('...cleanPtyEnv'), false, 'and builds no environment of its own');
  assert.ok(block.includes('// NOTE (not verified): accepting the trust prompt writes a persistent decision into'), 'the trust note says it was not verified');

  // Through the block itself: the hidden command gets the base, the six values and the one exemption.
  const { refresh, seen } = bootRefreshStats({ base: { PATH: 'C:\\fake\\bin' } });
  const pending = refresh();
  const { env } = seen.runs[0].opts.options;
  assert.deepEqual({ ...env }, { PATH: 'C:\\fake\\bin', ...SIX_TERMINAL_VALUES, MSYS2_ARG_CONV_EXCL: '/stats' });
  assert.equal('MSYS_NO_PATHCONV' in env, false);
  seen.runs[0].finish({ error: null });
  await pending;

  // A base that already exempts something keeps it.
  const kept = bootRefreshStats({ base: { MSYS2_ARG_CONV_EXCL: '/foo' } });
  const keptPending = kept.refresh();
  assert.equal(kept.seen.runs[0].opts.options.env.MSYS2_ARG_CONV_EXCL, '/foo;/stats');
  kept.seen.runs[0].finish({ error: null });
  await keptPending;
});

test('stats-refresh: on Windows the Stats run starts claude.exe directly with "/stats" and the same environment; a missing claude answers an error without a run', async () => {
  const launchPlan = require('../launch-plan');
  const { statsPtyEnv } = require('../pty-env');
  const CLAUDE_EXE = 'C:\\bin\\claude.exe';
  const base = { Path: 'C:\\bin;C:\\Windows\\System32' };
  // Its own small loader of the same cut, with a Windows host.
  const bootOnWindows = (files) => {
    const block = sourceCut.cut('main.js', '// --- IPC: refresh-stats', '// --- IPC: get-usage');
    const handlers = new Map();
    const runs = [];
    const infos = [];
    sourceCut.load(block, {
      file: 'main.js',
      globals: {
        ...require('../pty-env'),
        ...launchPlan,
        LAUNCH_HOST: {
          platform: 'win32',
          fs: { existsSync: (p) => files.includes(p), lstatSync: () => undefined },
          gitBash: null,
        },
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
        fetchAndTransformUsage: async () => ({}),
        refreshStatsCache: async (file, run) => ({ stats: null, statsError: (await run()).error }),
        runStatsCommand: (opts) => { runs.push(opts); return Promise.resolve({ error: null }); },
        STATS_CACHE_PATH: STATS_CACHE_FILE,
        getSetting: () => ({ shellProfile: 'auto' }),
        SETTING_DEFAULTS: { shellProfile: 'auto' },
        resolveShell: () => ({ id: 'auto', name: 'Auto', path: 'C:\\pwsh\\pwsh.exe', args: [] }),
        shellArgs: require('../shell-profiles').shellArgs,
        pty: { spawn: () => 'the pty' },
        os: { homedir: () => STATS_HOME },
        cleanPtyEnv: base,
        log: { warn() {}, info: (line) => infos.push(line), error() {}, debug() {} },
      },
    });
    return { refresh: () => handlers.get('refresh-stats')({}), runs, infos };
  };

  const found = bootOnWindows([CLAUDE_EXE]);
  const answer = await found.refresh();
  assert.equal(found.runs.length, 1);
  assert.equal(found.runs[0].shell, CLAUDE_EXE);
  assert.equal(found.runs[0].args, launchPlan.windowsCommandLine(['/stats']));
  assert.deepEqual({ ...found.runs[0].options.env }, statsPtyEnv(base), 'the environment is still statsPtyEnv of the base');
  assert.equal(answer.statsError, null);
  assert.ok(found.infos.includes('[launch] kind=stats how=direct file=' + CLAUDE_EXE), JSON.stringify(found.infos));

  const missing = bootOnWindows([]);
  const failed = await missing.refresh();
  assert.equal(missing.runs.length, 0, 'nothing is run');
  assert.equal(failed.statsError, "claude was not found on PATH (searched the app's PATH; a PATH set only in a shell profile is not read)");
  assert.ok(missing.infos.includes('[launch] kind=stats how=none reason=not-found'), JSON.stringify(missing.infos));
});
