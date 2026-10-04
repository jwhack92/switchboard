'use strict';
// main.js as a whole, against a fake electron (review-safety S6 / K-S7).
//
// test/main-token-wiring.test.js cuts three blocks out of main.js and runs each
// in a vm with fakes for every free name. That proves the blocks' own logic. It
// cannot see a name that does not exist at that point of the real file, a
// channel registered twice somewhere else in main.js, or the other insertion
// points. This file loads the REAL main.js top to bottom and then runs the six
// places the token analytics touch it, in place:
//   1. the guarded require of ./token-usage (the real module, not the stand-in)
//   2. the eight token-stats IPC handlers
//   3. the read-ctx-state handler
//   4. the watcher line (tokenUsage.noteChanged)
//   5. the deferred init, 3 s after the app is ready
//   6. before-quit (shutdown) and will-quit (close)
//
// What it is NOT: Electron. No window, no IPC round trip, no preload, no PTY.
// Of everything main.js requires, only ./token-usage, a few pure Node built-ins
// and (behind a write guard) fs are real; every other module is one stand-in
// object that answers any call with itself. So a pass says the added lines and
// the names they use hold together, nothing about the rest of the app.
//
// Hermetic: the child gets its own home, LOCALAPPDATA, APPDATA and
// SWITCHBOARD_DATA_DIR inside one fresh folder under os.tmpdir() and refuses to
// run otherwise, so PROJECTS_DIR (os.homedir()/.claude/projects) is a fixture
// tree and the token store is a temp file. Any write main.js itself attempts
// outside that folder is refused and reported. The child is the Electron binary
// run as Node (better-sqlite3 is built for its ABI); the app is never started.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const MAIN = path.join(APP_DIR, 'main.js');
const SLUG = 'C--main-load-proj';
const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const TOKEN_CHANNELS = ['token-stats-summary', 'token-stats-models', 'token-stats-daily', 'token-stats-sessions',
  'token-stats-context', 'token-stats-rescan', 'token-stats-disable', 'token-stats-enable'];
const NEW_CHANNELS = TOKEN_CHANNELS.concat(['read-ctx-state']);

// c is p or below it.
function inside(c, p) {
  try {
    const child = path.resolve(String(c)).toLowerCase() + path.sep;
    return child.startsWith(path.resolve(String(p)).toLowerCase() + path.sep);
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- child ----

function childMain() {
  const Module = require('module');
  const ROOT = path.resolve(process.env.MAIN_LOAD_ROOT);
  const DATA = path.resolve(process.env.SWITCHBOARD_DATA_DIR || '');
  assert.ok(inside(ROOT, os.tmpdir()) && path.resolve(ROOT) !== path.resolve(os.tmpdir()), 'the root must be a folder under os.tmpdir(): ' + ROOT);
  for (const [name, value] of [['os.homedir()', os.homedir()], ['LOCALAPPDATA', process.env.LOCALAPPDATA],
    ['APPDATA', process.env.APPDATA], ['SWITCHBOARD_DATA_DIR', process.env.SWITCHBOARD_DATA_DIR]]) {
    assert.ok(value && inside(value, ROOT), 'refusing to load main.js: ' + name + ' is not inside the temp root (' + value + ')');
  }
  const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

  const out = { uncaught: [], blocked: [], dupes: [], tokenLogs: [] };
  const note = (kind, e) => { if (out.uncaught.length < 5) out.uncaught.push(kind + ': ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); };
  process.on('uncaughtException', (e) => note('uncaughtException', e));
  process.on('unhandledRejection', (e) => note('unhandledRejection', e));

  // One object that stands in for every module main.js requires and is not
  // named below: any property is the stub, any call returns the stub.
  const stub = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;                 // awaiting it resolves to it
      if (k === 'toString' || k === 'valueOf') return () => '';
      if (k === 'length' || k === 'size') return 0;
      if (k === 'prototype') return t.prototype;
      return stub;
    },
    apply() { return stub; },
    construct() { return stub; },
  });
  const withDefault = (obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : stub), set: (t, k, v) => { t[k] = v; return true; } });

  let readyResolve = null;
  const appHandlers = {};
  const handlers = new Map();
  const watchers = [];
  const electron = withDefault({
    app: withDefault({
      getPath: (n) => path.join(ROOT, 'appdata', String(n)),
      getVersion: () => '0.0.0-main-load',
      getAppPath: () => APP_DIR,
      isPackaged: false,
      setPath() {}, setAppUserModelId() {}, quit() {}, exit() {}, relaunch() {}, once() {},
      requestSingleInstanceLock: () => true,
      whenReady: () => new Promise((resolve) => { readyResolve = resolve; }),
      on: (ev, fn) => { appHandlers[ev] = fn; },
      commandLine: withDefault({}),
    }),
    ipcMain: withDefault({
      // As Electron: a second handler for a channel throws.
      handle(name, fn) {
        if (handlers.has(name)) { out.dupes.push(name); throw new Error("Attempted to register a second handler for '" + name + "'"); }
        handlers.set(name, fn);
      },
      on() {}, once() {}, removeHandler() {},
    }),
  });

  const fakeLog = withDefault({ transports: withDefault({ file: withDefault({}), console: withDefault({}) }) });
  for (const level of ['info', 'warn', 'error', 'debug', 'verbose', 'silly']) {
    fakeLog[level] = (...args) => {
      const line = args.map((x) => (x instanceof Error ? x.message : String(x))).join(' ');
      if (line.includes('[token-usage]') && out.tokenLogs.length < 40) out.tokenLogs.push(level + ': ' + line.slice(0, 200));
    };
  }

  // fs as main.js sees it: reads are real (they stay inside the fake home or
  // the checkout), watchers are captured, and a write outside ROOT is refused.
  const WRITERS = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync',
    'rmdirSync', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'rmdir', 'createWriteStream',
    'symlinkSync', 'symlink', 'truncateSync', 'truncate', 'utimesSync', 'utimes', 'chmodSync', 'chmod', 'mkdtempSync', 'mkdtemp']);
  const TWO_PATHS = new Set(['renameSync', 'rename', 'copyFileSync', 'copyFile']);
  const guardFs = (real) => new Proxy(real, {
    get(t, k) {
      const v = t[k];
      if (k === 'promises' && v && typeof v === 'object') return guardFs(v);
      if (typeof v !== 'function') return v;
      if (k === 'watch' || k === 'watchFile') {
        return (p, o, cb) => {
          const fn = typeof o === 'function' ? o : cb;
          watchers.push({ path: String(p), cb: typeof fn === 'function' ? fn : null });
          return { close() {}, on() {}, unref() {}, ref() {} };
        };
      }
      const isOpen = k === 'openSync' || k === 'open';
      if (!WRITERS.has(k) && !isOpen) return v.bind(t);
      return function guarded(p, flags) {
        const writes = !isOpen || (typeof flags === 'string' ? !/^rs?$/.test(flags) : typeof flags === 'number' ? (flags & 3) !== 0 : false);
        const target = TWO_PATHS.has(k) ? arguments[1] : p;
        if (writes && !inside(target, ROOT)) {
          if (out.blocked.length < 20) out.blocked.push(String(k) + ' ' + String(target));
          throw Object.assign(new Error('main-load test refused ' + String(k) + ' outside its temp root: ' + String(target)), { code: 'EACCES' });
        }
        return v.apply(t, arguments);
      };
    },
  });
  const guardedFs = guardFs(fs);

  // Kept for the life of the child: main.js also requires inside functions
  // (child_process, in whenReady), and that must be a stand-in too.
  const REAL_BUILTINS = new Set(['path', 'os', 'crypto', 'util', 'events', 'url', 'worker_threads', 'buffer', 'stream',
    'string_decoder', 'assert', 'zlib', 'querystring', 'timers']);
  const requested = [];
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    const fromMain = !!parent && typeof parent.filename === 'string' && path.resolve(parent.filename) === path.resolve(MAIN);
    if (!fromMain) return origLoad.apply(this, arguments);
    requested.push(request);
    const bare = request.replace(/^node:/, '');
    if (request === './token-usage') return origLoad.apply(this, arguments);     // the real one
    if (bare === 'fs') return guardedFs;
    if (bare === 'fs/promises') return guardedFs.promises;
    if (bare === 'electron') return electron;
    if (bare === 'electron-log') return fakeLog;
    if (bare === 'electron-reloader') return () => {};
    if (REAL_BUILTINS.has(bare)) return origLoad.apply(this, arguments);
    return stub;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (cond, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  };
  const call = async (name, ...args) => {
    const fn = handlers.get(name);
    if (typeof fn !== 'function') return { NO_HANDLER: name };
    try { return await fn({ sender: stub }, ...args); } catch (e) { return { THREW: String(e && e.message) }; }
  };
  const brief = (st) => ({ state: st.state, reason: st.reason, reasonCode: st.reasonCode, files: st.files, queryMode: st.queryMode,
    backfillDone: st.backfillDone });

  (async () => {
    // 1. Module scope, top to bottom.
    const t0 = Date.now();
    try { require(MAIN); } catch (e) { out.loadError = String((e && e.stack) || e).split('\n').slice(0, 6).join(' | '); }
    out.loadMs = Date.now() - t0;
    out.requires = requested.length;
    out.handlers = handlers.size;
    out.missingChannels = NEW_CHANNELS.filter((n) => !handlers.has(n));
    out.appEvents = Object.keys(appHandlers);
    out.readyHooked = typeof readyResolve === 'function';
    if (out.loadError || !out.readyHooked) return;

    // 2 and 3, before the store is initialised (the first 3 s of every launch).
    out.before = {
      summary: await call('token-stats-summary', {}),
      context: await call('token-stats-context', { sessionId: SID }),
      rescan: await call('token-stats-rescan'),
      enable: await call('token-stats-enable'),
      disable: await call('token-stats-disable'),
      ctxBad: await call('read-ctx-state', '..\\..\\x'),
      ctxNone: await call('read-ctx-state', SID),
    };

    // 5. The app becomes ready; main.js opens the store 3 s later.
    const tu = require(path.join(APP_DIR, 'token-usage.js'));
    out.sameModule = Object.keys(require.cache).filter((k) => /[\\/]token-usage\.js$/.test(k)).length === 1;
    readyResolve();
    const readyAt = Date.now();
    out.opened = !!(await until(() => tu.status().state === 'ok', 20000));
    out.initMs = Date.now() - readyAt;
    out.afterInit = brief(tu.status());
    const handle = tu._handle();
    out.handleInData = !!handle && inside(handle.name, DATA);
    if (!out.opened || !out.handleInData) return;

    // 4. The watcher callback main.js registered for the projects dir.
    const projectWatchers = watchers.filter((w) => w.cb && path.resolve(w.path) === path.resolve(PROJECTS));
    out.projectWatchers = projectWatchers.length;
    out.watcherThrew = null;
    for (const w of projectWatchers) {
      try {
        w.cb('change', SLUG + path.sep + SID + '.jsonl');
        w.cb('change', null);
        w.cb('rename', SLUG);
      } catch (e) {
        out.watcherThrew = String(e && e.message);
      }
    }
    // The file reaches the store through that callback: noteChanged, the 3 s
    // flush, the scan worker. No walk has run yet (the startup walk is 10 s
    // after init), which `backfillDone` still being null shows.
    const counted = await until(async () => {
      const s = await call('token-stats-summary', {});
      return s && s.totals && s.totals.responses === 2 ? s : null;
    }, 20000);
    const summary = counted || await call('token-stats-summary', {});
    out.summary = { error: summary.error, threw: summary.THREW, responses: summary.totals ? summary.totals.responses : null,
      output: summary.totals ? summary.totals.output : null, scan: summary.scan ? brief(summary.scan) : null };
    const sessions = await call('token-stats-sessions', {});
    const row = sessions && Array.isArray(sessions.rows) ? sessions.rows[0] : null;
    out.sessions = { error: sessions.error, threw: sessions.THREW, rows: sessions.rows ? sessions.rows.length : null,
      sessionId: row ? row.sessionId : null, projectPathType: row ? typeof row.projectPath : null, isRunning: row ? row.isRunning : null };

    // 6. Quit.
    out.quit = {};
    for (const ev of ['before-quit', 'will-quit']) {
      let threw = null;
      try { appHandlers[ev]({ preventDefault() {} }); } catch (e) { threw = String(e && e.message); }
      const st = tu.status();
      out.quit[ev] = { threw, state: st.state, reason: st.reason, handleOpen: !!tu._handle(), noteChanged: tu.noteChanged(SLUG + '/' + SID + '.jsonl') };
    }
    await sleep(50);      // anything the quit handlers left for the next turn
  })().catch((e) => { note('child', e); }).then(() => {
    fs.writeSync(1, '\nRESULT ' + JSON.stringify(out) + '\n');
    process.exit(0);
  });
}

// ------------------------------------------------------------------- parent ----

function parentMain() {
  const test = require('node:test');
  const { spawnSync } = require('child_process');
  const electronBin = require('electron');     // under plain node: the path to the binary

  let cached = null;
  function result() {
    if (cached) return cached;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-main-load-'));
    assert.ok(inside(root, os.tmpdir()));
    try {
      const home = path.join(root, 'home');
      const projects = path.join(home, '.claude', 'projects', SLUG);
      fs.mkdirSync(projects, { recursive: true });
      for (const dir of ['local', 'appdata', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
      // Two responses, a minute old, so they fall in the default range.
      const line = (id, output, ago) => JSON.stringify({
        type: 'assistant', sessionId: SID, timestamp: new Date(Date.now() - ago).toISOString(),
        message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 } },
      }) + '\n';
      fs.writeFileSync(path.join(projects, SID + '.jsonl'), line('msg_main_load_1', 11, 90000) + line('msg_main_load_2', 31, 60000));

      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', MAIN_LOAD_ROOT: root,
        USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'appdata'),
        SWITCHBOARD_DATA_DIR: path.join(root, 'data') };
      const r = spawnSync(electronBin, [__filename], { cwd: APP_DIR, env, encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, 'the child failed\n' + r.stderr + '\n' + r.stdout);
      const text = r.stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
      assert.ok(text, 'the child printed no result\n' + r.stdout + r.stderr);
      cached = JSON.parse(text.slice(7));
      cached.dataFiles = fs.readdirSync(path.join(root, 'data')).sort();
      return cached;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test('main.js evaluates top to bottom against a fake electron, and every new channel is registered exactly once', () => {
    const r = result();
    assert.equal(r.loadError, undefined, 'main.js threw at module scope: ' + r.loadError);
    assert.equal(r.readyHooked, true, 'main.js called app.whenReady()');
    assert.deepEqual(r.dupes, [], 'no channel is registered twice anywhere in main.js');
    assert.deepEqual(r.missingChannels, []);
    assert.ok(r.handlers > NEW_CHANNELS.length, 'the rest of main.js registered its handlers too: ' + r.handlers);
    assert.ok(r.appEvents.includes('before-quit') && r.appEvents.includes('will-quit'), r.appEvents.join(','));
    assert.equal(r.sameModule, true, 'main.js loaded the real token-usage.js, once');
  });

  test('before init the handlers answer { error } from the real module (not the stand-in), and read-ctx-state validates its id', () => {
    const b = result().before;
    assert.ok(b, 'not reached');
    assert.equal(b.summary.error, 'Token store unavailable: not initialised', 'the stand-in would say "load failed"');
    assert.deepEqual([b.summary.scan.state, b.summary.scan.reasonCode], ['disabled', null]);
    assert.equal(b.context.error, 'Token store unavailable: not initialised');
    for (const name of ['rescan', 'enable', 'disable']) assert.equal(b[name].error, 'Token store unavailable: not initialised', name);
    assert.deepEqual(b.ctxBad, { error: 'bad session id' });
    assert.deepEqual(b.ctxNone, { sidecar: null, state: null, codes: { sidecar: 'ENOENT', state: 'ENOENT', handoff: null }, handoffReadable: null });
  });

  test('the deferred init opens the store in SWITCHBOARD_DATA_DIR, and the watcher line feeds it: a query through the registered handler counts the file', () => {
    const r = result();
    assert.equal(r.opened, true, 'the store did not open within 20 s of ready: ' + JSON.stringify(r.afterInit));
    assert.ok(r.initMs >= 2500, 'not before the 3 s the init is deferred by (' + r.initMs + ' ms)');
    assert.equal(r.handleInData, true, 'the database is the one in the temp data dir');
    assert.deepEqual([r.afterInit.state, r.afterInit.reason, r.afterInit.reasonCode], ['ok', null, null]);
    assert.ok(r.dataFiles.includes('token-usage.db'), r.dataFiles.join(','));
    assert.equal(r.projectWatchers, 1, 'main.js watches the projects dir, once');
    assert.equal(r.watcherThrew, null, 'a .jsonl path, a null filename and a folder name');
    assert.deepEqual([r.summary.error, r.summary.threw, r.summary.responses, r.summary.output], [undefined, undefined, 2, 42]);
    assert.deepEqual([r.summary.scan.state, r.summary.scan.files, r.summary.scan.queryMode], ['ok', 1, 'worker']);
    assert.equal(r.summary.scan.backfillDone, null, 'counted through the watcher line and a scan request, before any walk');
    assert.deepEqual([r.sessions.error, r.sessions.threw, r.sessions.rows, r.sessions.sessionId, r.sessions.projectPathType, r.sessions.isRunning],
      [undefined, undefined, 1, SID, 'string', false]);
    assert.ok(r.tokenLogs.some((l) => l.startsWith('info: [token-usage] opened ')), r.tokenLogs.join('\n'));
    assert.deepEqual(r.tokenLogs.filter((l) => !l.startsWith('info: ') && !l.startsWith('debug: ')), [], 'nothing under [token-usage] at warn or error');
  });

  test('before-quit stops the scanner and will-quit closes the store; nothing was written outside the temp root and nothing escaped', () => {
    const r = result();
    assert.ok(r.quit, 'not reached');
    assert.equal(r.quit['before-quit'].threw, null);
    assert.deepEqual([r.quit['before-quit'].state, r.quit['before-quit'].handleOpen], ['ok', true], 'shutdown: readable until close');
    assert.match(r.quit['before-quit'].noteChanged.error, /^Token store unavailable/, 'and no more scanning');
    assert.equal(r.quit['will-quit'].threw, null);
    assert.deepEqual([r.quit['will-quit'].state, r.quit['will-quit'].reason, r.quit['will-quit'].handleOpen], ['disabled', 'closed', false]);
    assert.deepEqual(r.blocked, [], 'main.js tried to write outside the temp root');
    assert.deepEqual(r.uncaught, [], 'an exception or rejection escaped');
  });
}

if (process.env.MAIN_LOAD_ROOT) childMain();
else parentMain();
