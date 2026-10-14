'use strict';
// The header's auto handoff switch, main side: the two handlers that read, make
// and delete the ctx-handoff hook's opt-out marker <session id>.off, and the two
// preload lines that reach them.
//
// main.js cannot be loaded in a test (Electron, node-pty, a window), and it is
// the one file whose save relaunches the app. So the block is cut out of the
// source by its markers (test-support/source-cut.js), together with the three
// pieces of main.js it uses (CTX_ID_RE, resolveLiveSession, claudeCtxDir), and
// run in a vm context. What is tested is the text that ships.
//
// THE FILES. The hook of every live session reads the real claude-ctx folder,
// so nothing here may reach it. Every boot() makes a fresh folder under
// os.tmpdir() and hands the block a stand-in `process` whose env names that
// folder as LOCALAPPDATA, and a stand-in `os` whose homedir() lies inside it:
// the block never sees the real environment or the real home folder, and the
// real process.env is neither read nor changed. `fs` is the real one behind a
// recorder that lists every call and refuses a path outside that folder. What a
// test makes, changes or deletes itself goes through h.make, h.mkdir, h.mode
// and h.remove, which assert the path first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, cut, load } = require('../test-support/source-cut');

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OLD = 'bbbbbbbb-1111-2222-3333-444444444444';
const NEW = 'cccccccc-1111-2222-3333-444444444444';
const STRAY = 'dddddddd-1111-2222-3333-444444444444';

// The bad-id list of test/main-token-wiring.test.js ("read-ctx-state: anything
// that is not a session id is refused before any file is touched").
const BAD_IDS = [
  undefined, null, 7, {}, [SID], '', 'sess-a', SID + '.state', SID + '\\..\\..\\x', '..\\' + SID, SID + '/../x',
  ' ' + SID, SID + '\n', 'C:\\Windows\\win.ini', SID.replace('a', 'g'), SID.slice(1),
];

// A reply is made in the vm's realm: compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeLog(opts = {}) {
  const lines = [];
  const at = (level) => (...args) => {
    if (opts.throws) throw new Error('log is broken');
    lines.push(level + ' ' + args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return { lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

// Runs the block with its three pieces of main.js against a temp folder.
//   noLocalAppData   the env has no LOCALAPPDATA: the folder is under the stand-in home
//   noCtxDir         the claude-ctx folder is not made
//   env              more names for the block's process.env
//   handleThrowsFor  (channel) => true: ipcMain.handle throws for it
//   log              another log
function boot(opts = {}) {
  // The cuts come first: when one throws, nothing has been made on disk.
  const text = cut('main.js', 'const CTX_ID_RE = ', '// → { value, code }: code')
    + cut('main.js', 'function resolveLiveSession(sessionId) {', 'registry.init({ log });')
    + cut('main.js', 'function claudeCtxDir() {', 'sessionTransitions.init({')
    + cut('main.js', '// --- IPC: handoff switch', '// --- IPC: get-memories ---');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-switch-'));
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'handoff-switch-')), 'the temp folder is a fresh one under os.tmpdir(): ' + root);
  const inRoot = (p) => typeof p === 'string' && path.resolve(p).startsWith(root + path.sep);
  const mine = (p) => {
    assert.ok(inRoot(p), 'a test makes and deletes files only inside its temp folder: ' + String(p));
    return p;
  };
  const home = path.join(root, 'home');
  const ctxDir = opts.noLocalAppData ? path.join(home, 'AppData', 'Local', 'claude-ctx') : path.join(root, 'claude-ctx');
  if (!opts.noCtxDir) fs.mkdirSync(mine(ctxDir), { recursive: true });

  const env = { ...(opts.noLocalAppData ? {} : { LOCALAPPDATA: root }), ...(opts.env || {}) };
  const handlers = new Map();
  const log = opts.log || fakeLog();
  const sessions = new Map();
  const fsCalls = [];
  const recordedFs = new Proxy(fs, {
    get(target, key) {
      const real = target[key];
      if (typeof real !== 'function') return real;
      return (...args) => {
        fsCalls.push(String(key) + ' ' + String(args[0]));
        if (!inRoot(args[0])) {
          throw Object.assign(new Error(`handoff-switch test refused fs.${String(key)} outside its temp folder: ${String(args[0])}`), { code: 'EOUTSIDE' });
        }
        return real.apply(target, args);
      };
    },
  });

  try {
    load(text, { file: 'main.js', globals: {
      ipcMain: {
        handle: (name, fn) => {
          if (opts.handleThrowsFor && opts.handleThrowsFor(name)) throw new Error(`Attempted to register a second handler for '${name}'`);
          handlers.set(name, fn);
        },
      },
      log,
      fs: recordedFs,
      path,
      os: { homedir: () => home },
      process: { env },
      activeSessions: sessions,
    } });
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }

  const call = (name, ...args) => handlers.get(name)({ sender: null }, ...args);
  return {
    handlers, log, root, home, ctxDir, env, sessions, fsCalls,
    read: (id) => plain(call('read-handoff-off', id)),
    set: (id, off) => plain(call('set-handoff-off', id, off)),
    /** Where the marker of a session id is. */
    file: (id) => path.join(ctxDir, id + '.off'),
    make: (p, content = '') => fs.writeFileSync(mine(p), content),
    mkdir: (p) => fs.mkdirSync(mine(p), { recursive: true }),
    remove: (p) => fs.rmSync(mine(p), { recursive: true }),
    mode: (p, mode) => fs.chmodSync(mine(p), mode),
    /** The names in the claude-ctx folder, sorted. */
    listing: () => fs.readdirSync(ctxDir).sort(),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('handoff switch (main): what is not a session id is refused before any file is touched, on both channels', () => {
  const h = boot();
  try {
    // The id that was SENT is checked: a live session that has every one of
    // them as an earlier id does not make one of them good.
    h.sessions.set(NEW, { priorIds: BAD_IDS.slice() });
    for (const id of BAD_IDS) {
      const which = String(JSON.stringify(id));
      assert.deepEqual(h.read(id), { error: 'bad session id' }, 'read ' + which);
      assert.deepEqual(h.set(id, true), { error: 'bad session id' }, 'set true ' + which);
      assert.deepEqual(h.set(id, false), { error: 'bad session id' }, 'set false ' + which);
    }
    // And so is the id the session runs under now: a live record stored under
    // something that is not a session id.
    h.sessions.clear();
    h.sessions.set('sess-live', { priorIds: [SID] });
    assert.deepEqual(h.set(SID, true), { error: 'bad session id' }, 'live id, set true');
    assert.deepEqual(h.set(SID, false), { error: 'bad session id' }, 'live id, set false');
    assert.deepEqual(h.fsCalls, []);
    assert.deepEqual(h.listing(), []);
  } finally { h.cleanup(); }
});

test('handoff switch (main): off is whether <id>.off exists in the claude-ctx folder, as the hook checks it (a folder of that name counts)', () => {
  const h = boot();
  try {
    // Another session's marker, and this session's other files, are not it.
    h.make(h.file(OLD));
    h.make(path.join(h.ctxDir, SID + '.json'), '{}');
    h.make(path.join(h.ctxDir, SID + '.off.tmp'));
    assert.deepEqual(h.read(SID), { off: false, env: false });

    h.make(h.file(SID)); // an empty file is enough
    assert.deepEqual(h.read(SID), { off: true, env: false });

    h.remove(h.file(SID));
    assert.deepEqual(h.read(SID), { off: false, env: false });

    h.mkdir(h.file(SID)); // the hook's os.path.exists is true for a folder too
    assert.deepEqual(h.read(SID), { off: true, env: false });
  } finally { h.cleanup(); }
});

test('handoff switch (main): turning off makes an empty <id>.off and keeps one already there as it is; turning on deletes it, and one already gone is fine', () => {
  const h = boot();
  try {
    assert.deepEqual(h.set(SID, true), { ok: true, off: true, env: false, code: null, id: SID });
    assert.deepEqual(h.listing(), [SID + '.off']);
    assert.equal(fs.readFileSync(h.file(SID), 'utf8'), '', 'the marker is made empty');

    // One that is already there, with text in it: kept as it is.
    h.make(h.file(SID), 'made by the session itself');
    assert.deepEqual(h.set(SID, true), { ok: true, off: true, env: false, code: null, id: SID });
    assert.equal(fs.readFileSync(h.file(SID), 'utf8'), 'made by the session itself');

    assert.deepEqual(h.set(SID, false), { ok: true, off: false, env: false, code: null, id: SID });
    assert.deepEqual(h.listing(), []);

    // Already gone: that is what was asked for.
    assert.deepEqual(h.set(SID, false), { ok: true, off: false, env: false, code: null, id: SID });
    assert.deepEqual(h.listing(), []);
  } finally { h.cleanup(); }
});

test('handoff switch (main): ok is whether the file is now as asked; a make or delete that fails answers its code and off as the file now is', () => {
  const h = boot();
  try {
    // A folder named <id>.off cannot be deleted as a file, and the hook reads it as off.
    h.mkdir(h.file(SID));
    const del = h.set(SID, false);
    assert.equal(typeof del.code, 'string', 'the delete failed with a code: ' + JSON.stringify(del));
    assert.notEqual(del.code, '');
    assert.deepEqual(del, { ok: false, off: true, env: false, code: del.code, id: SID });
    assert.equal(fs.statSync(h.file(SID)).isDirectory(), true, 'the folder is still there');

    // Asked to make it: off is what was asked for, since the hook reads the
    // folder as off. Whether the write itself fails is the platform's affair
    // (Node 24 on Windows opens a folder for append and writes nothing: no code).
    const onFolder = h.set(SID, true);
    assert.deepEqual({ ok: onFolder.ok, off: onFolder.off, id: onFolder.id }, { ok: true, off: true, id: SID });
    assert.equal(fs.statSync(h.file(SID)).isDirectory(), true, 'the folder is still there');
    h.remove(h.file(SID));

    // A make that fails while a marker is already there (one that takes no
    // write): the file is as asked, so ok, and the code is answered all the same.
    h.make(h.file(SID), 'takes no write');
    h.mode(h.file(SID), 0o444);
    try {
      const make = h.set(SID, true);
      assert.equal(typeof make.code, 'string', 'the make failed with a code: ' + JSON.stringify(make));
      assert.notEqual(make.code, '');
      assert.deepEqual(make, { ok: true, off: true, env: false, code: make.code, id: SID });
      assert.equal(fs.readFileSync(h.file(SID), 'utf8'), 'takes no write');
    } finally { h.mode(h.file(SID), 0o666); }
  } finally { h.cleanup(); }

  // A claude-ctx folder that is not there cannot take a file, and is not made.
  const none = boot({ noCtxDir: true });
  try {
    assert.deepEqual(none.set(SID, true), { ok: false, off: false, env: false, code: 'ENOENT', id: SID });
    assert.equal(fs.existsSync(none.ctxDir), false, 'the folder was not made');
  } finally { none.cleanup(); }
});

test('handoff switch (main): env is true only for CLAUDE_CTX_HANDOFF off, 0, false or no (any case, spaces around), the hook\'s own rule', () => {
  const h = boot();
  try {
    assert.equal('CLAUDE_CTX_HANDOFF' in h.env, false);
    assert.deepEqual(h.read(SID), { off: false, env: false }, 'not set');
    assert.equal(h.set(SID, false).env, false, 'not set (set)');

    for (const value of ['off', '0', 'false', 'no', 'OFF', 'Off', 'False', 'NO', ' off', 'off ', '  0  ', '\tNo\r\n']) {
      h.env.CLAUDE_CTX_HANDOFF = value;
      assert.deepEqual(h.read(SID), { off: false, env: true }, 'read ' + JSON.stringify(value));
      assert.equal(h.set(SID, false).env, true, 'set ' + JSON.stringify(value));
    }
    for (const value of ['', ' ', 'on', '1', 'true', 'yes', 'offf', 'o f f', 'no way', 'none', '00', 'disabled']) {
      h.env.CLAUDE_CTX_HANDOFF = value;
      assert.deepEqual(h.read(SID), { off: false, env: false }, 'read ' + JSON.stringify(value));
      assert.equal(h.set(SID, false).env, false, 'set ' + JSON.stringify(value));
    }
    // The value is read at each call, and it is not the file: no marker was made.
    assert.deepEqual(h.listing(), []);
  } finally { h.cleanup(); }
});

test('handoff switch (main): the folder is read-ctx-state\'s (LOCALAPPDATA, else AppData\\Local under the home folder), and nothing but <id>.off is touched', () => {
  const h = boot();
  try {
    const marker = path.join(h.root, 'claude-ctx', SID + '.off');
    h.make(path.join(h.ctxDir, SID + '.json'), '{"total_input_tokens":412345}');
    h.make(path.join(h.ctxDir, SID + '.state.json'), '{"pending":true}');
    h.make(h.file(OLD), 'another session');
    h.read(SID);
    assert.equal(h.set(SID, true).ok, true);
    assert.equal(fs.existsSync(marker), true, 'made in LOCALAPPDATA\\claude-ctx');
    h.read(SID);
    assert.equal(h.set(SID, false).ok, true);
    assert.equal(fs.existsSync(marker), false);
    assert.ok(h.fsCalls.length >= 4, h.fsCalls.join(' | '));
    assert.deepEqual([...new Set(h.fsCalls.map(c => c.slice(c.indexOf(' ') + 1)))], [marker]);
    assert.deepEqual(h.listing(), [SID + '.json', SID + '.state.json', OLD + '.off'].sort());
    assert.equal(fs.readFileSync(path.join(h.ctxDir, SID + '.json'), 'utf8'), '{"total_input_tokens":412345}');
    assert.equal(fs.readFileSync(path.join(h.ctxDir, SID + '.state.json'), 'utf8'), '{"pending":true}');
    assert.equal(fs.readFileSync(h.file(OLD), 'utf8'), 'another session');
  } finally { h.cleanup(); }

  // No LOCALAPPDATA: AppData\Local under the home folder (a stand-in inside the temp folder).
  const fallback = boot({ noLocalAppData: true });
  try {
    assert.equal('LOCALAPPDATA' in fallback.env, false);
    const marker = path.join(fallback.root, 'home', 'AppData', 'Local', 'claude-ctx', SID + '.off');
    assert.deepEqual(fallback.read(SID), { off: false, env: false });
    assert.equal(fallback.set(SID, true).ok, true);
    assert.equal(fs.existsSync(marker), true, 'made under the home folder');
    assert.deepEqual(fallback.read(SID), { off: true, env: false });
    assert.equal(fallback.set(SID, false).ok, true);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual([...new Set(fallback.fsCalls.map(c => c.slice(c.indexOf(' ') + 1)))], [marker]);
    assert.equal(fs.existsSync(path.join(fallback.root, 'claude-ctx')), false, 'nothing was made anywhere else');
  } finally { fallback.cleanup(); }
});

test('handoff switch (main): set-handoff-off with anything but true or false is refused and touches nothing', () => {
  const h = boot();
  try {
    h.make(h.file(SID), 'there');
    for (const value of [undefined, null, 0, 1, '', 'true', 'false', 'off', 'on', {}, [], [true]]) {
      assert.deepEqual(h.set(SID, value), { error: 'bad value' }, String(JSON.stringify(value)));
    }
    assert.deepEqual(h.fsCalls, []);
    assert.equal(fs.readFileSync(h.file(SID), 'utf8'), 'there');

    // ...and with no marker none is made.
    h.remove(h.file(SID));
    for (const value of [undefined, null, 0, 1, '', 'true', 'false', 'off', 'on', {}, [], [true]]) {
      assert.deepEqual(h.set(SID, value), { error: 'bad value' }, String(JSON.stringify(value)));
    }
    assert.deepEqual(h.fsCalls, []);
    assert.deepEqual(h.listing(), []);
  } finally { h.cleanup(); }
});

test('handoff switch (main): a registration that throws costs this block only, and is logged', () => {
  // ipcMain.handle throws on a second registration, and this code runs at module scope.
  const log = fakeLog();
  const h = boot({ log, handleThrowsFor: (name) => name === 'set-handoff-off' });
  try {
    assert.deepEqual([...h.handlers.keys()], ['read-handoff-off']);
    assert.equal(log.lines.length, 1, log.lines.join(' | '));
    assert.match(log.lines[0], /^error \[handoff-off\] handler registration failed/);
  } finally { h.cleanup(); }

  const first = fakeLog();
  const none = boot({ log: first, handleThrowsFor: (name) => name === 'read-handoff-off' });
  try {
    assert.deepEqual([...none.handlers.keys()], []);
    assert.equal(first.lines.length, 1, first.lines.join(' | '));
    assert.match(first.lines[0], /^error \[handoff-off\] handler registration failed/);
  } finally { none.cleanup(); }

  const quiet = boot({ log: fakeLog({ throws: true }), handleThrowsFor: () => true });
  quiet.cleanup(); // reaching here is the assertion: neither the throw nor the broken logger escaped
});

test('handoff switch (main): preload forwards readHandoffOff and setHandoffOff to the two channels, once each', async () => {
  const text = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const count = (part) => text.split(part).length - 1;
  assert.equal(count("'read-handoff-off'"), 1, 'preload.js names the channel read-handoff-off once');
  assert.equal(count("'set-handoff-off'"), 1, 'preload.js names the channel set-handoff-off once');
  assert.equal(count('readHandoffOff'), 1, 'preload.js has one readHandoffOff');
  assert.equal(count('setHandoffOff'), 1, 'preload.js has one setHandoffOff');

  // The whole of preload.js against a fake electron: what the window gets as window.api.
  const invoked = [];
  const exposed = {};
  const quiet = () => new Proxy({}, { get: () => () => {} });
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: new Proxy({}, {
      get: (_target, key) => (key === 'invoke'
        ? (...args) => { invoked.push(args); return Promise.resolve('answer ' + invoked.length); }
        : () => {}),
    }),
    webFrame: quiet(),
    webUtils: quiet(),
  };
  load(text, { file: 'preload.js', globals: {
    require: (name) => { assert.equal(name, 'electron'); return electron; },
    process: { platform: 'win32' },
  } });
  const api = exposed.api;
  assert.equal(typeof api.readHandoffOff, 'function');
  assert.equal(typeof api.setHandoffOff, 'function');
  assert.equal(await api.readHandoffOff(SID), 'answer 1');
  assert.equal(await api.setHandoffOff(SID, true), 'answer 2');
  assert.equal(await api.setHandoffOff(SID, false), 'answer 3');
  assert.deepEqual(invoked, [
    ['read-handoff-off', SID],
    ['set-handoff-off', SID, true],
    ['set-handoff-off', SID, false],
  ]);
});

test('handoff switch (main): set-handoff-off with an earlier id of a live session makes or deletes the live id\'s marker, answers with the live id, and on turning on also deletes the earlier id\'s', () => {
  const h = boot();
  try {
    // The session ran as OLD and runs as NEW now; the window still holds OLD.
    h.sessions.set(NEW, { priorIds: [OLD] });

    assert.deepEqual(h.set(OLD, true), { ok: true, off: true, env: false, code: null, id: NEW });
    assert.deepEqual(h.listing(), [NEW + '.off'], 'the live id\'s marker is made, not the earlier id\'s');

    // The earlier id has a marker of its own (it was off before the re-key).
    h.make(h.file(OLD), 'from before the re-key');
    assert.deepEqual(h.set(OLD, true), { ok: true, off: true, env: false, code: null, id: NEW });
    assert.equal(fs.readFileSync(h.file(OLD), 'utf8'), 'from before the re-key', 'turning off leaves the earlier id\'s as it is');
    assert.deepEqual(h.listing(), [OLD + '.off', NEW + '.off'].sort());

    assert.deepEqual(h.set(OLD, false), { ok: true, off: false, env: false, code: null, id: NEW });
    assert.deepEqual(h.listing(), [], 'both are gone: the earlier id does not come back off');

    // Only the live id had one: the earlier id's being gone already is no failure.
    h.make(h.file(NEW));
    assert.deepEqual(h.set(OLD, false), { ok: true, off: false, env: false, code: null, id: NEW });
    assert.deepEqual(h.listing(), []);

    // An id no session holds keeps itself.
    assert.deepEqual(h.set(STRAY, true), { ok: true, off: true, env: false, code: null, id: STRAY });
    assert.deepEqual(h.listing(), [STRAY + '.off']);
    assert.deepEqual(h.set(STRAY, false), { ok: true, off: false, env: false, code: null, id: STRAY });
    assert.deepEqual(h.listing(), []);
  } finally { h.cleanup(); }
});

test('handoff switch (main): main.js hands the detector copyHandoffOff; it makes <new id>.off only when <old id>.off exists, keeps one already there, deletes nothing, and ignores what is not a session id', () => {
  // The two cuts of test/main-pty-wiring.test.js ("main.js hands the detector
  // copyStar, ..."): the id pattern, then the detector's wiring. This load is
  // the test's own, with an fs global. The cuts come first: when one throws,
  // nothing has been made on disk.
  const text = cut('main.js', 'const CTX_ID_RE = ', '// → { value, code }: code')
    + cut('main.js', "const sessionTransitions = require('./session-transitions');", '// --- fs.watch on projects directory ---');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-switch-'));
  try {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'handoff-switch-')), 'the temp folder is a fresh one under os.tmpdir(): ' + root);
    const inRoot = (p) => typeof p === 'string' && path.resolve(p).startsWith(root + path.sep);
    const mine = (p) => {
      assert.ok(inRoot(p), 'a test makes and deletes files only inside its temp folder: ' + String(p));
      return p;
    };
    const ctxDir = path.join(root, 'claude-ctx');
    fs.mkdirSync(mine(ctxDir));
    const file = (id) => path.join(ctxDir, id + '.off');
    const make = (p, content = '') => fs.writeFileSync(mine(p), content);
    const listing = () => fs.readdirSync(ctxDir).sort();
    const fsCalls = [];
    const recordedFs = new Proxy(fs, {
      get(target, key) {
        const real = target[key];
        if (typeof real !== 'function') return real;
        return (...args) => {
          fsCalls.push(String(key) + ' ' + String(args[0]));
          if (!inRoot(args[0])) {
            throw Object.assign(new Error(`handoff-switch test refused fs.${String(key)} outside its temp folder: ${String(args[0])}`), { code: 'EOUTSIDE' });
          }
          return real.apply(target, args);
        };
      },
    });

    let given = null;
    load(text, { file: 'main.js', globals: {
      require: (name) => {
        assert.equal(name, './session-transitions');
        return { init: (ctx) => { given = ctx; }, detectSessionTransitions() {} };
      },
      PROJECTS_DIR: path.join(root, 'projects'), activeSessions: new Map(),
      log: fakeLog(),
      registry: { sendToOwner() {}, rekeyOwner() {}, broadcast() {}, ownerId() {} },
      dbModule: { rekeyScheduleSession() {}, copyStar() {} },
      copySessionAssignment() {}, rekeyPlanLinks() {}, rekeyMcpServer() {},
      fs: recordedFs, path, os: { homedir: () => path.join(root, 'home') }, process: { env: { LOCALAPPDATA: root } },
      readCtxJson: () => ({ value: null, code: 'ENOENT' }),
    } });
    assert.equal(typeof given.copyHandoffOff, 'function', 'main.js hands the detector copyHandoffOff');
    const copy = given.copyHandoffOff;

    // The old id has no marker: none is made for the new id. Its other files
    // and another session's marker are not it.
    make(path.join(ctxDir, OLD + '.json'), '{}');
    make(path.join(ctxDir, OLD + '.state.json'), '{"pending":true}');
    make(file(STRAY), 'another session');
    const before = listing();
    copy(OLD, NEW);
    assert.deepEqual(listing(), before, 'no <old id>.off: nothing is made');

    // The old id has one: the new id's is made, empty.
    make(file(OLD), 'made by the session itself');
    copy(OLD, NEW);
    assert.equal(fs.existsSync(file(NEW)), true, '<new id>.off is made');
    assert.equal(fs.readFileSync(file(NEW), 'utf8'), '', 'the marker is made empty');

    // One already there under the new id, with text in it: kept as it is.
    make(file(NEW), 'already there');
    copy(OLD, NEW);
    assert.equal(fs.readFileSync(file(NEW), 'utf8'), 'already there');

    // What is not a session id, as the old id or as the new one: no file is touched.
    const calls = fsCalls.length;
    for (const bad of BAD_IDS) {
      copy(bad, SID);
      copy(OLD, bad);
      copy(bad, bad);
    }
    assert.deepEqual(fsCalls.slice(calls), [], 'what is not a session id touches no file');

    // Nothing is deleted: the old id's marker and every other file are as they were.
    assert.deepEqual(listing(), [OLD + '.json', OLD + '.state.json', OLD + '.off', NEW + '.off', STRAY + '.off'].sort());
    assert.equal(fs.readFileSync(file(OLD), 'utf8'), 'made by the session itself');
    assert.equal(fs.readFileSync(file(STRAY), 'utf8'), 'another session');
    assert.equal(fs.readFileSync(path.join(ctxDir, OLD + '.json'), 'utf8'), '{}');
    assert.equal(fs.readFileSync(path.join(ctxDir, OLD + '.state.json'), 'utf8'), '{"pending":true}');
    assert.deepEqual(fsCalls.filter((c) => /^(unlink|rm|rename|truncate)/.test(c)), [], 'no call that deletes');
    assert.deepEqual([...new Set(fsCalls.map((c) => c.slice(c.indexOf(' ') + 1)))].sort(), [file(OLD), file(NEW)].sort(), 'nothing but the two markers is touched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
