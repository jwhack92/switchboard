'use strict';
// main.js cannot be loaded in a test (it needs Electron, node-pty and a
// window), and it is the one file whose save relaunches the app. So the blocks
// that wire the token store and read-ctx-state into it are cut out of the
// source by their markers and run here, in a vm context, against fakes. What
// this proves is about the text that ships: none of it can throw into the code
// around it, and read-ctx-state answers in the shape the renderer reads.
//
// Plain node. No database is opened: the only files are a few JSON fixtures in
// a temp folder standing in for %LOCALAPPDATA%\claude-ctx.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function between(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, 'marker not found in main.js: ' + start);
  assert.equal(SRC.indexOf(start, a + 1), -1, 'marker is not unique in main.js: ' + start);
  const b = SRC.indexOf(end, a);
  assert.ok(b > a, 'end marker not found after it: ' + end);
  return SRC.slice(a, b);
}

const REQUIRE_BLOCK = between('const TOKEN_USAGE_METHODS =', '// MUST run at module scope');
const HANDLER_BLOCK = between('function guardedTokens(fn) {', '// --- IPC: refresh-stats');
const INIT_BLOCK = between('tokenUsageInitTimer = setTimeout(() => {', '// Memory written while the app was closed');

const METHODS = ['init', 'noteChanged', 'flush', 'rescan', 'disable', 'enable', 'shutdown', 'close',
  'status', 'summary', 'models', 'daily', 'sessions', 'context'];
const STUB_ERROR = { error: 'Token store unavailable: load failed' };
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

function fakeLog(opts = {}) {
  const lines = [];
  const at = (level) => (...args) => {
    if (opts.throws) throw new Error('log is broken');
    lines.push(level + ' ' + args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return { lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

// --- The guarded require ---

function runRequire(fakeRequire, log) {
  const context = vm.createContext({ require: fakeRequire, log });
  vm.runInContext(REQUIRE_BLOCK, context);
  return vm.runInContext('tokenUsage', context);
}

test('main wiring: a token-usage.js that fails to load becomes a stand-in whose every method answers { error }', () => {
  const log = fakeLog();
  const stub = runRequire(() => { throw new SyntaxError('Unexpected token in token-usage.js'); }, log);
  for (const name of METHODS) {
    assert.equal(typeof stub[name], 'function', name);
    assert.deepEqual({ ...stub[name]('p/s.jsonl') }, STUB_ERROR, name);
  }
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /^error \[token-usage\] load failed/);
});

test('main wiring: a module that loads without one of the methods main calls is replaced as a whole', () => {
  for (const missing of METHODS) {
    const partial = {};
    for (const name of METHODS) if (name !== missing) partial[name] = () => ({ ok: true });
    const log = fakeLog();
    const stub = runRequire(() => partial, log);
    assert.notEqual(stub, partial, missing);
    assert.deepEqual({ ...stub.noteChanged('p/s.jsonl') }, STUB_ERROR, missing);
    assert.deepEqual({ ...stub[missing]() }, STUB_ERROR, missing);
    assert.ok(log.lines[0].includes(missing), log.lines[0]);
  }
  for (const notAModule of [null, undefined, 7, 'x']) {
    const stub = runRequire(() => notAModule, fakeLog());
    assert.deepEqual({ ...stub.summary({}) }, STUB_ERROR, String(notAModule));
  }
});

test('main wiring: a logger that throws does not stop the stand-in from being installed', () => {
  const stub = runRequire(() => { throw new Error('missing file'); }, fakeLog({ throws: true }));
  assert.deepEqual({ ...stub.init({}) }, STUB_ERROR);
});

test('main wiring: the real token-usage.js passes the check, and before init nothing main calls can throw', async () => {
  const real = require('../token-usage');
  const log = fakeLog();
  const loaded = runRequire((id) => { assert.equal(id, './token-usage'); return real; }, log);
  assert.equal(loaded, real);
  assert.deepEqual(log.lines, []);
  // The watcher starts before init (which is deferred 3 s): these are the
  // calls that can arrive first. None may throw; none opens anything.
  assert.equal(typeof loaded.noteChanged('proj/' + SID + '.jsonl').error, 'string');
  assert.equal(typeof loaded.noteChanged(undefined).error, 'string');
  // The queries answer through a Promise (they run in the query worker); it
  // resolves to { error } and never rejects, which is what guardedTokens awaits.
  for (const name of ['summary', 'models', 'daily', 'sessions', 'context']) {
    const pending = loaded[name]({});
    assert.equal(typeof pending.then, 'function', name);
    assert.equal(typeof (await pending).error, 'string', name);
  }
  assert.equal(typeof loaded.rescan().error, 'string');
  assert.deepEqual(loaded.shutdown(), { ok: true });
  assert.deepEqual(loaded.close(), { ok: true });
  assert.equal(loaded._handle(), null, 'no database was opened');
});

// --- The handlers ---

function bootHandlers(opts = {}) {
  const handlers = new Map();
  const log = opts.log || fakeLog();
  const ctxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'main-wiring-'));
  const ctxDir = path.join(ctxRoot, 'claude-ctx');
  fs.mkdirSync(ctxDir);
  const fsCalls = [];
  const spiedFs = {
    readFileSync: (p, enc) => { fsCalls.push('read ' + p); return fs.readFileSync(p, enc); },
    statSync: (p) => { fsCalls.push('stat ' + p); return fs.statSync(p); },
  };
  const sessions = new Map();
  const knobs = { resolveThrows: false };
  const context = vm.createContext({
    ipcMain: {
      handle: (name, fn) => {
        if (opts.handleThrowsFor && opts.handleThrowsFor(name)) throw new Error(`Attempted to register a second handler for '${name}'`);
        handlers.set(name, fn);
      },
    },
    log,
    fs: spiedFs,
    path,
    os: { homedir: () => path.join(ctxRoot, 'home') },
    process: { env: opts.noLocalAppData ? {} : { LOCALAPPDATA: ctxRoot } },
    tokenUsage: opts.tokenUsage || {},
    resolveLiveSession: (id) => {
      if (knobs.resolveThrows) throw new Error('registry is broken');
      return { id, session: sessions.get(id) || null };
    },
  });
  vm.runInContext(HANDLER_BLOCK, context);
  return {
    handlers, log, ctxRoot, ctxDir, fsCalls, sessions, knobs,
    call: (name, ...args) => handlers.get(name)({ sender: null }, ...args),
    write: (file, text) => fs.writeFileSync(path.join(ctxDir, file), text),
    cleanup: () => fs.rmSync(ctxRoot, { recursive: true, force: true }),
  };
}

test('main wiring: every channel the preload invokes has a handler', () => {
  const h = bootHandlers();
  try {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const invoked = [...preload.matchAll(/invoke\('((?:token-stats-|read-ctx-state)[^']*)'/g)].map(m => m[1]).sort();
    assert.deepEqual(invoked, [
      'read-ctx-state', 'token-stats-context', 'token-stats-daily', 'token-stats-disable', 'token-stats-enable',
      'token-stats-models', 'token-stats-rescan', 'token-stats-sessions', 'token-stats-summary',
    ]);
    assert.deepEqual([...h.handlers.keys()].sort(), invoked);
  } finally { h.cleanup(); }
});

test('main wiring: token-stats handlers pass the request through and turn a throw into { error } under their own log tag', async () => {
  const seen = [];
  const tokenUsage = {};
  for (const name of ['summary', 'models', 'daily', 'sessions', 'context', 'rescan', 'disable', 'enable']) {
    tokenUsage[name] = (...args) => { seen.push([name, args]); return { ok: true, from: name }; };
  }
  const h = bootHandlers({ tokenUsage });
  try {
    const q = { from: '2026-09-01', to: '2026-09-30' };
    for (const name of ['summary', 'models', 'daily', 'sessions', 'context']) {
      assert.deepEqual(await h.call('token-stats-' + name, q), { ok: true, from: name });
    }
    for (const name of ['rescan', 'disable', 'enable']) {
      // Whatever the renderer sends, these take no argument.
      assert.deepEqual(await h.call('token-stats-' + name, { sneaky: true }), { ok: true, from: name });
    }
    assert.deepEqual(seen.slice(0, 5).map(([, args]) => args), [[q], [q], [q], [q], [q]]);
    assert.deepEqual(seen.slice(5).map(([, args]) => args), [[], [], []]);

    tokenUsage.summary = () => { throw new Error('store exploded'); };
    assert.deepEqual({ ...(await h.call('token-stats-summary', q)) }, { error: 'store exploded' }); // spread: the reply is made in the vm's realm
    tokenUsage.models = () => { throw null; };
    assert.deepEqual({ ...(await h.call('token-stats-models', q)) }, { error: 'null' });
    tokenUsage.daily = undefined; // not a function at all
    assert.equal(typeof (await h.call('token-stats-daily', q)).error, 'string');
    assert.equal(h.log.lines.length, 3);
    for (const line of h.log.lines) assert.match(line, /^error \[token-usage\]/);
  } finally { h.cleanup(); }
});

test('main wiring: a channel that already has a handler costs that block, not the app', () => {
  // ipcMain.handle throws on a second registration, and this code runs at module scope.
  const log = fakeLog();
  const h = bootHandlers({ log, handleThrowsFor: (name) => name === 'token-stats-daily' || name === 'read-ctx-state' });
  try {
    assert.deepEqual([...h.handlers.keys()], ['token-stats-summary', 'token-stats-models']);
    assert.equal(log.lines.length, 2);
    assert.match(log.lines[0], /handler registration failed/);
  } finally { h.cleanup(); }
  const quiet = bootHandlers({ log: fakeLog({ throws: true }), handleThrowsFor: () => true });
  quiet.cleanup(); // reaching here is the assertion: neither the throw nor the broken logger escaped
});

test('read-ctx-state: anything that is not a session id is refused before any file is touched', async () => {
  const h = bootHandlers();
  try {
    const bad = [
      undefined, null, 7, {}, [SID], '', 'sess-a', SID + '.state', SID + '\\..\\..\\x', '..\\' + SID, SID + '/../x',
      ' ' + SID, SID + '\n', 'C:\\Windows\\win.ini', SID.replace('a', 'g'), SID.slice(1),
    ];
    for (const id of bad) {
      assert.deepEqual({ ...(await h.call('read-ctx-state', id)) }, { error: 'bad session id' }, JSON.stringify(id));
    }
    assert.deepEqual(h.fsCalls, []);
    // Upper case is the same id (and the same file on Windows).
    assert.equal('error' in (await h.call('read-ctx-state', SID.toUpperCase())), false);
  } finally { h.cleanup(); }
});

test('read-ctx-state: only <id>.json and <id>.state.json in the claude-ctx folder are read', async () => {
  const h = bootHandlers();
  try {
    await h.call('read-ctx-state', SID);
    assert.deepEqual(h.fsCalls, [
      'read ' + path.join(h.ctxDir, SID + '.json'),
      'read ' + path.join(h.ctxDir, SID + '.state.json'),
    ]);
  } finally { h.cleanup(); }
  const fallback = bootHandlers({ noLocalAppData: true });
  try {
    await fallback.call('read-ctx-state', SID);
    assert.equal(fallback.fsCalls[0], 'read ' + path.join(fallback.ctxRoot, 'home', 'AppData', 'Local', 'claude-ctx', SID + '.json'));
  } finally { fallback.cleanup(); }
});

test('read-ctx-state: codes tell "not there" from "could not be read", per file', async () => {
  const h = bootHandlers();
  try {
    let reply = await h.call('read-ctx-state', SID);
    assert.deepEqual(JSON.parse(JSON.stringify(reply)), {
      sidecar: null, state: null, codes: { sidecar: 'ENOENT', state: 'ENOENT', handoff: null }, handoffReadable: null,
    });
    assert.equal('busy' in reply, false);

    h.write(SID + '.json', JSON.stringify({ total_input_tokens: 412345 }));
    h.write(SID + '.state.json', '{"pending": tr'); // caught mid-write
    reply = await h.call('read-ctx-state', SID);
    assert.deepEqual(JSON.parse(JSON.stringify(reply)), {
      sidecar: { total_input_tokens: 412345 }, state: null,
      codes: { sidecar: null, state: 'EPARSE', handoff: null }, handoffReadable: null,
    });

    fs.rmSync(path.join(h.ctxDir, SID + '.json'));
    fs.mkdirSync(path.join(h.ctxDir, SID + '.json')); // a read that fails with something other than ENOENT
    reply = await h.call('read-ctx-state', SID);
    assert.equal(reply.sidecar, null);
    assert.equal(typeof reply.codes.sidecar, 'string');
    assert.notEqual(reply.codes.sidecar, 'ENOENT');
    assert.notEqual(reply.codes.sidecar, null);
  } finally { h.cleanup(); }
});

test('read-ctx-state: the handoff file is statted, never read; only ENOENT says it is gone', async () => {
  const h = bootHandlers();
  try {
    const handoff = path.join(h.ctxRoot, 'handoff.md');
    const state = (over) => h.write(SID + '.state.json', JSON.stringify({ written_at: 1999999, handoff_path: handoff, ...over }));

    state();
    let reply = await h.call('read-ctx-state', SID);
    assert.equal(reply.handoffReadable, false);
    assert.equal(reply.codes.handoff, 'ENOENT');

    fs.writeFileSync(handoff, '# handoff');
    h.fsCalls.length = 0;
    reply = await h.call('read-ctx-state', SID);
    assert.equal(reply.handoffReadable, true);
    assert.equal(reply.codes.handoff, null);
    assert.deepEqual(h.fsCalls.filter(c => c.includes('handoff.md')), ['stat ' + handoff]);
    assert.equal(reply.state.handoff_path, handoff);

    fs.writeFileSync(handoff, ''); // being rewritten: there, but nothing in it yet
    reply = await h.call('read-ctx-state', SID);
    assert.equal(reply.handoffReadable, false);
    assert.equal(reply.codes.handoff, null, 'not gone');

    state({ handoff_path: h.ctxRoot }); // a folder is not a handoff
    reply = await h.call('read-ctx-state', SID);
    assert.equal(reply.handoffReadable, false);
    assert.equal(reply.codes.handoff, null);

    for (const none of [null, '', 7, undefined]) {
      state({ handoff_path: none });
      h.fsCalls.length = 0;
      reply = await h.call('read-ctx-state', SID);
      assert.equal(reply.handoffReadable, null, String(none));
      assert.equal(reply.codes.handoff, null, String(none));
      assert.equal(h.fsCalls.filter(c => c.startsWith('stat')).length, 0, String(none));
    }
    // A state file that is valid JSON but not an object.
    for (const text of ['null', '7', '"x"', '[]']) {
      h.write(SID + '.state.json', text);
      reply = await h.call('read-ctx-state', SID);
      assert.equal(reply.handoffReadable, null, text);
      assert.equal(reply.codes.state, null, text);
    }
  } finally { h.cleanup(); }
});

test('read-ctx-state: busy is present only for a running session whose title main has read', async () => {
  const h = bootHandlers();
  try {
    const ask = async (session) => {
      if (session) h.sessions.set(SID, session); else h.sessions.delete(SID);
      return h.call('read-ctx-state', SID);
    };
    // Absent: no such session; no title read yet (a plain terminal never gets
    // one); exited. A non-boolean _titleBusy is "never read" too.
    const absent = [
      null,
      {},
      { _cliBusy: true },
      { _cliBusy: false },
      { _titleBusy: undefined, _cliBusy: true },
      { _titleBusy: null },
      { _titleBusy: 1 },
      { exited: true, _titleBusy: false, _cliBusy: false },
      { exited: true, _titleBusy: true, _cliBusy: true },
    ];
    for (const session of absent) {
      const reply = await ask(session);
      assert.equal('busy' in reply, false, JSON.stringify(session));
      assert.equal(reply.codes.sidecar, 'ENOENT', 'the rest of the reply is still there');
    }
    const present = [
      [{ _titleBusy: false }, false],
      [{ _titleBusy: false, _cliBusy: false }, false],
      [{ _titleBusy: true, _cliBusy: false }, true],
      [{ _titleBusy: false, _cliBusy: true }, true], // OSC 9;4 progress said busy after an idle title
      [{ _titleBusy: true, _cliBusy: true }, true],
      [{ _titleBusy: false, _cliBusy: 'yes' }, false], // only a real true counts
      [{ exited: false, _titleBusy: false }, false],
    ];
    for (const [session, want] of present) {
      const reply = await ask(session);
      assert.equal(reply.busy, want, JSON.stringify(session));
    }
    // The lookup itself failing costs the flag, not the reply.
    h.knobs.resolveThrows = true;
    const reply = await ask({ _titleBusy: false });
    assert.equal('busy' in reply, false);
    assert.equal(reply.handoffReadable, null);
  } finally { h.cleanup(); }
});

// --- The deferred init ---

function bootInit(opts = {}) {
  const timers = [];
  const inits = [];
  const log = opts.log || fakeLog();
  const cache = new Map();
  const meta = new Map();
  const folders = new Map();
  const activeSessions = new Map();
  const context = vm.createContext({
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 41; },
    tokenUsageInitTimer: null,
    tokenUsage: { init: (ctx) => { inits.push(ctx); if (opts.initThrows) throw new Error('init blew up'); return opts.initResult || { ok: true, state: 'ok' }; } },
    log,
    registry: { broadcast: () => {} },
    PROJECTS_DIR: 'C:\\Users\\x\\.claude\\projects',
    app: { getVersion: () => { if (opts.versionThrows) throw new Error('no version'); return '9.9.9'; } },
    path,
    __dirname: 'C:\\app',
    getCachedSession: (id) => { if (opts.dbThrows) throw new Error('db closed'); return cache.get(id) || null; },
    getMeta: (id) => meta.get(id) || null,
    getFolderMeta: (slug) => { if (opts.dbThrows) throw new Error('db closed'); return folders.get(slug) || null; },
    activeSessions,
  });
  vm.runInContext(INIT_BLOCK, context);
  return { timers, inits, log, cache, meta, folders, activeSessions, context };
}

test('main wiring: init is deferred 3 s and is handed the contract\'s ctx', () => {
  const h = bootInit();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 3000);
  assert.equal(h.inits.length, 0, 'nothing runs inline in whenReady');
  assert.equal(vm.runInContext('tokenUsageInitTimer', h.context), 41);
  h.timers[0].fn();
  assert.equal(vm.runInContext('tokenUsageInitTimer', h.context), null);
  assert.equal(h.inits.length, 1);
  const ctx = h.inits[0];
  assert.deepEqual(Object.keys(ctx).sort(), ['appVersion', 'broadcast', 'folderMeta', 'isRunning', 'log', 'projectsDir', 'sessionInfo', 'workerPath']);
  assert.equal(ctx.log, h.log);
  assert.equal(typeof ctx.broadcast, 'function');
  assert.equal(ctx.projectsDir, 'C:\\Users\\x\\.claude\\projects');
  assert.equal(ctx.appVersion, '9.9.9');
  assert.equal(ctx.workerPath, path.join('C:\\app', 'workers', 'scan-tokens.js'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'workers', 'scan-tokens.js')), 'the worker file main points at exists');
  assert.deepEqual(h.log.lines, []);
});

test('main wiring: session titles follow the sidebar: rename, then custom title, ai title, summary', () => {
  const h = bootInit();
  h.timers[0].fn();
  const { sessionInfo, folderMeta, isRunning } = h.inits[0];
  assert.equal(sessionInfo(SID), null, 'unknown session');
  h.cache.set(SID, { summary: 'the summary' });
  assert.deepEqual({ ...sessionInfo(SID) }, { title: 'the summary' });
  h.cache.set(SID, { summary: 'the summary', aiTitle: 'ai title' });
  assert.deepEqual({ ...sessionInfo(SID) }, { title: 'ai title' });
  h.cache.set(SID, { summary: 'the summary', aiTitle: 'ai title', customTitle: 'custom title' });
  assert.deepEqual({ ...sessionInfo(SID) }, { title: 'custom title' });
  h.meta.set(SID, { name: 'renamed by hand' });
  assert.deepEqual({ ...sessionInfo(SID) }, { title: 'renamed by hand' });
  h.meta.set(SID, { name: '' }); // a cleared rename falls through
  assert.deepEqual({ ...sessionInfo(SID) }, { title: 'custom title' });
  h.cache.delete(SID);
  h.meta.set(SID, { name: 'only a rename' }); // renamed, not in the cache
  assert.deepEqual({ ...sessionInfo(SID) }, { title: 'only a rename' });
  h.meta.delete(SID);
  h.cache.set(SID, { summary: '', aiTitle: null, customTitle: null });
  assert.equal(sessionInfo(SID), null);

  assert.equal(folderMeta('C--proj'), null);
  h.folders.set('C--proj', { folder: 'C--proj', projectPath: 'C:\\proj', indexMtimeMs: 5 });
  assert.deepEqual({ ...folderMeta('C--proj') }, { projectPath: 'C:\\proj' });
  h.folders.set('C--none', { folder: 'C--none', projectPath: null });
  assert.equal(folderMeta('C--none'), null);

  assert.equal(isRunning(SID), false);
  h.activeSessions.set(SID, { exited: false });
  assert.equal(isRunning(SID), true);
  h.activeSessions.set(SID, { exited: true });
  assert.equal(isRunning(SID), false);
  // A forked session lives on under a new id; the old id's transcript is not running.
  h.activeSessions.delete(SID);
  h.activeSessions.set('bbbbbbbb-1111-2222-3333-444444444444', { exited: false, priorIds: [SID] });
  assert.equal(isRunning(SID), false);
});

test('main wiring: nothing in the deferred init can throw out of the timer', () => {
  // The app database failing under the lookups.
  const db = bootInit({ dbThrows: true });
  db.timers[0].fn();
  assert.equal(db.inits[0].sessionInfo(SID), null);
  assert.equal(db.inits[0].folderMeta('x'), null);
  // init answering { error } is logged, not thrown.
  const refused = bootInit({ initResult: { error: 'Token store unavailable: disabled by token-usage.off' } });
  refused.timers[0].fn();
  assert.deepEqual(refused.log.lines, ['warn [token-usage] init: Token store unavailable: disabled by token-usage.off']);
  // init throwing (it should not; the store wraps it), building the ctx
  // throwing, and the logger throwing on top of either.
  for (const opts of [{ initThrows: true }, { versionThrows: true }, { initThrows: true, log: fakeLog({ throws: true }) },
    { initResult: { error: 'x' }, log: fakeLog({ throws: true }) }]) {
    const h = bootInit(opts);
    h.timers[0].fn();
    if (!opts.log) assert.match(h.log.lines[0], /^error \[token-usage\] init failed/);
  }
});

// --- The lines that sit inside existing functions ---

test('main wiring: the watcher line, the quit lines and the placement after the reloader line are as designed', () => {
  // The watcher callback has no try/catch of its own, so the call carries one.
  const watcher = between('} else if (basename.endsWith(\'.jsonl\')) {', '} else if (basename.endsWith(\'.md\')) {');
  assert.match(watcher, /pendingFolders\.add\(folder\);\s+try \{ tokenUsage\.noteChanged\(filename\); \} catch \{\}/);
  assert.equal(SRC.split('tokenUsage.noteChanged(').length - 1, 1, 'called from one place');

  const beforeQuit = between("app.on('before-quit', () => {", "app.on('will-quit', () => {");
  assert.match(beforeQuit, /try \{\s+clearTimeout\(tokenUsageInitTimer\);\s+tokenUsage\.shutdown\(\);\s+\} catch \(err\) \{/);
  const willQuit = SRC.slice(SRC.indexOf("app.on('will-quit', () => {"));
  assert.match(willQuit, /closeDb\(\);\s+try \{ tokenUsage\.close\(\); \} catch \{\}\s+\}\);/);

  // Required after the electron-reloader line: a module required before it
  // relaunches the app, and kills every session, on every save.
  const reloader = SRC.indexOf("require('electron-reloader')");
  const required = SRC.indexOf("require('./token-usage')");
  assert.ok(reloader > 0 && required > reloader);
  assert.equal(SRC.split("require('./token-usage')").length - 1, 1);
  // main.js reaches the store only through tokenUsage: nothing else of the
  // analytics modules is required by it.
  for (const other of ['./token-usage-queries', './token-usage-parse', './token-prices']) {
    assert.equal(SRC.includes(`require('${other}')`), false, other);
  }
});
