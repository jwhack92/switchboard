'use strict';
// The handlers of main.js that reach a session's terminal: stop-session,
// terminal-input, terminal-resize, close-terminal and open-terminal.
//
// main.js cannot be loaded in a test (Electron, node-pty, a window), and it is
// the one file whose save relaunches the app. So each handler is cut out of
// the source by two marker strings (test-support/source-cut.js) and run in a
// vm context against fakes. What is tested is the text that ships.
//
// The tests named "(pin)" are PIN tests. They record what the code did before
// the relaunch fixes (crash guard, ready state, /clear re-key, small fixes,
// Ultracode button), so that a fix cannot change a behaviour unnoticed. A pin
// named "changed on purpose" records a behaviour one fix is approved to
// change; it carries one comment line that says by which fix and to what.
//
// THE HARNESS (shared by every test in this file)
//
//   const h = boot({ blocks: ['resize'], globals: {}, modules: {} });
//
//   blocks     names from BLOCKS, loaded in the order given, each in a vm
//              context of its own through load(), all against the SAME fakes.
//              What a block declares and BLOCKS lists under `gives` is handed
//              to the blocks after it ('resolve' before 'open'). A new block
//              is added with BLOCKS.<name> = { file, start, end }.
//   globals    more names for the blocks, or other fakes for the ones below.
//   modules    what a block's own require() may ask for (see load()).
//
//   h.window()                 a fake app window, registered. `sent` is every
//                              message it got: [channel, ...args].
//   h.session(id, { owner, ...fields })
//                              a session record like main.js's, stored under
//                              id and owned by that window (or by nobody).
//                              session.pty.calls is every pty call in order:
//                              { op, at, ... }; `at` is the fake clock.
//   h.invoke(channel, from, ...args)   an ipcMain.handle handler; its answer
//   h.emit(channel, from, ...args)     every ipcMain.on listener of a channel
//                              `from` is a fake window, or NO_WINDOW for a
//                              sender that is no app window.
//   h.timers.advance(ms)       the fake clock; runs what falls due, in order
//   h.registry                 the REAL window-registry.js, run over a fake
//                              Electron: owner rules and routing are not faked
//   h.activeSessions, h.log.lines, h.handlers, h.listeners, h.contexts
//
// The blocks get: ipcMain, activeSessions, registry, log, console, the four
// fake timer functions, and for open-terminal's reattach path setMcpWindow and
// panelPaths. A name a block uses that is not given throws a ReferenceError
// with main.js's own line number, so a path a test did not mean to run (a
// spawn, say) fails loudly instead of doing something.
//
// Objects a block makes belong to the block's context: assert on fields, or
// spread first. Messages to windows are copied into this realm by the harness.

const test = require('node:test');
const assert = require('node:assert/strict');

const { cut, load } = require('../test-support/source-cut');
const { peek } = require('../test-support/source-cut');

/** The blocks, each cut by two marker strings that are in the file once. No line numbers. */
const BLOCKS = {
  // The whole of window-registry.js from its one require to the end of the file.
  registry: { file: 'window-registry.js', start: "const { BrowserWindow } = require('electron');", end: null },
  resolve: { file: 'main.js', start: 'function resolveLiveSession(sessionId) {', end: 'registry.init({ log });', gives: ['resolveLiveSession'] },
  stop: { file: 'main.js', start: '// --- IPC: stop-session ---', end: '// --- IPC: toggle-star ---' },
  open: { file: 'main.js', start: '// --- IPC: open-terminal ---', end: "ipcMain.handle('get-window-info', (event) => {" },
  input: { file: 'main.js', start: '// --- IPC: terminal-input (fire-and-forget) ---', end: '// --- IPC: terminal-resize (fire-and-forget) ---' },
  resize: { file: 'main.js', start: '// --- IPC: terminal-resize (fire-and-forget) ---', end: '// --- IPC: close-terminal ---' },
  close: { file: 'main.js', start: '// --- IPC: close-terminal ---', end: "const sessionTransitions = require('./session-transitions');" },
};
// Added by the crash guard (commit C). 'guard' is main.js's own lines that
// make the pty guard; boot() loads it in every boot. 'stopStates' is the
// handler the 3 s running check asks.
BLOCKS.guard = { file: 'main.js', start: '// The pty guard: the one gate for every terminal write, resize and kill', end: '// Shell profiles \u2192 shell-profiles.js' };
BLOCKS.stopStates = { file: 'main.js', start: '// --- IPC: get-stop-states ---', end: '// --- IPC: get-session-owners ---' };

// A block is cut when a test first asks for it, so a marker that no longer
// fits fails the tests of that block and not the whole file.
const cuts = new Map();
function block(name) {
  const spec = BLOCKS[name];
  assert.ok(spec, 'no such block in BLOCKS: ' + name);
  if (!cuts.has(name)) cuts.set(name, cut(spec.file, spec.start, spec.end));
  return cuts.get(name);
}

/** A sender that is no app window (a window that is gone, a helper window). */
const NO_WINDOW = null;

/** A plain copy, made in this realm, of a value a block sent to a window. */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

/** Hand-made timers on a clock that only advance() moves. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  let pending = [];
  const add = (fn, ms, every, args) => {
    const delay = Number(ms) > 0 ? Number(ms) : 0;
    const timer = { id: ++seq, at: now + delay, every: every ? Math.max(1, delay) : 0, fn, args, unref: () => timer, ref: () => timer, hasRef: () => true };
    pending.push(timer);
    return timer;
  };
  const drop = (timer) => { pending = pending.filter((t) => t !== timer && t.id !== timer); };
  return {
    setTimeout: (fn, ms, ...args) => add(fn, ms, false, args),
    setInterval: (fn, ms, ...args) => add(fn, ms, true, args),
    clearTimeout: drop,
    clearInterval: drop,
    get now() { return now; },
    /** How long from now each waiting timer falls due, soonest first. */
    waiting: () => pending.map((t) => t.at - now).sort((a, b) => a - b),
    /** Moves the clock on by ms and runs every timer that falls due, in order. A callback that throws, throws here. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every; else drop(due);
        due.fn(...due.args);
      }
      now = end;
    },
  };
}

function fakeLog() {
  const lines = [];
  const at = (level) => (...args) => { lines.push(level + ' ' + args.map((a) => (a && a.message ? a.message : String(a))).join(' ')); };
  return {
    lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'),
    console: { log: at('console.log'), info: at('console.info'), warn: at('console.warn'), error: at('console.error'), debug: at('console.debug') },
  };
}

function boot({ blocks = [], globals = {}, modules = {} } = {}) {
  const timers = fakeTimers();
  const log = fakeLog();
  const windows = [];
  const activeSessions = new Map();
  const handlers = new Map();  // ipcMain.handle: one per channel, as in Electron
  const listeners = new Map(); // ipcMain.on: any number per channel
  const mcpWindows = [];
  const contexts = {};

  const ipcMain = {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, fn);
    },
    on(channel, fn) { listeners.set(channel, [...(listeners.get(channel) || []), fn]); },
  };

  // The real registry. Only Electron's BrowserWindow is a fake: the three
  // lookups window-registry.js uses, over this boot's own windows. Each boot
  // gets a registry of its own, so its owner table starts empty.
  const BrowserWindow = {
    getAllWindows: () => windows.filter((w) => !w.isDestroyed()),
    fromId: (id) => windows.find((w) => w.id === id) || null,
    fromWebContents: (contents) => windows.find((w) => w.webContents === contents) || null,
  };
  const registryModule = { exports: {} };
  contexts.registry = load(block('registry'), {
    file: BLOCKS.registry.file,
    modules: { electron: { BrowserWindow } },
    globals: { module: registryModule },
  });
  const registry = registryModule.exports;
  registry.init({ log }); // as main.js does right after resolveLiveSession

  // The crash guard's fault list, as a fake that only notes its calls: the real
  // module writes a file and has its own tests (test/main-faults.test.js).
  const mainFaultCalls = [];
  const mainFaults = {
    calls: mainFaultCalls,
    flush(...args) { mainFaultCalls.push(['flush', ...args]); },
    report(...args) { mainFaultCalls.push(['report', ...args]); },
  };

  // The real session-transitions.js, on this boot's list of sessions: the
  // exit code and the stall report ask its keyOf. It is one module for the
  // whole file, so a test finishes with one boot before it makes the next.
  const sessionTransitions = require('../session-transitions');
  sessionTransitions.init({ activeSessions });
  // Everything a block of main.js may name. A fix that makes the handlers
  // name something new (the crash guard's ptyGuard, say) adds it HERE, once.
  const shared = {
    ipcMain, activeSessions, registry, log, console: log.console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    // open-terminal's reattach path
    setMcpWindow: (id, win) => { mcpWindows.push([id, win]); },
    panelPaths: { watchWindow: (win) => win },
    mainFaults,
    sessionTransitions,
    ...globals,
  };
  // The open-terminal block asks for one module by name: a Claude terminal's
  // tag is require('crypto').randomUUID(). A module goes through `modules`,
  // never as a `require` among the globals (that would replace the helper's
  // own require in every block of the boot, the guard block among them).
  modules = { crypto: require('crypto'), ...modules };
  // From the crash guard on, two blocks of main.js are loaded in every boot,
  // before the named ones. 'resolve' (unless the test names it): stop-session
  // asks resolveLiveSession. 'guard': main.js's own lines make the REAL
  // pty-guard.js on this boot's fake timers, with main.js's own stall report.
  if (!blocks.includes('resolve')) {
    contexts.resolve = load(block('resolve'), { file: BLOCKS.resolve.file, globals: shared, modules });
    shared.resolveLiveSession = contexts.resolve.resolveLiveSession;
  }
  contexts.guard = load(block('guard'), { file: BLOCKS.guard.file, globals: shared, modules: { './pty-guard': null, './pty-close': null, ...modules } });
  shared.ptyGuard = peek(contexts.guard, 'ptyGuard');
  for (const name of blocks) {
    assert.notEqual(name, 'registry', 'the registry is always loaded; name only blocks of main.js');
    const context = load(block(name), { file: BLOCKS[name].file, globals: shared, modules });
    for (const given of BLOCKS[name].gives || []) shared[given] = context[given];
    contexts[name] = context;
  }

  const event = (from) => ({ sender: from ? from.webContents : {} });

  const h = {
    timers, log, registry, activeSessions, windows, handlers, listeners, contexts, mcpWindows, globals: shared,

    /** A fake app window, registered with the registry as createWindow does. */
    window() {
      const sent = [];
      let destroyed = false;
      const win = {
        id: windows.length + 1,
        sent,
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
        webContents: { send: (channel, ...args) => { sent.push([channel, ...args.map(plain)]); } },
      };
      windows.push(win);
      registry.register(win);
      return win;
    },

    /**
     * A session record with the fields main.js gives one when it starts a
     * terminal (the "const session = {" of the open-terminal block), stored
     * under id. `owner` is the fake window that shows it; leave it out for a
     * session no window shows. ptyGate.hasOutput is true: nothing reads it
     * before the crash guard, and with the guard it says the terminal has
     * printed, so input and sizes pass as they do today.
     */
    session(id, { owner = null, ...fields } = {}) {
      const calls = [];
      const note = (op, more) => { calls.push({ op, at: timers.now, ...more }); };
      const session = {
        pty: {
          pid: 4242,
          calls,
          write(data) { note('write', { data }); },
          resize(cols, rows) { note('resize', { cols, rows, bufferHeld: session._suppressBuffer === true }); },
          kill() { note('kill', { stopRequested: session.stopRequested === true }); },
        },
        rendererAttached: true, exited: false,
        outputBuffer: [], outputBufferSize: 0, altScreen: false,
        projectPath: 'C:\\proj', firstResize: true,
        isPlainTerminal: false, forkFrom: null, mcpServer: null,
        ptyGate: { hasOutput: true },
        ...fields,
      };
      activeSessions.set(id, session);
      if (owner) registry.setOwner(id, owner.id);
      return session;
    },

    /** Calls the ipcMain.handle handler of a channel and returns its answer (await it). */
    invoke(channel, from, ...args) {
      assert.ok(handlers.has(channel), 'no ipcMain.handle handler for ' + channel);
      return handlers.get(channel)(event(from), ...args);
    },

    /** Calls every ipcMain.on listener of a channel, as one message from the window would. */
    emit(channel, from, ...args) {
      const list = listeners.get(channel) || [];
      assert.ok(list.length > 0, 'no ipcMain.on listener for ' + channel);
      for (const fn of list) fn(event(from), ...args);
    },
  };
  return h;
}

/** A session's pty calls of one kind, in order. */
const ptyCalls = (session, op) => session.pty.calls.filter((c) => c.op === op);
/** [cols, rows, at] of every resize that reached the pty. */
const resizes = (session) => ptyCalls(session, 'resize').map((c) => [c.cols, c.rows, c.at]);
/** The data of every write that reached the pty. */
const writes = (session) => ptyCalls(session, 'write').map((c) => c.data);

// --- Pin 1: stop-session ---

test("main pty wiring (pin): stop-session answers ok false with error 'not running' for an unknown or ended id, marks stopRequested before the kill, kills once, and has no owner rule", async (t) => {
  // Fields of the answer are asserted, never the whole object: the fixes add
  // fields (rekeyedTo, ended) and that must not break this pin.

  await t.test('an id nothing is stored under: ok false, error not running, and nothing is killed or marked', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const live = h.session('s-live', { owner: a });
    for (const id of ['s-nobody', '', undefined]) {
      const answer = await h.invoke('stop-session', a, id);
      assert.equal(answer.ok, false, String(id));
      assert.equal(answer.error, 'not running', String(id));
    }
    assert.deepEqual(live.pty.calls, []);
    assert.notEqual(live.stopRequested, true);
  });

  await t.test('an id the session lived under before a re-key is not followed: not running, nothing killed', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const live = h.session('s-new', { owner: a, realSessionId: 's-new', priorIds: ['s-old'] });
    const answer = await h.invoke('stop-session', a, 's-old');
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'not running');
    assert.deepEqual(live.pty.calls, []);
    assert.notEqual(live.stopRequested, true);
  });

  await t.test('a session that has ended: ok false, error not running, and its pty is not killed', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const ended = h.session('s-ended', { owner: a, exited: true });
    const answer = await h.invoke('stop-session', a, 's-ended');
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'not running');
    assert.deepEqual(ended.pty.calls, []);
  });

  await t.test('a running session: ok true, one kill, and stopRequested is already true when the kill is called', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const live = h.session('s-live', { owner: a });
    const other = h.session('s-other', { owner: a });
    const answer = await h.invoke('stop-session', a, 's-live');
    assert.equal(answer.ok, true);
    assert.equal(ptyCalls(live, 'kill').length, 1, 'killed once');
    assert.equal(ptyCalls(live, 'kill')[0].stopRequested, true, 'marked before the kill, not after');
    assert.equal(live.stopRequested, true);
    // The exact key only: the session next to it is left alone.
    assert.deepEqual(other.pty.calls, []);
    assert.notEqual(other.stopRequested, true);
  });

  await t.test('no owner rule: a window that does not show the session stops it, and so does any window for a session nobody shows', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const b = h.window();
    const shownByA = h.session('s-shown', { owner: a });
    const shownByNobody = h.session('s-unshown');
    assert.equal(h.registry.isOwner('s-shown', b.id), false);
    assert.equal(h.registry.ownerId('s-unshown'), null);
    for (const [id, session] of [['s-shown', shownByA], ['s-unshown', shownByNobody]]) {
      const answer = await h.invoke('stop-session', b, id);
      assert.equal(answer.ok, true, id);
      assert.equal(ptyCalls(session, 'kill').length, 1, id);
      assert.equal(ptyCalls(session, 'kill')[0].stopRequested, true, id);
      assert.equal(session.stopRequested, true, id);
    }
  });

  // The four subtests below were added after the verifier's attack on this
  // pin (a kill that comes later from a timer, a plain terminal, the mark on
  // an ended session, a sender that is no app window).

  await t.test('kills once, seen over time: a minute after the Stop the pty has still had the one kill and nothing else', async () => {
    // "Once" has to hold after the call too. The clock is moved on in two
    // steps, to the 8 s the crash guard will wait for a stop and far past it.
    // Nothing is asserted about waiting timers: with the guard one will wait.
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const live = h.session('s-live', { owner: a });
    const other = h.session('s-other', { owner: a });
    assert.equal((await h.invoke('stop-session', a, 's-live')).ok, true);
    assert.equal(ptyCalls(live, 'kill').length, 1);
    for (const ms of [8000, 52000]) {
      h.timers.advance(ms);
      assert.equal(ptyCalls(live, 'kill').length, 1, 'still one kill at ' + h.timers.now + ' ms');
    }
    assert.equal(live.pty.calls.length, 1, 'nothing but the one kill ever reached the pty');
    assert.deepEqual(other.pty.calls, []);
  });

  await t.test('a plain terminal is stopped as a Claude session is: by its owner, by another window, and when no window shows it', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const b = h.window();
    const cases = [
      ['t-owner', a, h.session('t-owner', { owner: a, isPlainTerminal: true })],
      ['t-other-window', b, h.session('t-other-window', { owner: a, isPlainTerminal: true })],
      ['t-unshown', b, h.session('t-unshown', { isPlainTerminal: true })],
    ];
    for (const [id, from, session] of cases) {
      const answer = await h.invoke('stop-session', from, id);
      assert.equal(answer.ok, true, id);
      assert.equal(answer.error, undefined, id);
      assert.equal(ptyCalls(session, 'kill').length, 1, id);
      assert.equal(ptyCalls(session, 'kill')[0].stopRequested, true, 'marked before the kill: ' + id);
      assert.equal(session.stopRequested, true, id);
    }
    h.timers.advance(60000);
    for (const [id, , session] of cases) assert.equal(session.pty.calls.length, 1, 'one kill and nothing after it: ' + id);
  });

  await t.test('a session that has ended is not marked as stopped: a Claude session or a plain terminal', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const ended = [h.session('s-ended', { owner: a, exited: true }), h.session('t-ended', { owner: a, exited: true, isPlainTerminal: true })];
    for (const id of ['s-ended', 't-ended']) {
      const answer = await h.invoke('stop-session', a, id);
      assert.equal(answer.ok, false, id);
      assert.equal(answer.error, 'not running', id);
    }
    h.timers.advance(60000);
    for (const session of ended) {
      assert.notEqual(session.stopRequested, true, 'the ended session carries no stop mark');
      assert.deepEqual(session.pty.calls, []);
    }
  });

  await t.test('no owner rule: a sender that is no app window stops a session too, shown by a window or not', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    for (const [id, session] of [['s-shown', h.session('s-shown', { owner: a })], ['s-unshown', h.session('s-unshown')]]) {
      const answer = await h.invoke('stop-session', NO_WINDOW, id);
      assert.equal(answer.ok, true, id);
      assert.equal(ptyCalls(session, 'kill').length, 1, id);
      assert.equal(session.stopRequested, true, id);
    }
  });

  // From the recheck round (second reader's R1c, R1m, R1j): the "seen over
  // time" subtest counts kills and never looks at the mark again; the
  // no-window subtest looks at the mark after the call, not at the kill; and
  // nothing looked at the list after a Stop of an ended session.

  await t.test('the stop mark stays: 9 s after the Stop the session is still marked as stopped', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    assert.equal((await h.invoke('stop-session', a, 's1')).ok, true);
    h.timers.advance(9000);
    assert.equal(s.stopRequested, true, 'still marked 9 s after the Stop');
  });

  await t.test('a sender that is no app window: the session is marked before the kill; a Stop of an ended session leaves its record on the list', async () => {
    const h = boot({ blocks: ['stop'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    const ended = h.session('s-ended', { owner: a, exited: true });
    assert.equal((await h.invoke('stop-session', NO_WINDOW, 's1')).ok, true);
    assert.equal(ptyCalls(s, 'kill')[0].stopRequested, true, 'marked before the kill');
    await h.invoke('stop-session', a, 's-ended');
    assert.equal(h.activeSessions.get('s-ended'), ended);
  });
});

// --- Pin 2: terminal-input ---

test('main pty wiring (pin): terminal-input writes once for the owner or an unowned session and nothing for a non-owner, an unknown id or an ended session', async (t) => {
  await t.test('the owner window: each message is one write, the data as it came, in order', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('terminal-input', a, 's1', 'ls -la\r');
    assert.deepEqual(writes(s), ['ls -la\r']);
    h.emit('terminal-input', a, 's1', '\x1b[A');
    h.emit('terminal-input', a, 's1', '\x03');
    assert.deepEqual(writes(s), ['ls -la\r', '\x1b[A', '\x03']);
    assert.equal(s.pty.calls.length, 3, 'nothing but the three writes reached the pty');
  });

  await t.test('a session no window owns: any window may type into it, one write', () => {
    const h = boot({ blocks: ['input'] });
    h.window();
    const b = h.window();
    const s = h.session('s1');
    assert.equal(h.registry.ownerId('s1'), null);
    h.emit('terminal-input', b, 's1', 'echo hi\r');
    assert.deepEqual(writes(s), ['echo hi\r']);
    assert.equal(s.pty.calls.length, 1);
  });

  await t.test('a window that is not the owner, and a sender that is no app window: nothing reaches the pty', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('terminal-input', b, 's1', 'typed in the other window\r');
    h.emit('terminal-input', NO_WINDOW, 's1', 'typed in no window\r');
    assert.deepEqual(s.pty.calls, []);
  });

  await t.test('the rule follows the owner: after the session moved, the old window is dropped and the new one writes', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    h.registry.setOwner('s1', b.id);
    h.emit('terminal-input', a, 's1', 'a key still on its way\r');
    assert.deepEqual(s.pty.calls, []);
    h.emit('terminal-input', b, 's1', 'x');
    assert.deepEqual(writes(s), ['x']);
  });

  await t.test('an id nothing is stored under: nothing is written anywhere and nothing is thrown', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    for (const id of ['s-nobody', '', undefined]) h.emit('terminal-input', a, id, 'lost\r');
    assert.deepEqual(s.pty.calls, []);
  });

  await t.test('a session that has ended: nothing is written, for its owner or for a session nobody owns', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const owned = h.session('s-owned', { owner: a, exited: true });
    const unowned = h.session('s-unowned', { exited: true });
    h.emit('terminal-input', a, 's-owned', 'x');
    h.emit('terminal-input', a, 's-unowned', 'x');
    assert.deepEqual(owned.pty.calls, []);
    assert.deepEqual(unowned.pty.calls, []);
  });

  // The three subtests below were added after the verifier's attack on this
  // pin: until then every session in it was a Claude session, "once" was only
  // looked at inside the call, and no sender without a window typed into a
  // session nobody owns.

  await t.test('a plain terminal follows the same rule: its owner writes once; another window and a sender that is no app window write nothing; an ended one takes nothing', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const b = h.window();
    const owned = h.session('t-owned', { owner: a, isPlainTerminal: true });
    const ended = h.session('t-ended', { owner: a, isPlainTerminal: true, exited: true });
    h.emit('terminal-input', b, 't-owned', 'typed in the other window\r');
    h.emit('terminal-input', NO_WINDOW, 't-owned', 'typed in no window\r');
    assert.deepEqual(owned.pty.calls, [], 'not its owner: nothing');
    h.emit('terminal-input', a, 't-owned', 'dir\r');
    h.emit('terminal-input', a, 't-owned', '\x03');
    assert.deepEqual(writes(owned), ['dir\r', '\x03'], 'its owner: one write per message, as it came');
    assert.equal(owned.pty.calls.length, 2);
    h.emit('terminal-input', a, 't-ended', 'x');
    assert.deepEqual(ended.pty.calls, []);
  });

  await t.test('a plain terminal no window owns: any window may type into it, one write', () => {
    const h = boot({ blocks: ['input'] });
    h.window();
    const b = h.window();
    const unowned = h.session('t-unowned', { isPlainTerminal: true });
    h.emit('terminal-input', b, 't-unowned', 'echo hi\r');
    assert.deepEqual(writes(unowned), ['echo hi\r']);
    assert.equal(unowned.pty.calls.length, 1);
  });

  await t.test('a session nobody owns takes typing from a sender that is no app window as well, and a write is one write a minute later too', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const claude = h.session('s-unowned');
    const plainTerm = h.session('t-unowned', { isPlainTerminal: true });
    const owned = h.session('s-owned', { owner: a });
    h.emit('terminal-input', NO_WINDOW, 's-unowned', 'x');
    h.emit('terminal-input', NO_WINDOW, 't-unowned', 'y');
    h.emit('terminal-input', a, 's-owned', 'z');
    assert.deepEqual(writes(claude), ['x']);
    assert.deepEqual(writes(plainTerm), ['y']);
    assert.deepEqual(writes(owned), ['z']);
    h.timers.advance(60000);
    for (const session of [claude, plainTerm, owned]) assert.equal(session.pty.calls.length, 1, 'the one write and nothing after it');
  });

  // From the recheck round (second reader's R2h): the subtest above has
  // no plain terminal that a window owns.

  await t.test('a plain terminal a window owns: one write, and still one a minute later', () => {
    const h = boot({ blocks: ['input'] });
    const a = h.window();
    const owned = h.session('t-owned', { owner: a, isPlainTerminal: true });
    h.emit('terminal-input', a, 't-owned', 'dir\r');
    h.timers.advance(60000);
    assert.deepEqual(writes(owned), ['dir\r']);
    assert.equal(owned.pty.calls.length, 1);
  });
});

// --- Pin 3: terminal-resize, for a session that has printed ---

test('main pty wiring (pin): terminal-resize keeps the owner rule, the 200 ms buffer hold for a plain terminal, and the first-resize nudge (one column wider at 50 ms, back at 100 ms)', async (t) => {
  // Every session here carries ptyGate.hasOutput = true (h.session's default).

  await t.test('owner rule: a non-owner and a sender that is no app window are ignored whole, and do not use up the nudge', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    const plainTerm = h.session('t1', { owner: a, isPlainTerminal: true });
    for (const from of [b, NO_WINDOW]) {
      h.emit('terminal-resize', from, 's1', 90, 20);
      h.emit('terminal-resize', from, 't1', 90, 20);
    }
    h.timers.advance(1000);
    assert.deepEqual(s.pty.calls, []);
    assert.deepEqual(plainTerm.pty.calls, []);
    assert.notEqual(plainTerm._suppressBuffer, true, 'a refused resize does not start the buffer hold');
    // The owner's first resize after that still gets the whole nudge.
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(1000);
    assert.deepEqual(resizes(s), [[120, 30, 1000], [121, 30, 1050], [120, 30, 1100]]);
  });

  await t.test('owner rule: the owner resizes, and so does any window for a session nobody owns', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const b = h.window();
    const owned = h.session('t-owned', { owner: a, isPlainTerminal: true });
    const unowned = h.session('t-unowned', { isPlainTerminal: true });
    h.emit('terminal-resize', a, 't-owned', 100, 40);
    h.emit('terminal-resize', b, 't-unowned', 101, 41);
    assert.deepEqual(resizes(owned), [[100, 40, 0]]);
    assert.deepEqual(resizes(unowned), [[101, 41, 0]]);
  });

  await t.test('an id nothing is stored under, and a session that has ended: no resize, no hold, no nudge, nothing thrown', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const live = h.session('s1', { owner: a });
    const ended = h.session('s-ended', { owner: a, exited: true });
    const endedPlain = h.session('t-ended', { owner: a, exited: true, isPlainTerminal: true });
    const endedUnowned = h.session('s-ended-unowned', { exited: true });
    for (const id of ['s-nobody', '', undefined, 's-ended', 't-ended', 's-ended-unowned']) h.emit('terminal-resize', a, id, 80, 24);
    h.timers.advance(1000);
    for (const session of [live, ended, endedPlain, endedUnowned]) assert.deepEqual(session.pty.calls, []);
    assert.notEqual(endedPlain._suppressBuffer, true);
  });

  await t.test('a plain terminal: the buffer hold is on when the pty is resized and comes off 200 ms after the call; no nudge', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const s = h.session('t1', { owner: a, isPlainTerminal: true });
    assert.equal(s.firstResize, true, 'as main.js makes the record: the nudge flag is set, also for a plain terminal');
    h.emit('terminal-resize', a, 't1', 100, 40);
    assert.deepEqual(resizes(s), [[100, 40, 0]], 'the size reached the pty inside the call');
    assert.equal(ptyCalls(s, 'resize')[0].bufferHeld, true, 'the hold was set before the resize, not after');
    assert.equal(s._suppressBuffer, true);
    h.timers.advance(199);
    assert.equal(s._suppressBuffer, true, 'still held at 199 ms');
    h.timers.advance(1);
    assert.equal(s._suppressBuffer, false, 'released at 200 ms');
    h.timers.advance(1000);
    assert.deepEqual(resizes(s), [[100, 40, 0]], 'a plain terminal gets no nudge');
  });

  await t.test('a plain terminal: every resize starts a 200 ms of its own and the first to run ends the hold', () => {
    // Today's rule as it is: no timer is cancelled, so a second resize 150 ms
    // after the first is held for 50 ms, not 200.
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const s = h.session('t1', { owner: a, isPlainTerminal: true });
    h.emit('terminal-resize', a, 't1', 100, 40);
    h.timers.advance(150);
    h.emit('terminal-resize', a, 't1', 110, 40);
    assert.deepEqual(ptyCalls(s, 'resize').map((c) => [c.cols, c.at, c.bufferHeld]), [[100, 0, true], [110, 150, true]]);
    h.timers.advance(49);
    assert.equal(s._suppressBuffer, true, 'held at 199 ms');
    h.timers.advance(1);
    assert.equal(s._suppressBuffer, false, 'the first call\'s 200 ms ended the hold');
    h.timers.advance(1000);
    assert.equal(s._suppressBuffer, false);
    assert.equal(s.pty.calls.length, 2);
  });

  await t.test('a Claude session: no buffer hold at any time', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('terminal-resize', a, 's1', 120, 30);
    assert.notEqual(s._suppressBuffer, true);
    h.timers.advance(1000);
    assert.notEqual(s._suppressBuffer, true);
    assert.ok(ptyCalls(s, 'resize').length >= 1, 'the pty was resized');
    assert.deepEqual(ptyCalls(s, 'resize').filter((c) => c.bufferHeld), [], 'no resize of it ran under a hold');
  });

  await t.test('a Claude session, first resize: the size at once, one column wider at 50 ms, back at 100 ms, and only once', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('terminal-resize', a, 's1', 120, 30);
    assert.deepEqual(resizes(s), [[120, 30, 0]]);
    h.timers.advance(49);
    assert.deepEqual(resizes(s), [[120, 30, 0]], 'nothing more at 49 ms');
    h.timers.advance(1);
    assert.deepEqual(resizes(s), [[120, 30, 0], [121, 30, 50]], 'one column wider at 50 ms');
    h.timers.advance(49);
    assert.equal(resizes(s).length, 2, 'nothing more at 99 ms');
    h.timers.advance(1);
    assert.deepEqual(resizes(s), [[120, 30, 0], [121, 30, 50], [120, 30, 100]], 'back at 100 ms');
    h.timers.advance(1000);
    assert.equal(s.pty.calls.length, 3, 'three resizes and nothing else');
    // The nudge is used up: the next resize is the size alone.
    h.emit('terminal-resize', a, 's1', 100, 25);
    h.timers.advance(1000);
    assert.deepEqual(resizes(s).slice(3), [[100, 25, 1100]]);
  });

  await t.test('a second resize inside the 100 ms gets no nudge of its own, and the nudge ends on the first resize\'s size', () => {
    // Today's rule as it is: the two nudge steps carry the cols and rows of
    // the call that started them, so the pty ends on 120 x 30 although the
    // window last asked for 90 x 20.
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(10);
    h.emit('terminal-resize', a, 's1', 90, 20);
    h.timers.advance(1000);
    assert.deepEqual(resizes(s), [[120, 30, 0], [90, 20, 10], [121, 30, 50], [120, 30, 100]]);
  });

  await t.test('a pty that throws in either nudge step throws nothing out of the timer', () => {
    for (const failing of [2, 3]) {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = h.session('s1', { owner: a });
      const record = s.pty.resize;
      s.pty.resize = (cols, rows) => {
        record(cols, rows);
        if (s.pty.calls.length === failing) throw new Error('the pty is closed');
      };
      h.emit('terminal-resize', a, 's1', 120, 30);
      assert.doesNotThrow(() => h.timers.advance(1000), 'resize number ' + failing);
      assert.ok(s.pty.calls.length >= failing, 'the failing step was reached: resize number ' + failing);
    }
  });

  await t.test('the re-arm: a reattach gives a Claude session its nudge again, for the window that now owns it', async () => {
    const h = boot({ blocks: ['resolve', 'open', 'resize'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(1000);
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(1000);
    assert.equal(s.pty.calls.length, 4, 'the first resize with its nudge, then one without');

    // Window b opens the running session: the reattach path, never a spawn
    // (no pty and no fs is given to the block, so a spawn would throw).
    const answer = await h.invoke('open-terminal', b, 's1', 'C:\\proj', false, undefined);
    assert.equal(answer.ok, true);
    assert.equal(answer.reattached, true);
    assert.equal(h.registry.ownerId('s1'), b.id);

    h.emit('terminal-resize', a, 's1', 70, 20); // the window it left
    h.timers.advance(1000);
    assert.equal(s.pty.calls.length, 4, 'the old window no longer resizes, and does not use up the new nudge');
    h.emit('terminal-resize', b, 's1', 140, 50);
    h.timers.advance(1000);
    assert.deepEqual(resizes(s).slice(4), [[140, 50, 3000], [141, 50, 3050], [140, 50, 3100]]);
  });

  await t.test('the re-arm: a reattached plain terminal still gets no nudge, and its hold is as before', async () => {
    const h = boot({ blocks: ['resolve', 'open', 'resize'] });
    const a = h.window();
    const s = h.session('t1', { owner: a, isPlainTerminal: true });
    const answer = await h.invoke('open-terminal', a, 't1', 'C:\\proj', false, { type: 'terminal' });
    assert.equal(answer.reattached, true);
    h.emit('terminal-resize', a, 't1', 100, 40);
    assert.equal(s._suppressBuffer, true);
    h.timers.advance(200);
    assert.equal(s._suppressBuffer, false);
    h.timers.advance(1000);
    assert.deepEqual(resizes(s), [[100, 40, 0]]);
  });

  // The three subtests below were added after the verifier's attack on this
  // pin. Until then the hold was pinned as a flag only, for one resize of a
  // terminal a window owns. Here the terminals are started through the
  // open-terminal handler, so the output callback that reads the flag is
  // main.js's own. Each prints once before its first resize, so it is a
  // session that has printed. A record made by main.js carries no
  // ptyGate.hasOutput = true of the test's making, so these subtests assert
  // the hold and the replay buffer only, and nothing about when a size
  // reaches the pty: the hand-made records above hold that.

  await t.test('what the hold is for: what a plain terminal prints in the 200 ms after a resize reaches its window and is kept out of the replay buffer; after that it is kept again', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'resize'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.equal(session.isPlainTerminal, true);
    const shown = () => got(a, 'terminal-data').map((m) => m[2]);

    proc.emitData('$ ');
    assert.deepEqual([...session.outputBuffer], ['$ '], 'before any resize, output is kept for a replay');
    h.emit('terminal-resize', a, 't1', 100, 40);
    proc.emitData('redraw at 0 ms');
    h.timers.advance(199);
    proc.emitData('redraw at 199 ms');
    assert.deepEqual([...session.outputBuffer], ['$ '], 'output inside the hold is not kept for a replay');
    assert.equal(session.outputBufferSize, '$ '.length, 'and is not counted');
    assert.deepEqual(shown(), ['$ ', 'redraw at 0 ms', 'redraw at 199 ms'], 'but the window still gets it');
    h.timers.advance(1);
    proc.emitData('kept');
    assert.deepEqual([...session.outputBuffer], ['$ ', 'kept'], 'from 200 ms on, output is kept again');
    assert.equal(session.outputBufferSize, '$ '.length + 'kept'.length);
    assert.deepEqual(shown(), ['$ ', 'redraw at 0 ms', 'redraw at 199 ms', 'kept']);

    // A Claude session has no hold: what it prints right after a resize is kept.
    const claude = await start(h, env, a, 's1');
    claude.proc.emitData('frame 1');
    h.emit('terminal-resize', a, 's1', 120, 30);
    claude.proc.emitData('frame 2');
    assert.deepEqual([...claude.session.outputBuffer], ['frame 1', 'frame 2']);
  });

  await t.test('a plain terminal: a resize that comes after an earlier hold has ended gets a hold of its own, released 200 ms after it, every time', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'resize'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    proc.emitData('a');
    h.emit('terminal-resize', a, 't1', 100, 40);
    h.timers.advance(200);
    assert.equal(session._suppressBuffer, false, 'the first hold ended');

    const kept = ['a'];
    for (const [wait, cols, mark] of [[1000, 110, 'b'], [5000, 120, 'c']]) {
      h.timers.advance(wait);
      h.emit('terminal-resize', a, 't1', cols, 40);
      assert.equal(session._suppressBuffer, true, 'held again at ' + cols + ' columns');
      proc.emitData('redraw ' + cols);
      h.timers.advance(199);
      assert.equal(session._suppressBuffer, true, 'still held 199 ms after the resize to ' + cols);
      h.timers.advance(1);
      assert.equal(session._suppressBuffer, false, 'released 200 ms after the resize to ' + cols);
      proc.emitData(mark);
      kept.push(mark);
      assert.deepEqual([...session.outputBuffer], kept, 'and its output is kept for a replay again');
    }
  });

  await t.test('a plain terminal no window owns, and one whose window let go inside the 200 ms: the hold is released all the same', () => {
    const h = boot({ blocks: ['resize'] });
    const a = h.window();
    const unowned = h.session('t-unowned', { isPlainTerminal: true });
    const letGo = h.session('t-let-go', { owner: a, isPlainTerminal: true });
    assert.equal(h.registry.ownerId('t-unowned'), null);
    h.emit('terminal-resize', a, 't-unowned', 90, 30);
    h.emit('terminal-resize', a, 't-let-go', 90, 30);
    assert.equal(unowned._suppressBuffer, true);
    assert.equal(letGo._suppressBuffer, true);
    h.registry.clearOwner('t-let-go');
    h.timers.advance(199);
    assert.equal(unowned._suppressBuffer, true);
    assert.equal(letGo._suppressBuffer, true);
    h.timers.advance(1);
    assert.equal(unowned._suppressBuffer, false, 'released for a terminal no window owns');
    assert.equal(letGo._suppressBuffer, false, 'released for a terminal whose owner went away during the hold');
  });

  // From the recheck round (second reader's R3i, R3j, R3l): the subtest
  // above lets the window go by hand (registry.clearOwner). Here the view is
  // closed through the close-terminal handler, which detaches the record too;
  // a window is destroyed inside the 200 ms; and a terminal nobody owns is
  // resized by a sender that is no app window.

  await t.test('the hold is released all the same when the view is closed through close-terminal inside the 200 ms, when the window that asked is gone, and when the sender was no app window', () => {
    const h = boot({ blocks: ['resize', 'close'] });
    const a = h.window();
    const b = h.window();
    const closed = h.session('t-closed', { owner: a, isPlainTerminal: true });
    const windowGone = h.session('t-window-gone', { owner: b, isPlainTerminal: true });
    const noWindow = h.session('t-no-window', { isPlainTerminal: true });
    h.emit('terminal-resize', a, 't-closed', 90, 30);
    h.emit('terminal-resize', b, 't-window-gone', 90, 30);
    h.emit('terminal-resize', NO_WINDOW, 't-no-window', 90, 30);
    for (const session of [closed, windowGone, noWindow]) assert.equal(session._suppressBuffer, true);
    h.emit('close-terminal', a, 't-closed');
    assert.equal(closed.rendererAttached, false, 'the real close detaches');
    b.destroy();
    h.timers.advance(200);
    assert.equal(closed._suppressBuffer, false, 'view closed inside the hold');
    assert.equal(windowGone._suppressBuffer, false, 'window gone inside the hold');
    assert.equal(noWindow._suppressBuffer, false, 'asked by a sender that is no app window');
  });
});

// --- Pin 4: terminal-resize, for a session that has printed nothing yet ---

// PIN 4, changed on purpose by the crash guard. Formerly: "main pty wiring (pin, changed on purpose by the crash guard): a resize before the first output is passed to the pty at once, and a plain terminal's buffer hold runs 200 ms from the call". Nothing reaches the pty until the first output, then the last size once; the buffer hold is unchanged and is not set again when the held size is applied.
test("main pty wiring (pin, changed by the crash guard): a resize before the first output is held and reaches the pty once after it, with the last size, and a plain terminal's buffer hold runs 200 ms from the call", async (t) => {
  // Two shapes of "has printed nothing yet": the record as main.js makes it
  // today, which has no ptyGate at all, and one that says so in ptyGate.
  const NOT_YET = [
    ['no ptyGate on the record', (session) => { delete session.ptyGate; }],
    ['ptyGate.hasOutput is false', (session) => { session.ptyGate = { hasOutput: false }; }],
  ];

  for (const [shape, makeSilent] of NOT_YET) {
    const silent = (h, id, fields) => {
      const session = h.session(id, fields);
      makeSilent(session);
      assert.deepEqual(session.outputBuffer, [], 'nothing printed');
      return session;
    };

    await t.test(`${shape}: a Claude session's resize does not reach the pty before the first output`, () => {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = silent(h, 's1', { owner: a });
      h.emit('terminal-resize', a, 's1', 120, 30);
      assert.deepEqual(s.pty.calls, [], 'held by the guard');
    });

    await t.test(`${shape}: a Claude session's two nudge resizes do not reach the pty either, with still no output`, () => {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = silent(h, 's1', { owner: a });
      h.emit('terminal-resize', a, 's1', 120, 30);
      h.timers.advance(1000);
      assert.deepEqual(s.pty.calls, []);
      assert.equal(s.firstResize, false, 'the nudge is used up as today');
    });

    await t.test(`${shape}: a plain terminal's resize does not reach the pty before the first output, and the buffer hold still runs 200 ms from the call`, () => {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = silent(h, 't1', { owner: a, isPlainTerminal: true });
      h.emit('terminal-resize', a, 't1', 100, 40);
      assert.deepEqual(s.pty.calls, [], 'held by the guard');
      assert.equal(s._suppressBuffer, true, 'the hold is set at the call, whatever the guard answers');
      h.timers.advance(199);
      assert.equal(s._suppressBuffer, true, 'still held at 199 ms');
      h.timers.advance(1);
      assert.equal(s._suppressBuffer, false, 'released 200 ms after the call, with no output in between');
      h.timers.advance(1000);
      assert.deepEqual(s.pty.calls, []);
    });
  }

  // Added after the verifier's attack: the subtests above see the hold as a
  // flag only. This one sees what it does to the replay buffer. It is NOT one
  // of the assertions the crash guard changes: the design keeps the hold
  // "exactly as today" (set at the call, cleared 200 ms later), so it asserts
  // nothing about when the size reaches the pty.
  await t.test('holds before and after the crash guard: a plain terminal resized before its first output keeps what it prints in the 200 ms after the call out of the replay buffer, and keeps what comes later', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'resize'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.deepEqual([...session.outputBuffer], [], 'nothing printed yet');
    h.emit('terminal-resize', a, 't1', 100, 40);
    h.timers.advance(100);
    proc.emitData('first words');
    assert.deepEqual([...session.outputBuffer], [], 'the first output came inside the hold: not kept for a replay');
    assert.deepEqual(got(a, 'terminal-data').map((m) => m[2]), ['first words'], 'the window gets it');
    h.timers.advance(99);
    proc.emitData('at 199 ms');
    assert.deepEqual([...session.outputBuffer], []);
    h.timers.advance(1);
    proc.emitData('later');
    assert.deepEqual([...session.outputBuffer], ['later'], '200 ms after the call the hold is over, with or without output in between');
  });

  // Added in the recheck round (second reader's R4a): the subtest above has its
  // first output INSIDE the hold of the call, so a second hold that opens when
  // the first output comes ends at the same 200 ms and nothing differs. Here
  // the first output comes after the hold is over. The design withdrew the
  // second hold ("would have dropped a plain terminal's first 200 ms of output
  // from the replay buffer"), and the approved text says the hold "is not set
  // again when the held size is applied". Like the subtest above, it asserts
  // nothing about when the size reaches the pty.
  await t.test('a plain terminal resized before its first output, whose first output comes after the 200 ms, keeps that first output for a replay: the first output starts no hold of its own', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'resize'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    h.emit('terminal-resize', a, 't1', 100, 40);
    h.timers.advance(250);
    assert.equal(session._suppressBuffer, false, 'the hold of the call is over');
    proc.emitData('$ ');
    assert.deepEqual([...session.outputBuffer], ['$ '], 'the first output is kept for a replay');
    assert.notEqual(session._suppressBuffer, true, 'and it starts no hold of its own');
    h.timers.advance(50);
    proc.emitData('ls');
    assert.deepEqual([...session.outputBuffer], ['$ ', 'ls'], 'the next output is kept too');
    h.timers.advance(1000);
    proc.emitData('more');
    assert.deepEqual([...session.outputBuffer], ['$ ', 'ls', 'more']);
  });

  // Added by the crash guard (commit C): what happens AFTER the first output.
  // The terminals are started through the handler, so the output callback
  // that tells the guard is main.js's own (design acceptance, "new test").
  await t.test('a plain terminal started through the handler: three sizes before its first output reach the pty as one resize with the last size, one 0 ms step after the first output, and the buffer hold is not set at that moment', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'resize'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    const heldAtResize = [];
    const record = proc.resize;
    proc.resize = (cols, rows) => { heldAtResize.push(session._suppressBuffer === true); record(cols, rows); };
    for (const [cols, rows] of [[90, 20], [100, 30], [110, 40]]) h.emit('terminal-resize', a, 't1', cols, rows);
    h.timers.advance(250);
    assert.deepEqual(ptyCalls(session, 'resize'), [], 'nothing reached the pty before the first output');
    assert.equal(session._suppressBuffer, false, 'the hold of the calls is over');
    proc.emitData('$ ');
    assert.deepEqual(ptyCalls(session, 'resize'), [], 'the first output alone applies nothing');
    h.timers.advance(0);
    assert.deepEqual(ptyCalls(session, 'resize'), [{ op: 'resize', cols: 110, rows: 40 }], 'the last size, once');
    assert.deepEqual(heldAtResize, [false], 'no buffer hold when the held size is applied');
    assert.notEqual(session._suppressBuffer, true);
    assert.deepEqual([...session.outputBuffer], ['$ ']);
    proc.emitData('more');
    h.timers.advance(1000);
    assert.equal(ptyCalls(session, 'resize').length, 1, 'later output applies nothing');
    h.emit('terminal-resize', a, 't1', 120, 50);
    assert.deepEqual(ptyCalls(session, 'resize')[1], { op: 'resize', cols: 120, rows: 50 }, 'from then on a size reaches the pty inside the call');
    assert.deepEqual(heldAtResize, [false, true], 'under the hold of its own call, as today');
  });

  await t.test('a Claude session started through the handler: the size and both nudge steps are held, and the first output applies one resize with the size of the call', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'resize'], globals: env.globals });
    const a = h.window();
    const { proc } = await start(h, env, a, 's1');
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(1000);
    assert.deepEqual(proc.calls, [], 'the size and both nudge steps were held');
    proc.emitData('frame');
    assert.deepEqual(proc.calls, []);
    h.timers.advance(0);
    assert.deepEqual(proc.calls, [{ op: 'resize', cols: 120, rows: 30 }]);
  });
});

// --- Pin 5: close-terminal ---

test("main pty wiring (pin): close-terminal detaches and broadcasts only for the owner's close and forgets an ended session", async (t) => {
  const RELEASED = (sessionId) => [['session-owner-changed', { sessionId, windowId: null }]];

  await t.test('the owner closes a running session: detached, no owner, every window is told once, and the session runs on', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('close-terminal', a, 's1');
    assert.equal(s.rendererAttached, false);
    assert.equal(h.registry.ownerId('s1'), null);
    assert.deepEqual(a.sent, RELEASED('s1'));
    assert.deepEqual(b.sent, RELEASED('s1'));
    assert.equal(h.activeSessions.get('s1'), s, 'a running session is kept');
    assert.deepEqual(s.pty.calls, [], 'a close is not a stop: the pty is not touched');
    assert.notEqual(s.stopRequested, true);
  });

  await t.test('a window that is not the owner closes it: nothing changes and no window is told', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('close-terminal', b, 's1');
    assert.equal(s.rendererAttached, true);
    assert.equal(h.registry.ownerId('s1'), a.id);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(b.sent, []);
    assert.equal(h.activeSessions.get('s1'), s);
    assert.deepEqual(s.pty.calls, []);
  });

  await t.test('a session nobody owns: a close detaches nothing and tells no window', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const s = h.session('s1'); // rendererAttached true, as after its window was closed
    h.emit('close-terminal', a, 's1');
    assert.equal(s.rendererAttached, true);
    assert.deepEqual(a.sent, []);
    assert.equal(h.activeSessions.get('s1'), s);
  });

  await t.test('an ended session is forgotten: by its owner\'s close, with the detach and the broadcast', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a, exited: true });
    const running = h.session('s2', { owner: a });
    h.emit('close-terminal', a, 's1');
    assert.equal(h.activeSessions.has('s1'), false);
    assert.equal(s.rendererAttached, false);
    assert.equal(h.registry.ownerId('s1'), null);
    assert.deepEqual(a.sent, RELEASED('s1'));
    assert.deepEqual(b.sent, RELEASED('s1'));
    // Only that one.
    assert.equal(h.activeSessions.get('s2'), running);
    assert.equal(h.registry.ownerId('s2'), a.id);
    assert.equal(running.rendererAttached, true);
  });

  await t.test('an ended session is forgotten by a non-owner\'s close too, but without detach or broadcast, and its owner entry stays', () => {
    // Today's rule as it is: the forget is not inside the owner check.
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a, exited: true });
    h.emit('close-terminal', b, 's1');
    assert.equal(h.activeSessions.has('s1'), false);
    assert.equal(s.rendererAttached, true);
    assert.equal(h.registry.ownerId('s1'), a.id);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(b.sent, []);
  });

  await t.test('an id with an owner but no session record: the owner\'s close clears the owner and tells every window', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    h.registry.setOwner('s-gone', a.id);
    h.emit('close-terminal', b, 's-gone');
    assert.equal(h.registry.ownerId('s-gone'), a.id, 'not for a non-owner');
    assert.deepEqual(b.sent, []);
    h.emit('close-terminal', a, 's-gone');
    assert.equal(h.registry.ownerId('s-gone'), null);
    assert.deepEqual(a.sent, RELEASED('s-gone'));
    assert.deepEqual(b.sent, RELEASED('s-gone'));
  });

  await t.test('an id nothing is stored under and nobody owns: nothing happens and nothing is thrown', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const s = h.session('s1', { owner: a });
    for (const id of ['s-nobody', '', undefined]) h.emit('close-terminal', a, id);
    assert.deepEqual(a.sent, []);
    assert.equal(s.rendererAttached, true);
    assert.equal(h.registry.ownerId('s1'), a.id);
    assert.equal(h.activeSessions.size, 1);
  });

  await t.test('today: a close whose sender is no app window is not owner-checked, and detaches a session another window shows', () => {
    // Not what the pin's name says ("only for the owner's close"), and pinned
    // as the code is: the handler hands the registry a window id of null, and
    // the registry reads null as "no owner check" (clearOwner's default).
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a });
    h.emit('close-terminal', NO_WINDOW, 's1');
    assert.equal(s.rendererAttached, false);
    assert.equal(h.registry.ownerId('s1'), null);
    assert.deepEqual(a.sent, RELEASED('s1'));
    assert.deepEqual(b.sent, RELEASED('s1'));
    assert.equal(h.activeSessions.get('s1'), s);
  });

  // Added after the verifier's attack: no subtest above looked at the pty of
  // an ended session, closed a plain terminal, or closed a session whose Stop
  // was already sent.
  await t.test('a close is never a stop: no pty is touched and no stop mark is set or used, for an ended session, a plain terminal, or a session whose Stop was sent and that has not ended', () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const endedByOwner = h.session('s-ended', { owner: a, exited: true });
    const endedByOther = h.session('s-ended-2', { owner: a, exited: true });
    const plainTerm = h.session('t1', { owner: a, isPlainTerminal: true });
    const stopping = h.session('s-stopping', { owner: a, stopRequested: true });
    h.emit('close-terminal', a, 's-ended');
    h.emit('close-terminal', b, 's-ended-2');
    h.emit('close-terminal', a, 't1');
    h.emit('close-terminal', a, 's-stopping');
    h.timers.advance(60000);
    for (const session of [endedByOwner, endedByOther, plainTerm, stopping]) assert.deepEqual(session.pty.calls, [], 'no call on any pty, then or later');
    assert.notEqual(endedByOwner.stopRequested, true);
    assert.notEqual(endedByOther.stopRequested, true);

    // The plain terminal: detached like a Claude session, kept, not marked.
    assert.equal(h.activeSessions.get('t1'), plainTerm);
    assert.equal(plainTerm.rendererAttached, false);
    assert.equal(h.registry.ownerId('t1'), null);
    assert.notEqual(plainTerm.stopRequested, true, 'a close does not mark a plain terminal as stopped');

    // Stop sent, not ended yet: the record stays until the exit code removes it.
    assert.equal(h.activeSessions.get('s-stopping'), stopping, 'not ended, so not forgotten');
    assert.equal(stopping.rendererAttached, false);
    assert.equal(stopping.stopRequested, true, 'the mark the Stop set is left as it was');
    assert.equal(h.registry.ownerId('s-stopping'), null);
  });

  // From the recheck round (second reader's R5d, R5e): the subtest above
  // closes the plain terminal and the session whose Stop was sent by their
  // owner only.

  await t.test("a non-owner's close changes nothing for a plain terminal or for a session whose Stop was sent", () => {
    const h = boot({ blocks: ['close'] });
    const a = h.window();
    const b = h.window();
    const plainTerm = h.session('t1', { owner: a, isPlainTerminal: true });
    const stopping = h.session('s-stopping', { owner: a, stopRequested: true });
    h.emit('close-terminal', b, 't1');
    h.emit('close-terminal', b, 's-stopping');
    assert.equal(plainTerm.rendererAttached, true);
    assert.equal(stopping.rendererAttached, true);
    assert.equal(h.activeSessions.get('t1'), plainTerm);
    assert.equal(h.activeSessions.get('s-stopping'), stopping);
    assert.equal(h.registry.ownerId('t1'), a.id);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(b.sent, []);
  });
});

// =====================================================================
// Pins 6 to 10: the exit report, delete-track, before-quit, reattach, adopt
// =====================================================================
//
// Added below pins 1 to 5; no line above this one was changed. Three more
// blocks go into BLOCKS here, and the helpers these five pins share follow:
//
//   spawnFakes()          everything the open-terminal block names on its way
//                         to a NEW terminal, as boot() globals. Nothing real
//                         starts: pty.spawn hands back a fake process.
//   start(h, env, win, id, { isNew, options })
//                         starts one through the handler: { session, proc }.
//                         The record is the one main.js made, and proc.emitExit
//                         and proc.emitData call back as node-pty would.
//   rekeyByHand(h, oldId, newId)   what a re-key does to main's books today
//   got(win, channel, from)        a window's messages of one channel

// main.js's wrapper of the project handlers: it awaits the handler and turns
// a throw into { error }. delete-track is registered through it.
BLOCKS.guarded = { file: 'main.js', start: 'function guarded(fn) {', end: "ipcMain.handle('get-project-tree', guarded((showArchived) => {", gives: ['guarded'] };
BLOCKS.deleteTrack = { file: 'main.js', start: "ipcMain.handle('delete-track', guarded((id, options = {}) => {", end: "ipcMain.handle('get-projects-root'" };
// The two markers test/main-token-wiring.test.js cuts the same block by.
BLOCKS.beforeQuit = { file: 'main.js', start: "app.on('before-quit', () => {", end: "app.on('will-quit', () => {" };

/** The project folder every terminal of these pins is opened in. */
const PROJECT = 'C:\\proj';

/** A window's messages of one channel, from message number `from` on. */
const got = (win, channel, from = 0) => win.sent.slice(from).filter((m) => m[0] === channel);

/**
 * Fakes for the spawn path of the open-terminal block.
 *   globals        hand to boot({ globals })
 *   spawned        every process pty.spawn started, in order. Each has calls
 *                  ([{ op, ... }], read with ptyCalls like h.session's pty),
 *                  emitData(text) and emitExit({ exitCode, signal }).
 *   mcpStarted     the ids an MCP server was started for
 *   mcpShutdowns   the ids shutdownMcpServer was called with
 * A kill does not end the fake process by itself: the test says when it ends.
 */
function spawnFakes() {
  const spawned = [];
  const mcpStarted = [];
  const mcpShutdowns = [];
  const pty = {
    spawn(shell, args, options) {
      const calls = [];
      const onData = [];
      const onExit = [];
      const proc = {
        pid: 5000 + spawned.length, shell, args, options, calls, _isDisposed: false,
        onData(fn) { onData.push(fn); },
        onExit(fn) { onExit.push(fn); },
        write(data) { calls.push({ op: 'write', data }); },
        resize(cols, rows) { calls.push({ op: 'resize', cols, rows }); },
        kill() { calls.push({ op: 'kill' }); },
        emitData(data) { for (const fn of onData) fn(data); },
        emitExit(exit) { for (const fn of onExit) fn(exit); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const globals = {
    pty,
    // The project folder is there; it has no transcript folder and no transcript.
    fs: {
      existsSync: (p) => p === PROJECT,
      readdirSync: () => [],
      readFileSync: () => { throw new Error('ENOENT: no transcript in this test'); },
    },
    path: require('path'),
    os: { homedir: () => 'C:\\home' },
    PROJECTS_DIR: 'C:\\nowhere\\projects',
    MAX_BUFFER_SIZE: 256 * 1024,
    cleanPtyEnv: {},
    TERMINAL_IDENTITY_ENV: require('../pty-env').TERMINAL_IDENTITY_ENV,
    ...require('../launch-plan'),
    LAUNCH_HOST: { platform: 'linux', fs: null, gitBash: null },
    getMeta: () => null,
    getCachedSession: () => ({}),
    projects: {},
    effectiveShellProfileId: () => 'auto',
    resolveShell: () => ({ id: 'auto', path: 'fake-shell', args: [] }),
    isWslShell: () => false,
    windowsToWslPath: (p) => p,
    encodeProjectPath: (p) => String(p).replace(/[^A-Za-z0-9]/g, '-'),
    shellArgs: (shell, command, extra) => [...extra, ...(command ? ['-c', command] : [])],
    quoteArgvForShell: (shell, argv) => argv.join(' '),
    claudeHarness: { binary: 'claude', buildLaunchArgs: ({ sessionId }) => ['--session-id', sessionId], parseTitleState: () => null },
    startMcpServer: async (id) => { mcpStarted.push(id); return { port: 4000 + mcpStarted.length }; },
    shutdownMcpServer: (id) => { mcpShutdowns.push(id); },
  };
  return { globals, spawned, mcpStarted, mcpShutdowns };
}

/**
 * Starts a terminal through the open-terminal handler: the record is made by
 * main.js, and so are its output callback and its exit code. A Claude session
 * unless options say { type: 'terminal' }. Returns { session, proc }.
 */
async function start(h, env, win, id, { isNew = true, options } = {}) {
  const before = env.spawned.length;
  const answer = await h.invoke('open-terminal', win, id, PROJECT, isNew, options);
  assert.equal(answer.ok, true, 'the terminal started' + (answer.error ? ': ' + answer.error : ''));
  assert.equal(answer.reattached, false);
  assert.equal(env.spawned.length, before + 1, 'one process was started');
  const session = h.activeSessions.get(id);
  const proc = env.spawned[before];
  assert.equal(session.pty, proc);
  return { session, proc };
}

/**
 * What a re-key does to main's books today (session-transitions.js, the
 * "if (matched) {" block): the record remembers the old id and moves to the
 * new key, the old key is deleted, and the owner follows. Done by hand: the
 * detector needs a transcript folder on disk and has tests of its own.
 */
function rekeyByHand(h, oldId, newId) {
  const session = h.activeSessions.get(oldId);
  assert.ok(session, 'nothing is stored under ' + oldId);
  session.realSessionId = newId;
  session.priorIds = [...(session.priorIds || []), oldId];
  h.activeSessions.delete(oldId);
  h.activeSessions.set(newId, session);
  h.registry.rekeyOwner(oldId, newId);
  return session;
}

// --- Pin 6: the exit report ---

// PIN 6, changed on purpose by the crash guard. Formerly: "main pty wiring (pin, second case changed on purpose by the crash guard): the exit report goes to every window with the stop flag under the live id and the record and owner are cleared; today, when another live terminal is stored under the first id, it is reported ended, removed and un-owned as well". Its second case changed: another live terminal stored under the first id now stays in the list with its owner and gets no exit report; the first id is reported and cleared only while it still points at the terminal that ended.
test('main pty wiring (pin, second case changed by the crash guard): the exit report goes to every window with the stop flag under the live id and the record and owner are cleared; another live terminal stored under the first id stays in the list with its owner and gets no exit report', async (t) => {
  // FIRST CASE. It holds before and after the crash guard. Only the
  // process-exited messages are compared, so a fix may send something else at
  // an exit; how many reports there are, and what each carries, is exact.

  await t.test('a session that ends by itself: every window gets one process-exited with the id, the exit code, the signal and the stop flag false', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { proc } = await start(h, env, a, 's1');
    const from = [a.sent.length, b.sent.length];
    proc.emitExit({ exitCode: 137, signal: 9 });
    // The window that shows it and the one that does not: the same report.
    // The flag is the boolean false, not a missing value.
    assert.deepEqual(got(a, 'process-exited', from[0]), [['process-exited', 's1', 137, 9, false]]);
    assert.deepEqual(got(b, 'process-exited', from[1]), [['process-exited', 's1', 137, 9, false]]);
  });

  await t.test('an exit code of 0 with no signal is passed on as it came', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const { proc } = await start(h, env, a, 's1');
    proc.emitExit({ exitCode: 0, signal: undefined });
    assert.deepEqual(got(a, 'process-exited'), [['process-exited', 's1', 0, undefined, false]]);
  });

  await t.test('the record and the owner are cleared and its MCP server is shut down; the session next to it is untouched', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { session, proc } = await start(h, env, a, 's1');
    const next = await start(h, env, b, 's2');
    assert.equal(h.registry.ownerId('s1'), a.id);
    assert.ok(session.mcpServer, 'a Claude session starts with an MCP server');
    const from = [a.sent.length, b.sent.length];

    proc.emitExit({ exitCode: 0, signal: undefined });
    assert.equal(session.exited, true);
    assert.equal(h.activeSessions.has('s1'), false, 'the record is off the list');
    assert.equal(h.registry.ownerId('s1'), null, 'no window owns the id any more');
    assert.deepEqual(env.mcpShutdowns, ['s1']);
    assert.equal(session.mcpServer, null);

    assert.equal(h.activeSessions.get('s2'), next.session);
    assert.equal(h.activeSessions.size, 1);
    assert.equal(h.registry.ownerId('s2'), b.id);
    assert.equal(next.session.exited, false);
    assert.ok(next.session.mcpServer);
    assert.deepEqual(next.proc.calls, []);
    for (const [win, start] of [[a, from[0]], [b, from[1]]]) {
      assert.deepEqual(got(win, 'process-exited', start).map((m) => m[1]), ['s1'], 'no report for the other session');
    }
  });

  await t.test('the stop flag is true for a session ended through stop-session, and nothing is reported before the pty says it ended', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { session, proc } = await start(h, env, a, 's1');
    const answer = await h.invoke('stop-session', a, 's1');
    assert.equal(answer.ok, true);
    assert.equal(ptyCalls(session, 'kill').length, 1);
    assert.deepEqual(got(a, 'process-exited'), [], 'the kill alone reports nothing');
    assert.equal(h.activeSessions.get('s1'), session, 'and the record stays until the exit');
    proc.emitExit({ exitCode: 1, signal: 15 });
    assert.deepEqual(got(a, 'process-exited'), [['process-exited', 's1', 1, 15, true]]);
    assert.deepEqual(got(b, 'process-exited'), [['process-exited', 's1', 1, 15, true]]);
    assert.equal(h.activeSessions.has('s1'), false);
    assert.equal(h.registry.ownerId('s1'), null);
  });

  await t.test('a session no window shows is reported to every window all the same', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { proc } = await start(h, env, a, 's1');
    h.registry.clearOwner('s1'); // its view was closed; the session runs on
    proc.emitExit({ exitCode: 0, signal: undefined });
    assert.deepEqual(got(a, 'process-exited'), [['process-exited', 's1', 0, undefined, false]]);
    assert.deepEqual(got(b, 'process-exited'), [['process-exited', 's1', 0, undefined, false]]);
    assert.equal(h.activeSessions.has('s1'), false);
  });

  await t.test('a plain terminal is reported and cleared the same way', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { session, proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.equal(session.isPlainTerminal, true);
    proc.emitExit({ exitCode: 0, signal: undefined });
    assert.deepEqual(got(a, 'process-exited'), [['process-exited', 't1', 0, undefined, false]]);
    assert.deepEqual(got(b, 'process-exited'), [['process-exited', 't1', 0, undefined, false]]);
    assert.equal(session.exited, true);
    assert.equal(h.activeSessions.has('t1'), false);
    assert.equal(h.registry.ownerId('t1'), null);
  });

  await t.test('after a re-key, with nothing stored under the first id: one report, under the id the session lives under now, and that record and owner are cleared', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { session, proc } = await start(h, env, a, 'id-1');
    rekeyByHand(h, 'id-1', 'id-2');
    assert.equal(h.registry.ownerId('id-2'), a.id, 'the owner followed the re-key');
    proc.emitExit({ exitCode: 0, signal: undefined });
    // Under the live id only: nothing was stored under id-1, so no second report.
    assert.deepEqual(got(a, 'process-exited'), [['process-exited', 'id-2', 0, undefined, false]]);
    assert.deepEqual(got(b, 'process-exited'), [['process-exited', 'id-2', 0, undefined, false]]);
    assert.equal(session.exited, true);
    assert.equal(h.activeSessions.size, 0);
    assert.equal(h.registry.ownerId('id-2'), null);
    assert.equal(h.registry.ownerId('id-1'), null);
    assert.deepEqual(env.mcpShutdowns, ['id-2'], 'the MCP server is shut down under the live id');
  });

  // SECOND CASE, changed on purpose by the crash guard (commit C). The first
  // terminal starts under id-1 and is re-keyed to id-2. Then the row of id-1
  // is opened again: no adopt, nothing stored under id-1, so a second
  // terminal starts under it. Before the fix, the first one's exit acted on
  // whatever was stored under the id it started with, and that was the
  // second. Now it acts on that id only while it still points at itself.
  async function twoTerminalsOneFirstId() {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const first = await start(h, env, a, 'id-1');
    rekeyByHand(h, 'id-1', 'id-2');
    const second = await start(h, env, b, 'id-1', { isNew: false });
    assert.notEqual(second.session, first.session);
    assert.equal(h.activeSessions.get('id-2'), first.session);
    assert.equal(h.activeSessions.get('id-1'), second.session);
    assert.equal(h.registry.ownerId('id-2'), a.id);
    assert.equal(h.registry.ownerId('id-1'), b.id);
    return { env, h, a, b, first, second };
  }

  await t.test('after the fix: another live terminal stored under the first id stays in the list with its owner and gets no exit report when the first one ends', async () => {
    const { env, h, a, b, first, second } = await twoTerminalsOneFirstId();
    const from = [a.sent.length, b.sent.length];
    assert.equal((await h.invoke('stop-session', a, 'id-2')).ok, true);
    first.proc.emitExit({ exitCode: 1, signal: 15 });
    for (const [win, start] of [[a, from[0]], [b, from[1]]]) {
      assert.deepEqual(got(win, 'process-exited', start), [['process-exited', 'id-2', 1, 15, true]], 'one report, for the terminal that ended');
    }
    assert.equal(h.activeSessions.has('id-2'), false);
    assert.equal(h.activeSessions.get('id-1'), second.session, 'the second terminal is still on the list');
    assert.equal(h.activeSessions.size, 1);
    assert.equal(h.registry.ownerId('id-2'), null);
    assert.equal(h.registry.ownerId('id-1'), b.id, 'and its window still owns it');
    assert.equal(first.session.exited, true);
    assert.equal(second.session.exited, false);
    assert.notEqual(second.session.stopRequested, true);
    assert.deepEqual(second.proc.calls, [], 'its process was not killed');
    assert.deepEqual(env.mcpShutdowns, ['id-2'], "only the first terminal's MCP server was shut down");
    assert.ok(second.session.mcpServer);
  });

  await t.test('after the fix: that second terminal still reaches its window, and stop-session stops it', async () => {
    const { h, a, b, first, second } = await twoTerminalsOneFirstId();
    first.proc.emitExit({ exitCode: 0, signal: undefined });
    const from = [a.sent.length, b.sent.length];
    second.proc.emitData('after');
    assert.deepEqual(a.sent.slice(from[0]), []);
    assert.deepEqual(b.sent.slice(from[1]), [['terminal-data', 'id-1', 'after']], 'its output still reaches its window');
    const answer = await h.invoke('stop-session', b, 'id-1');
    assert.equal(answer.ok, true);
    assert.deepEqual(second.proc.calls.map((c) => c.op), ['kill']);
    second.proc.emitExit({ exitCode: 0 });
    assert.deepEqual(got(b, 'process-exited', from[1]), [['process-exited', 'id-1', 0, undefined, true]]);
    assert.equal(h.activeSessions.size, 0);
    assert.equal(h.registry.ownerId('id-1'), null);
  });

  // FIRST CASE again: two subtests added after the verifier's attack. They
  // hold before and after the crash guard, like the seven at the top.

  await t.test('the stop flag is true when the exit carries no signal, which is all a pty on Windows reports', async () => {
    // node-pty on Windows emits the exit with the code alone, so the signal
    // is undefined on every exit there. The flag must not depend on it.
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const claude = await start(h, env, a, 's1');
    const plainTerm = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.equal((await h.invoke('stop-session', a, 's1')).ok, true);
    assert.equal((await h.invoke('stop-session', a, 't1')).ok, true);
    claude.proc.emitExit({ exitCode: 0, signal: undefined });
    plainTerm.proc.emitExit({ exitCode: 1 });
    for (const win of [a, b]) {
      assert.deepEqual(got(win, 'process-exited'), [
        ['process-exited', 's1', 0, undefined, true],
        ['process-exited', 't1', 1, undefined, true],
      ]);
    }
    assert.equal(h.activeSessions.size, 0);
  });

  await t.test('a session whose view was closed through close-terminal (no owner, not attached) is reported to every window when it ends', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'close'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { session, proc } = await start(h, env, a, 's1');
    h.emit('close-terminal', a, 's1');
    assert.equal(session.rendererAttached, false);
    assert.equal(h.registry.ownerId('s1'), null);
    const from = [a.sent.length, b.sent.length];
    proc.emitExit({ exitCode: 3, signal: undefined });
    assert.deepEqual(got(a, 'process-exited', from[0]), [['process-exited', 's1', 3, undefined, false]]);
    assert.deepEqual(got(b, 'process-exited', from[1]), [['process-exited', 's1', 3, undefined, false]]);
    assert.equal(session.exited, true);
    assert.equal(h.activeSessions.has('s1'), false);
  });

  // FIRST CASE again: two subtests from the recheck round (second reader's
  // R1c, R6i, R6h). Every exit above comes right after the Stop, none looks at
  // the process's calls after its own exit, and none looks at the MCP server
  // of a session whose view was closed.

  await t.test('the stop mark stays after the 8 s; an exit that comes later still carries the stop flag, and the exit code does not touch the pty', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 's1');
    assert.equal((await h.invoke('stop-session', a, 's1')).ok, true);
    h.timers.advance(9000);
    assert.equal(session.stopRequested, true, 'still marked 9 s after the Stop');
    proc.emitExit({ exitCode: 1 });
    assert.deepEqual(got(a, 'process-exited'), [['process-exited', 's1', 1, undefined, true]]);
    h.timers.advance(60000);
    assert.deepEqual(proc.calls.map((c) => c.op), ['kill'], 'the one kill of the Stop; nothing at the exit or after it');
  });

  await t.test('a session whose view was closed through close-terminal has its MCP server shut down and its record removed when it ends', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'close'], globals: env.globals });
    const a = h.window();
    const { session, proc } = await start(h, env, a, 's1');
    h.emit('close-terminal', a, 's1');
    proc.emitExit({ exitCode: 0 });
    assert.deepEqual(env.mcpShutdowns, ['s1']);
    assert.equal(session.mcpServer, null);
    assert.equal(h.activeSessions.size, 0);
  });
});

// --- Pin 7: delete-track ---

/** What projects.deleteTrack answers for a track that was deleted (the fields of projects.js's own answer). */
const trackDeleted = (sessionIds = []) => ({ ok: true, projectId: 'proj-1', formerTrackName: 'Release work', sessionIds });

/**
 * Fakes for the delete-track block: a track table of one ('track-1'), and
 * projects.deleteTrack answering `result`. `calls` is every database and
 * projects call in order.
 */
function trackFakes({ result = trackDeleted() } = {}) {
  const track = { id: 'track-1', projectId: 'proj-1', name: 'Release work' };
  const calls = [];
  const globals = {
    dbModule: {
      getTrack: (id) => (id === track.id ? track : undefined),
      setSessionAssignment: (...args) => { calls.push(['setSessionAssignment', ...args]); },
    },
    projects: {
      deleteTrack: (id, options) => { calls.push(['deleteTrack', id, { ...options }]); return result; },
    },
  };
  return { globals, calls, track };
}

/** Makes a fake session's kill throw, after it was noted as usual. */
function killThrows(session) {
  const note = session.pty.kill;
  session.pty.kill = () => { note(); throw new Error('the pty is closed'); };
  return session;
}

test('main pty wiring (pin): delete-track with archive marks and kills each live session once, and a failing kill does not stop the rest', async (t) => {
  await t.test('with archive: every live session of the track is marked as stopped and then killed, once each, and the others are left alone', async () => {
    const fakes = trackFakes({ result: trackDeleted(['s-listed', 's-both', 's-not-running']) });
    const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
    const a = h.window();
    // Three ways into the track: the record says so, the delete's answer
    // names the id, or both (still one kill). And a plain terminal.
    const ofTrack = [
      h.session('s-track', { owner: a, trackId: 'track-1' }),
      h.session('s-listed', { owner: a }),
      h.session('s-both', { trackId: 'track-1' }),
      h.session('t-track', { isPlainTerminal: true, trackId: 'track-1' }),
    ];
    const elsewhere = h.session('s-elsewhere', { owner: a, trackId: 'track-2' });
    const unfiled = h.session('s-unfiled');

    const answer = await h.invoke('delete-track', a, 'track-1', { archiveSessions: true });
    assert.equal(answer.ok, true);
    assert.equal(answer.error, undefined);
    assert.deepEqual([...answer.sessionIds], ['s-listed', 's-both', 's-not-running']);

    for (const session of ofTrack) {
      assert.equal(ptyCalls(session, 'kill').length, 1, 'killed once');
      assert.equal(ptyCalls(session, 'kill')[0].stopRequested, true, 'marked before the kill, not after');
      assert.equal(session.stopRequested, true);
      assert.equal(session.pty.calls.length, 1, 'nothing but the kill reached the pty');
      assert.equal(session.trackId, null);
      assert.equal(session.formerTrackName, 'Release work');
    }
    for (const session of [elsewhere, unfiled]) {
      assert.deepEqual(session.pty.calls, []);
      assert.notEqual(session.stopRequested, true);
      assert.equal(session.formerTrackName, undefined);
    }
    assert.equal(elsewhere.trackId, 'track-2');
    // The handler removes no record and tells no window: the exit code does.
    assert.equal(h.activeSessions.size, 6);
    assert.equal(h.registry.ownerId('s-track'), a.id);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(fakes.calls.filter((c) => c[0] === 'deleteTrack'), [['deleteTrack', 'track-1', { archiveSessions: true }]]);
  });

  await t.test('a kill that throws is logged and does not stop the rest, and the answer is still the delete\'s', async () => {
    for (const failing of [['s1'], ['s2'], ['s1', 's2', 's3']]) {
      const fakes = trackFakes();
      const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
      const a = h.window();
      const sessions = ['s1', 's2', 's3'].map((id) => {
        const session = h.session(id, { trackId: 'track-1' });
        return failing.includes(id) ? killThrows(session) : session;
      });
      const answer = await h.invoke('delete-track', a, 'track-1', { archiveSessions: true });
      assert.equal(answer.ok, true, 'failing: ' + failing);
      assert.equal(answer.error, undefined, 'the throw did not become the answer');
      for (const session of sessions) {
        assert.equal(ptyCalls(session, 'kill').length, 1, 'each kill was tried once; failing: ' + failing);
        assert.equal(session.stopRequested, true, 'the one that failed stays marked');
        assert.equal(session.trackId, null);
        assert.equal(session.formerTrackName, 'Release work');
      }
      const logged = h.log.lines.filter((line) => line.includes('[delete-track]'));
      assert.equal(logged.length, failing.length, 'one log line for each kill that failed');
      for (const line of logged) assert.match(line, /the pty is closed/);
    }
  });

  await t.test('a session of the track that has ended is neither marked nor killed; it only loses its track', async () => {
    const fakes = trackFakes({ result: trackDeleted(['s-ended-listed']) });
    const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
    const a = h.window();
    const ended = [
      h.session('s-ended', { trackId: 'track-1', exited: true }),
      h.session('s-ended-listed', { exited: true }),
    ];
    const live = h.session('s-live', { trackId: 'track-1' });
    await h.invoke('delete-track', a, 'track-1', { archiveSessions: true });
    for (const session of ended) {
      assert.deepEqual(session.pty.calls, []);
      assert.notEqual(session.stopRequested, true);
      assert.equal(session.trackId, null);
      assert.equal(session.formerTrackName, 'Release work');
    }
    assert.equal(ptyCalls(live, 'kill').length, 1);
  });

  await t.test('without archive nobody is marked or killed: the sessions only lose their track', async () => {
    // Only the boolean true asks for the stop.
    for (const options of [undefined, {}, { archiveSessions: false }, { archiveSessions: 1 }, { archiveSessions: 'true' }]) {
      const fakes = trackFakes({ result: trackDeleted(['s-listed']) });
      const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
      const a = h.window();
      const sessions = [h.session('s-track', { trackId: 'track-1' }), h.session('s-listed'), h.session('t-track', { isPlainTerminal: true, trackId: 'track-1' })];
      const answer = await h.invoke('delete-track', a, 'track-1', options);
      assert.equal(answer.ok, true, JSON.stringify(options));
      for (const session of sessions) {
        assert.deepEqual(session.pty.calls, [], JSON.stringify(options));
        assert.notEqual(session.stopRequested, true, JSON.stringify(options));
        assert.equal(session.trackId, null);
        assert.equal(session.formerTrackName, 'Release work');
      }
      assert.deepEqual(fakes.calls.filter((c) => c[0] === 'deleteTrack'), [['deleteTrack', 'track-1', { archiveSessions: false }]], JSON.stringify(options));
    }
  });

  await t.test('a track that is not there, and a delete that answers an error: nothing is marked, killed or changed', async () => {
    const notThere = trackFakes();
    const failed = trackFakes({ result: { error: 'the database said no' } });
    for (const [fakes, trackId, error, deletes] of [[notThere, 'track-9', 'Track not found', 0], [failed, 'track-1', 'the database said no', 1]]) {
      const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
      const a = h.window();
      const session = h.session('s1', { trackId });
      const answer = await h.invoke('delete-track', a, trackId, { archiveSessions: true });
      assert.equal(answer.error, error);
      assert.deepEqual(session.pty.calls, [], error);
      assert.notEqual(session.stopRequested, true, error);
      assert.equal(session.trackId, trackId, error);
      assert.equal(session.formerTrackName, undefined, error);
      assert.equal(fakes.calls.filter((c) => c[0] === 'deleteTrack').length, deletes, error);
    }
  });

  await t.test('a plain terminal of the track is filed in the database before the track is deleted, and no other session is', async () => {
    const fakes = trackFakes();
    const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
    const a = h.window();
    h.session('s-track', { trackId: 'track-1' });
    h.session('t-track', { isPlainTerminal: true, trackId: 'track-1' });
    h.session('t-elsewhere', { isPlainTerminal: true, trackId: 'track-2' });
    await h.invoke('delete-track', a, 'track-1', { archiveSessions: true });
    assert.deepEqual(fakes.calls, [
      ['setSessionAssignment', 't-track', 'proj-1', 'track-1'],
      ['deleteTrack', 'track-1', { archiveSessions: true }],
    ]);
  });

  // Added after the verifier's attack: "once" was only looked at inside the
  // call, so a second kill from a timer was not seen.
  await t.test('kills once, seen over time: a minute after the delete no session of the track has had a second kill, whether its kill went through or threw', async () => {
    // Nothing is asserted about waiting timers: with the crash guard one will
    // wait for each stop. A stop that stalled or failed is not killed again
    // by a timer; only another Stop does that.
    const fakes = trackFakes({ result: trackDeleted(['s-listed']) });
    const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
    const a = h.window();
    const sessions = [
      h.session('s-track', { owner: a, trackId: 'track-1' }),
      h.session('s-listed'),
      h.session('t-track', { isPlainTerminal: true, trackId: 'track-1' }),
      killThrows(h.session('s-throws', { trackId: 'track-1' })),
    ];
    const elsewhere = h.session('s-elsewhere', { trackId: 'track-2' });
    const answer = await h.invoke('delete-track', a, 'track-1', { archiveSessions: true });
    assert.equal(answer.ok, true);
    for (const ms of [0, 8000, 52000]) {
      h.timers.advance(ms);
      for (const session of sessions) {
        assert.equal(ptyCalls(session, 'kill').length, 1, 'one kill at ' + h.timers.now + ' ms');
        assert.equal(session.pty.calls.length, 1, 'and nothing else on the pty');
      }
    }
    assert.deepEqual(elsewhere.pty.calls, []);
  });

  // From the recheck round (second reader's R7d): the subtest above
  // counts kills over time and never looks at the mark again.

  await t.test('a minute after a delete with archive the sessions of the track are still marked as stopped', async () => {
    const fakes = trackFakes();
    const h = boot({ blocks: ['guarded', 'deleteTrack'], globals: fakes.globals });
    const a = h.window();
    const s = h.session('s1', { trackId: 'track-1' });
    await h.invoke('delete-track', a, 'track-1', { archiveSessions: true });
    h.timers.advance(60000);
    assert.equal(s.stopRequested, true);
  });
});

// --- Pin 8: before-quit ---

/** The steps of before-quit that the fakes below note, in today's order, on each side of the terminal kills. */
const BEFORE_THE_KILLS = ['shutdownAllMcp', 'taskManager.shutdown', 'sessionMove.dragCancel', 'dragProxy.destroy', 'projectsWatcher.close', 'tokenUsage.shutdown'];
const AFTER_THE_KILLS = ['projects.stopPlanWatchers', 'scheduleTickerStop', 'custody.reap', 'driverStore.releaseLock'];

/**
 * Fakes for the before-quit block. `steps` is every step that ran, in order;
 * a step named in `failing` throws. quit() calls the one before-quit
 * listener the block registered. session(h, id, fields) is h.session whose
 * kill is noted in `steps` as 'kill <id>' (fields.killFails makes it throw).
 */
function quitFakes({ failing = [] } = {}) {
  const steps = [];
  const listeners = new Map();
  const step = (name, answer) => () => {
    steps.push(name);
    if (failing.includes(name)) throw new Error(name + ' failed');
    return answer;
  };
  const globals = {
    app: { on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); } },
    shutdownAllMcp: step('shutdownAllMcp'),
    taskManager: { shutdown: step('taskManager.shutdown') },
    sessionMove: { dragCancel: step('sessionMove.dragCancel') },
    dragProxy: { destroy: step('dragProxy.destroy') },
    projectsWatcher: { close: step('projectsWatcher.close') },
    tokenUsageInitTimer: null,
    tokenUsage: { shutdown: step('tokenUsage.shutdown') },
    projects: { stopPlanWatchers: step('projects.stopPlanWatchers') },
    scheduleTickerStop: step('scheduleTickerStop'),
    custody: { reap: step('custody.reap', { degraded: false, survivors: [] }) },
    driverStore: { releaseLock: step('driverStore.releaseLock') },
  };
  return {
    globals, steps,
    quit() {
      const list = listeners.get('before-quit') || [];
      assert.equal(list.length, 1, 'one before-quit listener');
      list[0]({ preventDefault() {} });
    },
    session(h, id, { killFails = false, ...fields } = {}) {
      const session = h.session(id, fields);
      const note = session.pty.kill;
      session.pty.kill = () => {
        steps.push('kill ' + id);
        note();
        if (killFails) throw new Error('the pty is closed');
      };
      return session;
    },
  };
}

test('main pty wiring (pin): before-quit kills every live terminal in its own try, marks none as user-stopped, and the later steps still run', async (t) => {
  await t.test('every terminal that has not ended gets one kill, after the token store and before the plan watchers; one that has ended gets none; none is marked as stopped by the user', () => {
    const q = quitFakes();
    const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
    const a = h.window();
    const live = [
      q.session(h, 's1', { owner: a }),
      q.session(h, 't1', { owner: a, isPlainTerminal: true }),
      q.session(h, 's-unshown'),
    ];
    const ended = q.session(h, 's-ended', { owner: a, exited: true });

    q.quit();
    assert.deepEqual(q.steps, [...BEFORE_THE_KILLS, 'kill s1', 'kill t1', 'kill s-unshown', ...AFTER_THE_KILLS]);
    for (const session of live) {
      assert.equal(ptyCalls(session, 'kill').length, 1);
      assert.equal(ptyCalls(session, 'kill')[0].stopRequested, false, 'not marked when the kill is called');
      assert.notEqual(session.stopRequested, true, 'and not marked afterwards');
      assert.equal(session.pty.calls.length, 1, 'nothing but the kill reached the pty');
    }
    assert.deepEqual(ended.pty.calls, []);
    assert.notEqual(ended.stopRequested, true);
    // The handler takes no record off the list: each terminal's exit code does.
    assert.equal(h.activeSessions.size, 4);
  });

  await t.test('a kill that throws stops neither the kills after it nor the later steps, and nothing is thrown out of the handler', () => {
    for (const failing of [['s1'], ['s2'], ['s1', 's2', 's3']]) {
      const q = quitFakes();
      const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
      const sessions = ['s1', 's2', 's3'].map((id) => q.session(h, id, { killFails: failing.includes(id) }));
      assert.doesNotThrow(() => q.quit(), 'failing: ' + failing);
      assert.deepEqual(q.steps, [...BEFORE_THE_KILLS, 'kill s1', 'kill s2', 'kill s3', ...AFTER_THE_KILLS], 'failing: ' + failing);
      for (const session of sessions) {
        assert.equal(ptyCalls(session, 'kill').length, 1, 'each kill was tried once; failing: ' + failing);
        assert.notEqual(session.stopRequested, true);
      }
    }
  });

  await t.test('a session whose Stop was already sent and that has not ended is killed at quit too, and keeps its mark', () => {
    const q = quitFakes();
    const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
    const stopping = q.session(h, 's-stopping', { stopRequested: true });
    q.quit();
    assert.equal(ptyCalls(stopping, 'kill').length, 1);
    assert.equal(stopping.stopRequested, true, 'the mark the Stop set is left as it was');
    assert.deepEqual(q.steps.slice(-AFTER_THE_KILLS.length), AFTER_THE_KILLS);
  });

  await t.test('the Tasks runner or the token store failing before the kills does not stop the kills or the later steps', () => {
    const q = quitFakes({ failing: ['taskManager.shutdown', 'tokenUsage.shutdown'] });
    const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
    const s1 = q.session(h, 's1');
    const s2 = q.session(h, 's2');
    assert.doesNotThrow(() => q.quit());
    assert.deepEqual(q.steps, [...BEFORE_THE_KILLS, 'kill s1', 'kill s2', ...AFTER_THE_KILLS]);
    assert.equal(ptyCalls(s1, 'kill').length, 1);
    assert.equal(ptyCalls(s2, 'kill').length, 1);
  });

  await t.test('the later steps each run when the one before them throws, with terminals or with none', () => {
    for (const ids of [[], ['s1', 's2']]) {
      const q = quitFakes({ failing: AFTER_THE_KILLS });
      const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
      for (const id of ids) q.session(h, id, { killFails: true });
      assert.doesNotThrow(() => q.quit(), 'terminals: ' + ids.length);
      assert.deepEqual(q.steps, [...BEFORE_THE_KILLS, ...ids.map((id) => 'kill ' + id), ...AFTER_THE_KILLS], 'terminals: ' + ids.length);
    }
  });

  // The two subtests below were added after the verifier's attack: a second
  // kill from a timer was not seen, and the "Stop already sent" subtest above
  // sets the mark by hand, which says nothing once the crash guard keeps its
  // own "kill sent" flag.

  await t.test('one kill each, seen over time: a minute after quit no terminal has had a second kill and no step has run again, whether its kill went through or threw', () => {
    const q = quitFakes();
    const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
    const a = h.window();
    const sessions = [
      q.session(h, 's1', { owner: a }),
      q.session(h, 't1', { owner: a, isPlainTerminal: true }),
      q.session(h, 's-throws', { killFails: true }),
    ];
    q.quit();
    const steps = [...q.steps];
    assert.deepEqual(steps, [...BEFORE_THE_KILLS, 'kill s1', 'kill t1', 'kill s-throws', ...AFTER_THE_KILLS]);
    for (const ms of [2000, 8000, 50000]) {
      h.timers.advance(ms);
      assert.deepEqual(q.steps, steps, 'no kill and no step after the handler returned, at ' + h.timers.now + ' ms');
      for (const session of sessions) assert.equal(session.pty.calls.length, 1, 'one kill and nothing else on the pty');
    }
  });

  await t.test('a session stopped through the real stop-session handler that has not ended is killed at quit too: quit does not skip a session because a kill was already sent', async () => {
    const q = quitFakes();
    const h = boot({ blocks: ['stop', 'beforeQuit'], globals: q.globals });
    const a = h.window();
    const stopping = q.session(h, 's-stopping', { owner: a });
    const untouched = q.session(h, 's-running', { owner: a });
    assert.equal((await h.invoke('stop-session', a, 's-stopping')).ok, true);
    assert.deepEqual(q.steps, ['kill s-stopping'], 'the Stop sent its kill');
    q.quit();
    assert.deepEqual(q.steps, ['kill s-stopping', ...BEFORE_THE_KILLS, 'kill s-stopping', 'kill s-running', ...AFTER_THE_KILLS]);
    assert.equal(ptyCalls(stopping, 'kill').length, 2, 'one kill from the Stop and one from quit');
    assert.equal(stopping.stopRequested, true, 'the mark the Stop set is left as it was');
    assert.equal(ptyCalls(untouched, 'kill').length, 1);
    assert.notEqual(untouched.stopRequested, true);
  });

  // From the recheck round (second reader's R8d): the "seen over time"
  // subtest above has no terminal that had ended before quit.

  await t.test('a terminal that had ended before quit has had no kill a minute after quit', () => {
    const q = quitFakes();
    const h = boot({ blocks: ['beforeQuit'], globals: q.globals });
    const ended = q.session(h, 's-ended', { exited: true });
    q.session(h, 's1');
    q.quit();
    h.timers.advance(60000);
    assert.deepEqual(ended.pty.calls, []);
  });
});

// --- Pin 9: open-terminal for a session that is running (reattach) ---

test('main pty wiring (pin): reattach moves the owner, tells the old owner to release, replays the buffer in order, hides the cursor and re-arms the nudge', async (t) => {
  const HIDE_CURSOR = '\x1b[?25l';
  const ALT_SCREEN = '\x1b[?1049h';
  const data = (id, ...chunks) => chunks.map((chunk) => ['terminal-data', id, chunk]);
  const ownerIs = (sessionId, win) => ['session-owner-changed', { sessionId, windowId: win.id }];
  const reattach = (h, win, id, options) => h.invoke('open-terminal', win, id, PROJECT, false, options);
  // The spawn fakes are given so that a process started by mistake is counted.
  const bootOpen = (more = []) => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', ...more], globals: env.globals });
    return { env, h };
  };

  await t.test('another window opens a running session: the owner moves, the old owner is told once to release it, the buffer is replayed to the new owner in order, then the cursor is hidden, then every window is told', async () => {
    const { h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const c = h.window();
    h.session('s1', { owner: a, outputBuffer: ['one', 'two', 'three'] });
    const answer = await reattach(h, b, 's1');
    assert.equal(answer.ok, true);
    assert.equal(answer.reattached, true);
    assert.equal(answer.skippedReplay, false);
    assert.equal(h.registry.ownerId('s1'), b.id);
    assert.deepEqual(a.sent, [['release-session', 's1'], ownerIs('s1', b)]);
    assert.deepEqual(b.sent, [...data('s1', 'one', 'two', 'three', HIDE_CURSOR), ownerIs('s1', b)]);
    assert.deepEqual(c.sent, [ownerIs('s1', b)], 'a third window gets neither the release nor the replay');
  });

  await t.test('the replay does not use the buffer up: a second reattach replays the same chunks again', async () => {
    const { h } = bootOpen();
    const a = h.window();
    const s = h.session('s1', { owner: a, outputBuffer: ['one', 'two'] });
    await reattach(h, a, 's1');
    await reattach(h, a, 's1');
    assert.deepEqual(got(a, 'terminal-data'), [...data('s1', 'one', 'two', HIDE_CURSOR), ...data('s1', 'one', 'two', HIDE_CURSOR)]);
    assert.deepEqual([...s.outputBuffer], ['one', 'two']);
  });

  await t.test('the same window again (a reload), and a session no window shows: nobody is told to release', async () => {
    const { h } = bootOpen();
    const a = h.window();
    const b = h.window();
    h.session('s1', { owner: a, outputBuffer: ['x'] });
    h.session('s2', { outputBuffer: ['y'] });
    await reattach(h, a, 's1');
    await reattach(h, a, 's2');
    assert.equal(h.registry.ownerId('s1'), a.id);
    assert.equal(h.registry.ownerId('s2'), a.id);
    assert.deepEqual(got(a, 'release-session'), []);
    assert.deepEqual(got(b, 'release-session'), []);
    assert.deepEqual(got(a, 'terminal-data'), [...data('s1', 'x', HIDE_CURSOR), ...data('s2', 'y', HIDE_CURSOR)]);
    assert.deepEqual(b.sent, [ownerIs('s1', a), ownerIs('s2', a)]);
  });

  await t.test('a Claude session in the alternate screen: the switch into it is sent first, before the replay; a plain terminal gets no switch', async () => {
    const { h } = bootOpen();
    const a = h.window();
    const b = h.window();
    h.session('s1', { owner: a, altScreen: true, outputBuffer: ['frame 1', 'frame 2'] });
    h.session('t1', { owner: a, isPlainTerminal: true, altScreen: true, outputBuffer: ['$ top'] });
    await reattach(h, b, 's1');
    assert.deepEqual(got(b, 'terminal-data'), data('s1', ALT_SCREEN, 'frame 1', 'frame 2', HIDE_CURSOR));
    const from = b.sent.length;
    await reattach(h, b, 't1', { type: 'terminal' });
    assert.deepEqual(got(b, 'terminal-data', from), data('t1', '$ top'));
  });

  await t.test('a plain terminal: the buffer is replayed in order and the cursor is not hidden', async () => {
    const { h } = bootOpen();
    const a = h.window();
    const b = h.window();
    h.session('t1', { owner: a, isPlainTerminal: true, outputBuffer: ['$ ls\r\n', 'a.txt\r\n', '$ '] });
    const answer = await reattach(h, b, 't1', { type: 'terminal' });
    assert.equal(answer.reattached, true);
    assert.deepEqual(b.sent, [...data('t1', '$ ls\r\n', 'a.txt\r\n', '$ '), ownerIs('t1', b)]);
    assert.deepEqual(a.sent, [['release-session', 't1'], ownerIs('t1', b)]);
  });

  await t.test('a window that brought its own scrollback (skipReplay): no switch and no replay, the cursor is still hidden, the rest as usual', async () => {
    const { h } = bootOpen();
    const a = h.window();
    const b = h.window();
    h.session('s1', { owner: a, altScreen: true, outputBuffer: ['frame'] });
    h.session('t1', { owner: a, isPlainTerminal: true, outputBuffer: ['$ '] });
    const answer = await reattach(h, b, 's1', { skipReplay: true });
    assert.equal(answer.ok, true);
    assert.equal(answer.reattached, true);
    assert.equal(answer.skippedReplay, true);
    assert.deepEqual(b.sent, [...data('s1', HIDE_CURSOR), ownerIs('s1', b)]);
    assert.deepEqual(a.sent, [['release-session', 's1'], ownerIs('s1', b)]);
    const from = b.sent.length;
    await reattach(h, b, 't1', { type: 'terminal', skipReplay: true });
    assert.deepEqual(b.sent.slice(from), [ownerIs('t1', b)], 'a plain terminal gets nothing but the owner news');
  });

  await t.test('the session is marked attached again and its MCP window follows; the pty is not touched and no process is started', async () => {
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const withMcp = h.session('s1', { owner: a, rendererAttached: false, mcpServer: { port: 4001 } });
    const without = h.session('s2', { owner: a, rendererAttached: false });
    const first = await reattach(h, b, 's1');
    const second = await reattach(h, b, 's2');
    assert.equal(withMcp.rendererAttached, true);
    assert.equal(without.rendererAttached, true);
    assert.equal(first.mcpActive, true);
    assert.equal(second.mcpActive, false);
    assert.equal(h.mcpWindows.length, 2);
    assert.equal(h.mcpWindows[0][0], 's1');
    assert.equal(h.mcpWindows[0][1], b, 'the window that asked');
    assert.equal(h.mcpWindows[1][0], 's2');
    assert.deepEqual(withMcp.pty.calls, []);
    assert.deepEqual(without.pty.calls, []);
    assert.equal(env.spawned.length, 0, 'no process was started');
    assert.deepEqual(env.mcpStarted, [], 'and no MCP server');
    assert.equal(h.activeSessions.get('s1'), withMcp);
    assert.equal(h.activeSessions.size, 2);
  });

  await t.test('the nudge is re-armed: after a reattach a Claude session\'s next resize is followed by one column wider at 50 ms and back at 100 ms; a plain terminal\'s is not', async () => {
    const { h } = bootOpen(['resize']);
    const a = h.window();
    const s = h.session('s1', { owner: a });
    const plainTerm = h.session('t1', { owner: a, isPlainTerminal: true });
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(1000);
    h.emit('terminal-resize', a, 's1', 120, 30);
    h.timers.advance(1000);
    assert.equal(s.pty.calls.length, 4, 'the nudge is used up: the second resize was the size alone');

    await reattach(h, a, 's1'); // the same window, as after a reload
    h.emit('terminal-resize', a, 's1', 100, 25);
    h.timers.advance(1000);
    assert.deepEqual(resizes(s).slice(4), [[100, 25, 2000], [101, 25, 2050], [100, 25, 2100]]);

    await reattach(h, a, 't1', { type: 'terminal' });
    h.emit('terminal-resize', a, 't1', 100, 40);
    h.timers.advance(1000);
    assert.deepEqual(resizes(plainTerm), [[100, 40, 3000]]);
  });

  // Added after the verifier's attack: the harness's own panelPaths hands the
  // window back as it is, so the subtests above cannot tell the wrapper from
  // the bare window.
  await t.test('the MCP window is what panelPaths.watchWindow made of the asking window, not the bare window', async () => {
    const env = spawnFakes();
    const watched = [];
    const panelPaths = { watchWindow: (win) => { const wrapper = { wraps: win }; watched.push(wrapper); return wrapper; } };
    const h = boot({ blocks: ['resolve', 'open'], globals: { ...env.globals, panelPaths } });
    const a = h.window();
    const b = h.window();
    h.session('s1', { owner: a });
    const answer = await reattach(h, b, 's1');
    assert.equal(answer.reattached, true);
    assert.equal(watched.length, 1, 'the asking window was wrapped once');
    assert.equal(watched[0].wraps, b);
    assert.equal(h.mcpWindows.length, 1);
    assert.equal(h.mcpWindows[0][0], 's1');
    assert.equal(h.mcpWindows[0][1], watched[0], 'the MCP server pushes through the wrapper');
  });

  // From the recheck round (second reader's R9c): in the subtest above the
  // asking window takes the session from another window. Here a window opens
  // its own session again (a reload) and a session nobody showed.

  await t.test('the MCP window is the wrapper also when the same window opens its session again and when nobody showed the session', async () => {
    const env = spawnFakes();
    const watched = [];
    const panelPaths = { watchWindow: (win) => { const wrapper = { wraps: win }; watched.push(wrapper); return wrapper; } };
    const h = boot({ blocks: ['resolve', 'open'], globals: { ...env.globals, panelPaths } });
    const a = h.window();
    h.session('s-own', { owner: a });
    h.session('s-unshown');
    await reattach(h, a, 's-own');
    await reattach(h, a, 's-unshown');
    assert.equal(watched.length, 2);
    assert.equal(h.mcpWindows[0][1], watched[0]);
    assert.equal(h.mcpWindows[1][1], watched[1]);
    assert.equal(watched[0].wraps, a);
    assert.equal(watched[1].wraps, a);
  });
});

// --- Pin 10: open-terminal with adopt (a session moved to this window) ---

test('main pty wiring (pin): an adopt of a session that is gone answers exited, of a re-keyed one answers rekeyedTo, and never starts a process', async (t) => {
  // Fields of the answer are asserted, never the whole object. The page reads
  // ok, exited and rekeyedTo; the error text is today's.
  const GONE = 'session ended before it could be adopted';
  const REKEYED = 'session was re-keyed during the move';
  const adopt = (h, win, id, more = {}) => h.invoke('open-terminal', win, id, PROJECT, false, { adopt: true, ...more });
  // With the spawn fakes a process started by mistake is started for real in
  // the fake and counted; the last subtest shows that the count works.
  const bootOpen = () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    return { env, h };
  };
  const nothingStarted = (env) => {
    assert.equal(env.spawned.length, 0, 'no process was started');
    assert.deepEqual(env.mcpStarted, [], 'no MCP server was started');
  };

  await t.test('nothing is stored under the id: ok false and exited true, with or without the window\'s own scrollback; no process, no record, no owner, no message', async () => {
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const live = h.session('s-live', { owner: a });
    for (const more of [{ skipReplay: true }, { skipReplay: false }, {}]) {
      const answer = await adopt(h, b, 's-gone', more);
      assert.equal(answer.ok, false, JSON.stringify(more));
      assert.equal(answer.exited, true, JSON.stringify(more));
      assert.equal(answer.error, GONE);
      assert.equal(answer.rekeyedTo, undefined);
    }
    nothingStarted(env);
    assert.equal(h.activeSessions.has('s-gone'), false);
    assert.equal(h.activeSessions.size, 1);
    assert.equal(h.registry.ownerId('s-gone'), null);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(b.sent, []);
    assert.deepEqual(live.pty.calls, []);
  });

  await t.test('a session that has ended but is still in the list: the same answer, and it is not attached', async () => {
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const ended = h.session('s-ended', { owner: a, exited: true, rendererAttached: false, outputBuffer: ['last words'] });
    const answer = await adopt(h, b, 's-ended');
    assert.equal(answer.ok, false);
    assert.equal(answer.exited, true);
    assert.equal(answer.error, GONE);
    nothingStarted(env);
    assert.equal(h.registry.ownerId('s-ended'), a.id, 'the owner did not move');
    assert.equal(ended.rendererAttached, false);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(b.sent, [], 'nothing was replayed');
  });

  await t.test('a session that lives under a new id: ok false and rekeyedTo the id it lives under now, for each of its earlier ids; nothing is attached under either id', async () => {
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const s = h.session('s-now', { owner: a, realSessionId: 's-now', priorIds: ['s-first', 's-second'], rendererAttached: false, firstResize: false, outputBuffer: ['x'] });
    for (const earlier of ['s-first', 's-second']) {
      const answer = await adopt(h, b, earlier, { skipReplay: true });
      assert.equal(answer.ok, false, earlier);
      assert.equal(answer.rekeyedTo, 's-now', earlier);
      assert.notEqual(answer.exited, true, 'alive, so not reported as ended: ' + earlier);
      assert.equal(answer.error, REKEYED);
    }
    nothingStarted(env);
    assert.equal(h.registry.ownerId('s-now'), a.id, 'the owner did not move');
    assert.equal(h.registry.ownerId('s-first'), null);
    assert.equal(h.registry.ownerId('s-second'), null);
    assert.equal(h.activeSessions.size, 1);
    assert.equal(s.rendererAttached, false);
    assert.equal(s.firstResize, false);
    assert.deepEqual(a.sent, []);
    assert.deepEqual(b.sent, []);
    assert.deepEqual(s.pty.calls, []);
  });

  await t.test('a session that lives under a new id and has ended: exited, not rekeyedTo', async () => {
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    h.session('s-now', { owner: a, exited: true, realSessionId: 's-now', priorIds: ['s-first'] });
    const answer = await adopt(h, b, 's-first');
    assert.equal(answer.ok, false);
    assert.equal(answer.exited, true);
    assert.equal(answer.rekeyedTo, undefined);
    nothingStarted(env);
  });

  await t.test('a running session under the id asked for: the adopt attaches to it and starts nothing', async () => {
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const s = h.session('s1', { owner: a, outputBuffer: ['x'] });
    const answer = await adopt(h, b, 's1', { skipReplay: true });
    assert.equal(answer.ok, true);
    assert.equal(answer.reattached, true);
    assert.equal(h.registry.ownerId('s1'), b.id);
    assert.equal(h.activeSessions.get('s1'), s);
    nothingStarted(env);
  });

  await t.test('the rule is the adopt flag alone: the same call without it, for the same id that is gone, does start a process', async () => {
    const { env, h } = bootOpen();
    const b = h.window();
    const answer = await h.invoke('open-terminal', b, 's-gone', PROJECT, false, { skipReplay: true });
    assert.equal(answer.ok, true);
    assert.equal(answer.reattached, false);
    assert.equal(env.spawned.length, 1, 'so the count above would have seen a start');
    assert.equal(h.activeSessions.has('s-gone'), true);
  });

  // The two subtests below were added after the verifier's attack: nothing
  // above held which record wins when an id is both one terminal's own key
  // and an earlier id of another, and every re-keyed session above had an owner.

  await t.test('the exact key wins: when a terminal is stored under an id that is also an earlier id of another terminal, an adopt of that id attaches to the one stored under it', async () => {
    // The state pin 6's second case builds: terminal 1 moved from id-1 to
    // id-2, then a second terminal started under id-1. The moved one is first
    // in the list, so a lookup that asked the earlier ids first would find it.
    const { env, h } = bootOpen();
    const a = h.window();
    const b = h.window();
    const c = h.window();
    const moved = h.session('id-2', { owner: a, realSessionId: 'id-2', priorIds: ['id-1'], rendererAttached: false, outputBuffer: ['first terminal'] });
    const second = h.session('id-1', { owner: b, rendererAttached: false, outputBuffer: ['second terminal'] });
    assert.deepEqual([...h.activeSessions.keys()], ['id-2', 'id-1']);

    const answer = await adopt(h, c, 'id-1');
    assert.equal(answer.ok, true);
    assert.equal(answer.reattached, true);
    assert.equal(answer.rekeyedTo, undefined, 'not sent on to the terminal that moved away from this id');
    assert.notEqual(answer.exited, true);
    assert.equal(h.registry.ownerId('id-1'), c.id, 'the terminal stored under the id is the one attached');
    assert.equal(h.registry.ownerId('id-2'), a.id, 'the other terminal keeps its window');
    assert.equal(second.rendererAttached, true);
    assert.equal(moved.rendererAttached, false);
    assert.deepEqual(got(c, 'terminal-data'), [['terminal-data', 'id-1', 'second terminal'], ['terminal-data', 'id-1', '\x1b[?25l']], 'and its buffer is the one replayed');
    assert.deepEqual(got(b, 'release-session'), [['release-session', 'id-1']]);
    assert.deepEqual(got(a, 'release-session'), []);
    assert.deepEqual(moved.pty.calls, []);
    assert.deepEqual(second.pty.calls, []);
    nothingStarted(env);
    assert.equal(h.activeSessions.get('id-1'), second);
    assert.equal(h.activeSessions.get('id-2'), moved);
  });

  await t.test('a session that lives under a new id and that no window shows is followed all the same: rekeyedTo, nothing attached, nothing started', async () => {
    const { env, h } = bootOpen();
    const b = h.window();
    const s = h.session('s-now', { realSessionId: 's-now', priorIds: ['s-then'], rendererAttached: false });
    assert.equal(h.registry.ownerId('s-now'), null);
    const answer = await adopt(h, b, 's-then');
    assert.equal(answer.ok, false);
    assert.equal(answer.rekeyedTo, 's-now');
    assert.notEqual(answer.exited, true);
    assert.equal(answer.error, REKEYED);
    assert.equal(h.registry.ownerId('s-now'), null);
    assert.equal(h.registry.ownerId('s-then'), null);
    assert.equal(s.rendererAttached, false);
    assert.deepEqual(b.sent, []);
    nothingStarted(env);
  });

  // From the recheck round (second reader's R10h): the unshown session
  // above has one earlier id.

  await t.test('a session no window shows is followed from each of its earlier ids', async () => {
    const { env, h } = bootOpen();
    const b = h.window();
    h.session('s-now', { realSessionId: 's-now', priorIds: ['s-first', 's-second'], rendererAttached: false });
    for (const earlier of ['s-first', 's-second']) {
      const answer = await adopt(h, b, earlier);
      assert.equal(answer.ok, false, earlier);
      assert.equal(answer.rekeyedTo, 's-now', earlier);
    }
    nothingStarted(env);
  });
});

test('main pty wiring: before-quit writes the pending fault counts first (mainFaults.flush), before any other step', () => {
  const q = quitFakes();
  const seen = [];
  const first = q.globals.shutdownAllMcp;
  let h = null;
  q.globals.shutdownAllMcp = () => { seen.push(h.globals.mainFaults.calls.map((c) => c[0])); return first(); };
  h = boot({ blocks: ['beforeQuit'], globals: q.globals });
  const session = q.session(h, 's1', { owner: h.window() });
  q.quit();
  assert.deepEqual(seen, [['flush']], 'flushed before the first shutdown step');
  assert.deepEqual(h.globals.mainFaults.calls, [['flush']], 'once, with no argument');
  assert.deepEqual(q.steps, [...BEFORE_THE_KILLS, 'kill s1', ...AFTER_THE_KILLS]);
  assert.equal(session.pty.calls.length, 1);
});

// =====================================================================
// The crash guard, commit C: tests on top of the pins
// =====================================================================

/** The text of a file of the repository. */
const sourceOf = (file) => require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8');

test('main-pty-wiring: main.js makes the one guard after the pty-env lines, on its own timers, with the stall report under the id keyOf gives', () => {
  const src = sourceOf('main.js');
  const line = "const { createPtyGuard } = require('./pty-guard');";
  const at = src.indexOf(line);
  assert.notEqual(at, -1, 'a plain require, on one line');
  assert.equal(src.split("require('./pty-guard')").length - 1, 1, 'required once');
  assert.equal(src.split('createPtyGuard(').length - 1, 1, 'one guard');
  assert.ok(src.indexOf("require('electron-reloader')") < at, 'after the reloader line');
  assert.ok(src.indexOf("require('./pty-env')") < at && at < src.indexOf("require('./harnesses')"), 'between pty-env and harnesses');
  const made = block('guard');
  assert.match(made, /const ptyGuard = createPtyGuard\(\{/);
  assert.match(made, /\blog,/);
  assert.match(made, /setTimer: setTimeout,/);
  assert.match(made, /clearTimer: clearTimeout,/);
  assert.match(made, /onStall: \(session\) => mainFaults\.report\('stop-stalled', null, \{ sessionId: sessionTransitions\.keyOf\(session\) \}\),/);
  assert.match(made, /a change in pty-guard\.js needs an app restart/);
  // Every boot gets that guard, the real module behind it.
  const h = boot();
  assert.deepEqual(Object.keys(h.globals.ptyGuard).sort(), ['kill', 'markOutput', 'noteExit', 'resize', 'stopState', 'watchPtyErrors', 'whenStopped', 'write']);
  assert.equal(typeof h.globals.resolveLiveSession, 'function');
  assert.equal(h.globals.sessionTransitions, require('../session-transitions'));
});

test("main-pty-wiring: the real 'terminal-resize' handler survives a pty whose resize throws and leaves _suppressBuffer false", () => {
  const h = boot({ blocks: ['resize'] });
  const a = h.window();
  const s = h.session('t1', { owner: a, isPlainTerminal: true });
  let tries = 0;
  s.pty.resize = () => { tries++; throw new Error('Cannot resize a pty that has already exited'); };
  assert.doesNotThrow(() => h.emit('terminal-resize', a, 't1', 100, 40));
  assert.equal(tries, 1);
  assert.equal(s._suppressBuffer, true, 'the hold is set whatever the guard answers');
  h.timers.advance(200);
  assert.equal(s._suppressBuffer, false, 'and comes off 200 ms later');
  assert.doesNotThrow(() => h.emit('terminal-resize', a, 't1', 110, 40));
  assert.equal(tries, 1, 'a pty found closed is not tried again');
  h.timers.advance(200);
  assert.equal(s._suppressBuffer, false);
});

test('main-pty-wiring: stopping either of two terminals that share a first id leaves the other one alone', async () => {
  const two = async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const first = await start(h, env, a, 'id-1');
    rekeyByHand(h, 'id-1', 'id-2');
    const second = await start(h, env, b, 'id-1', { isNew: false });
    return { h, a, b, first, second };
  };
  // Stop the one that is stored under id-1 now. The other one started under id-1 too.
  {
    const { h, a, b, first, second } = await two();
    assert.deepEqual(plain(await h.invoke('stop-session', b, 'id-1')), { ok: true });
    assert.deepEqual(second.proc.calls.map((c) => c.op), ['kill']);
    assert.deepEqual(first.proc.calls, [], 'the exact key is stopped, not the terminal that once had the id');
    assert.notEqual(first.session.stopRequested, true);
    second.proc.emitExit({ exitCode: 0 });
    assert.equal(h.activeSessions.get('id-2'), first.session);
    assert.equal(h.activeSessions.size, 1);
    assert.equal(h.registry.ownerId('id-2'), a.id);
    assert.deepEqual(got(a, 'process-exited').map((m) => m[1]), ['id-1']);
  }
  // Stop the one that moved on to id-2.
  {
    const { h, a, b, first, second } = await two();
    assert.deepEqual(plain(await h.invoke('stop-session', a, 'id-2')), { ok: true });
    assert.deepEqual(first.proc.calls.map((c) => c.op), ['kill']);
    assert.deepEqual(second.proc.calls, []);
    first.proc.emitExit({ exitCode: 0 });
    assert.equal(h.activeSessions.get('id-1'), second.session, 'the other terminal is still on the list');
    assert.equal(h.registry.ownerId('id-1'), b.id);
    assert.deepEqual(got(b, 'process-exited').map((m) => m[1]), ['id-2'], 'and is not reported ended');
    assert.notEqual(second.session.stopRequested, true);
  }
});

/** The answer of get-stop-states as an array of this realm. plain() does not do that for an array a block made: its own map() gives an array of the block's realm again, and deepEqual is strict about that. */
const stopStates = async (h, from) => [...await h.invoke('get-stop-states', from)];

test('main-pty-wiring: a stop between the first resize and the 50 ms nudge leaves exactly one resize call', async () => {
  const h = boot({ blocks: ['resize', 'stop'] });
  const a = h.window();
  const s = h.session('s1', { owner: a });
  h.emit('terminal-resize', a, 's1', 120, 30);
  h.timers.advance(10);
  assert.equal((await h.invoke('stop-session', a, 's1')).ok, true);
  h.timers.advance(1000);
  assert.deepEqual(resizes(s), [[120, 30, 0]]);
  assert.deepEqual(s.pty.calls.map((c) => c.op), ['resize', 'kill']);
  h.emit('terminal-resize', a, 's1', 90, 20);
  h.timers.advance(1000);
  assert.equal(ptyCalls(s, 'resize').length, 1, 'no later resize reaches a stopping terminal');
});

test("main-pty-wiring: the real 'stop-session' handler called twice kills once and answers ok both times", async () => {
  const h = boot({ blocks: ['stop'] });
  const a = h.window();
  const s = h.session('s1', { owner: a });
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true }, 'no "already" in the answer');
  assert.equal(ptyCalls(s, 'kill').length, 1);
  h.timers.advance(7999);
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  assert.equal(ptyCalls(s, 'kill').length, 1, 'a third Stop inside the 8 s kills nothing');
  h.timers.advance(1);
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  assert.equal(ptyCalls(s, 'kill').length, 2, 'after the stall, one more kill goes out');
  for (const options of [{}, { wait: false }, 'wait', null]) {
    const other = h.session('s-' + JSON.stringify(options), { owner: a });
    assert.deepEqual(plain(await h.invoke('stop-session', a, 's-' + JSON.stringify(options), options)), { ok: true }, 'only wait: true waits');
    assert.equal(ptyCalls(other, 'kill').length, 1);
  }
});

test("main-pty-wiring: 'terminal-input' from a non-owner makes no write; from the owner, none for a stopping session and exactly one for a live one", async () => {
  const h = boot({ blocks: ['input', 'stop'] });
  const a = h.window();
  const b = h.window();
  const live = h.session('s-live', { owner: a });
  const stopping = h.session('s-stopping', { owner: a });
  h.emit('terminal-input', b, 's-live', 'from b');
  assert.deepEqual(writes(live), []);
  await h.invoke('stop-session', a, 's-stopping');
  h.emit('terminal-input', a, 's-stopping', 'x');
  assert.deepEqual(writes(stopping), []);
  h.emit('terminal-input', a, 's-live', 'ls\r');
  assert.deepEqual(writes(live), ['ls\r']);
  live.pty.write = () => { throw new Error('EPIPE'); };
  assert.doesNotThrow(() => h.emit('terminal-input', a, 's-live', 'y'), 'a write that throws stays inside the guard');
});

test("main-pty-wiring: stop-session under an id that is a prior id of a live session answers 'not running' with rekeyedTo and kills nothing", async () => {
  const h = boot({ blocks: ['stop'] });
  const a = h.window();
  const live = h.session('s-new', { owner: a, realSessionId: 's-new', priorIds: ['s-older', 's-old'] });
  h.session('s-ended-new', { exited: true, realSessionId: 's-ended-new', priorIds: ['s-ended-old'] });
  for (const old of ['s-older', 's-old']) {
    assert.deepEqual(plain(await h.invoke('stop-session', a, old)), { ok: false, error: 'not running', rekeyedTo: 's-new' }, old);
  }
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's-old', { wait: true })), { ok: false, error: 'not running', rekeyedTo: 's-new' }, 'the same with wait, at once');
  for (const id of ['s-nobody', 's-ended-old', 's-ended-new', '', undefined]) {
    assert.deepEqual(plain(await h.invoke('stop-session', a, id)), { ok: false, error: 'not running' }, 'no rekeyedTo: ' + id);
  }
  h.timers.advance(60000);
  assert.deepEqual(live.pty.calls, [], 'the terminal that moved on is not killed, then or later');
  assert.notEqual(live.stopRequested, true);
  assert.deepEqual(plain(h.globals.mainFaults.calls).filter((c) => c[0] === 'report'), []);
});

test("main-pty-wiring: stop-session answers 'stop failed' and reports stop-failed when the kill throws; the gate stays closed and every later Stop tries again", async () => {
  const h = boot({ blocks: ['stop', 'input', 'resize', 'stopStates'] });
  const a = h.window();
  const s = h.session('s1', { owner: a });
  const note = s.pty.kill;
  let fail = true;
  s.pty.kill = () => { note(); if (fail) throw new Error('the pty is closed'); };
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: false, error: 'stop failed' });
  assert.equal(s.stopRequested, true);
  assert.equal(ptyCalls(s, 'kill')[0].stopRequested, true, 'marked before the kill');
  const reports = () => h.globals.mainFaults.calls.filter((c) => c[0] === 'report');
  assert.equal(reports().length, 1);
  assert.deepEqual([reports()[0][1], reports()[0][2].message, plain(reports()[0][3])], ['stop-failed', 'the pty is closed', { sessionId: 's1' }]);
  const tagged = h.log.lines.filter((l) => l.includes('[stop]'));
  assert.equal(tagged.length, 1);
  assert.match(tagged[0], /^error \[stop\] session=s1 kill failed: the pty is closed/);
  h.emit('terminal-input', a, 's1', 'x');
  h.emit('terminal-resize', a, 's1', 100, 40);
  h.timers.advance(1000);
  assert.deepEqual(s.pty.calls.map((c) => c.op), ['kill'], 'the gate stays closed after a failed kill');
  assert.deepEqual(await stopStates(h, a), ['s1']);
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1', { wait: true })), { ok: false, error: 'stop failed' }, 'with wait a failed stop answers at once');
  fail = false;
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  assert.equal(ptyCalls(s, 'kill').length, 3, 'every later Stop tried again');
  assert.equal(reports().length, 2, 'one report for each kill that failed');
});

test('main-pty-wiring: stop-session with { wait: true } answers ended true once the terminal has ended and ended false once 8 s have passed', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
  const a = h.window();
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const ends = await start(h, env, a, 's-ends');
  let first = 'no answer yet';
  let again = 'no answer yet';
  // Promise.resolve: before the handler is async its answer is a plain object, and the test must fail on its own assertion.
  const one = Promise.resolve(h.invoke('stop-session', a, 's-ends', { wait: true })).then((answer) => { first = plain(answer); });
  const two = Promise.resolve(h.invoke('stop-session', a, 's-ends', { wait: true })).then((answer) => { again = plain(answer); });
  h.timers.advance(3000);
  await turn();
  assert.equal(first, 'no answer yet', 'the answer waits for the end');
  assert.deepEqual(ends.proc.calls.map((c) => c.op), ['kill'], 'two waiting Stops, one kill');
  ends.proc.emitExit({ exitCode: 0 });
  await one;
  await two;
  assert.deepEqual(first, { ok: true, ended: true });
  assert.deepEqual(again, { ok: true, ended: true });

  await start(h, env, a, 's-stalls');
  let late = 'no answer yet';
  const three = Promise.resolve(h.invoke('stop-session', a, 's-stalls', { wait: true })).then((answer) => { late = plain(answer); });
  h.timers.advance(7999);
  await turn();
  assert.equal(late, 'no answer yet');
  h.timers.advance(1);
  await three;
  assert.deepEqual(late, { ok: true, ended: false });
});

test('main-pty-wiring: a stop that has not ended the terminal after 8 s is reported once as stop-stalled, under the id the record lives under at that moment', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
  const a = h.window();
  const reports = () => plain(h.globals.mainFaults.calls.filter((c) => c[0] === 'report'));
  const s = h.session('s1', { owner: a });
  await h.invoke('stop-session', a, 's1');
  h.timers.advance(7999);
  assert.deepEqual(reports(), []);
  rekeyByHand(h, 's1', 's1-new'); // a /clear inside the 8 s
  h.timers.advance(1);
  assert.deepEqual(reports(), [['report', 'stop-stalled', null, { sessionId: 's1-new' }]]);
  assert.equal(h.log.lines.filter((l) => l.startsWith('warn [stop] session=s1 has not ended 8000 ms after the kill')).length, 1, 'the line names the id the kill was sent under: the known limit of the id in the guard\'s lines');
  h.timers.advance(60000);
  assert.equal(reports().length, 1, 'reported once');
  assert.equal(ptyCalls(s, 'kill').length, 1, 'the stall kills nothing by itself');
  // A terminal that ends inside the 8 s is not reported.
  const quick = await start(h, env, a, 's-quick');
  await h.invoke('stop-session', a, 's-quick');
  h.timers.advance(3000);
  quick.proc.emitExit({ exitCode: 0 });
  h.timers.advance(60000);
  assert.equal(reports().length, 1);
});

test('main-pty-wiring: get-stop-states lists the live sessions whose stop stalled or failed, and nothing else', async () => {
  const h = boot({ blocks: ['stop', 'stopStates'] });
  const a = h.window();
  h.session('s-running', { owner: a });
  h.session('s-stopping', { owner: a });
  h.session('s-stalled', { owner: a });
  killThrows(h.session('s-failed', { owner: a }));
  const gone = h.session('s-stalled-then-ended', { owner: a });
  assert.deepEqual(await stopStates(h, a), []);
  await h.invoke('stop-session', a, 's-stalled');
  await h.invoke('stop-session', a, 's-stalled-then-ended');
  h.timers.advance(8000);
  await h.invoke('stop-session', a, 's-stopping');
  await h.invoke('stop-session', a, 's-failed');
  const answer = await h.invoke('get-stop-states', NO_WINDOW);
  assert.equal(Array.isArray(answer), true, 'an array of ids, like get-active-sessions');
  assert.deepEqual([...answer], ['s-stalled', 's-failed', 's-stalled-then-ended']);
  gone.exited = true;
  assert.deepEqual(await stopStates(h, a), ['s-stalled', 's-failed'], 'it goes when the session ends');
  await h.invoke('stop-session', a, 's-stalled');
  assert.deepEqual(await stopStates(h, a), ['s-stalled', 's-failed'], 'one more Stop does not take it off: that needs the end');
});

test('main-pty-wiring: a size held for a terminal that is stopped before its first output is never applied', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'resize', 'stop'], globals: env.globals });
  const a = h.window();
  const { proc } = await start(h, env, a, 's1');
  h.emit('terminal-resize', a, 's1', 120, 30);
  await h.invoke('stop-session', a, 's1');
  proc.emitData('late');
  h.timers.advance(1000);
  assert.deepEqual(proc.calls.map((c) => c.op), ['kill']);
});

test("main-pty-wiring: preload forwards stopSession's second argument and has getStopStates", () => {
  const src = sourceOf('preload.js');
  assert.ok(src.includes("  stopSession: (id, options) => ipcRenderer.invoke('stop-session', id, options),"));
  assert.ok(src.includes("  getStopStates: () => ipcRenderer.invoke('get-stop-states'),"));
  assert.equal(src.split("'stop-session'").length - 1, 1);
  assert.equal(src.split("'get-stop-states'").length - 1, 1);
});

test('main-pty-wiring: a window that opens a session again while its Stop is pending or has stalled reaches no pty, and the session stays listed as not stopped', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'resize', 'input', 'stop', 'stopStates'], globals: env.globals });
  const a = h.window();
  const b = h.window();
  const s = h.session('s1', { owner: a, outputBuffer: ['shown'] });
  h.emit('terminal-resize', a, 's1', 120, 30);
  h.timers.advance(1000);
  const BEFORE_THE_STOP = ['resize', 'resize', 'resize']; // the size and its two nudge steps
  assert.deepEqual(s.pty.calls.map((c) => c.op), BEFORE_THE_STOP);
  assert.equal(s.firstResize, false, 'the nudge is used up');
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  // Window b opens it: a reattach. The same happens when window a reloads.
  const answer = await h.invoke('open-terminal', b, 's1', PROJECT, false);
  assert.equal(answer.ok, true);
  assert.equal(answer.reattached, true, 'the reattach answers as today');
  assert.equal(h.registry.ownerId('s1'), b.id);
  assert.equal(s.firstResize, true, 'and re-arms the nudge as today');
  h.emit('terminal-resize', b, 's1', 100, 40);
  h.emit('terminal-input', b, 's1', 'x');
  h.timers.advance(1000);
  assert.deepEqual(s.pty.calls.map((c) => c.op), [...BEFORE_THE_STOP, 'kill'], "the new owner's size, both nudge steps and its typing reach no pty");
  assert.deepEqual(await stopStates(h, b), [], 'a Stop that is still pending is not listed');
  h.timers.advance(7000);
  assert.deepEqual(await stopStates(h, b), ['s1'], 'listed from the 8 s mark on');
  // Opened once more after the stall: still nothing reaches the pty, still listed.
  assert.equal((await h.invoke('open-terminal', a, 's1', PROJECT, false)).reattached, true);
  h.emit('terminal-resize', a, 's1', 90, 30);
  h.emit('terminal-input', a, 's1', 'y');
  h.timers.advance(1000);
  assert.deepEqual(s.pty.calls.map((c) => c.op), [...BEFORE_THE_STOP, 'kill']);
  assert.deepEqual(await stopStates(h, a), ['s1']);
  assert.equal(env.spawned.length, 0, 'no process was started');
});

test('main-pty-wiring: a stop that stalled, then one more Stop with wait, then a late end: listed from the 8 s mark until the exit, the waiting Stop answers ended true, and the stall is reported once', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'stop', 'stopStates'], globals: env.globals });
  const a = h.window();
  const reports = () => plain(h.globals.mainFaults.calls.filter((c) => c[0] === 'report'));
  const { proc } = await start(h, env, a, 's1');
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  h.timers.advance(8000);
  assert.deepEqual(await stopStates(h, a), ['s1']);
  assert.deepEqual(reports(), [['report', 'stop-stalled', null, { sessionId: 's1' }]]);
  let late = 'no answer yet';
  const waiting = Promise.resolve(h.invoke('stop-session', a, 's1', { wait: true })).then((answer) => { late = plain(answer); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late, 'no answer yet', 'the second Stop waits for its own kill');
  assert.deepEqual(proc.calls.map((c) => c.op), ['kill', 'kill'], 'after the stall one more kill went out');
  h.timers.advance(5000);
  assert.deepEqual(await stopStates(h, a), ['s1'], 'still listed until the terminal ends');
  const from = a.sent.length;
  proc.emitExit({ exitCode: 0 });
  await waiting;
  assert.deepEqual(late, { ok: true, ended: true });
  assert.deepEqual(got(a, 'process-exited', from), [['process-exited', 's1', 0, undefined, true]], 'the exit report carries the stop flag');
  assert.deepEqual(await stopStates(h, a), [], 'not listed once it has ended');
  h.timers.advance(60000);
  assert.equal(reports().length, 1, 'one stop-stalled report, not two: the second kill ended the terminal inside its own 8 s');
});

test('main-pty-wiring: a Stop from one window and, inside the 8 s, a Stop and an Archive from another window send no second kill; the Archive is answered by the first kill, and after the stall one more Stop sends one more', async () => {
  const h = boot({ blocks: ['stop'] });
  const a = h.window();
  const b = h.window();
  const s = h.session('s1', { owner: a });
  assert.deepEqual(plain(await h.invoke('stop-session', a, 's1')), { ok: true });
  h.timers.advance(2000);
  let archive = 'no answer yet';
  const waiting = Promise.resolve(h.invoke('stop-session', b, 's1', { wait: true })).then((answer) => { archive = plain(answer); });
  h.timers.advance(5999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive, 'no answer yet', "the other window's Archive waits on the first kill");
  assert.deepEqual(plain(await h.invoke('stop-session', b, 's1')), { ok: true }, "the other window's plain Stop answers ok");
  assert.equal(ptyCalls(s, 'kill').length, 1, 'one kill for the three calls');
  h.timers.advance(1);
  await waiting;
  assert.deepEqual(archive, { ok: true, ended: false }, 'answered at the 8 s mark of the FIRST kill, not 8 s after its own call');
  assert.equal(ptyCalls(s, 'kill').length, 1);
  assert.deepEqual(plain(await h.invoke('stop-session', b, 's1')), { ok: true });
  assert.equal(ptyCalls(s, 'kill').length, 2, 'after the stall one more Stop sends one more kill');
});

test('main-pty-wiring: a re-key between a Stop with wait and the end: the waiting answer still comes, the exit is reported once under the new id, and a Stop under either id in between sends no second kill', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
  const a = h.window();
  const b = h.window();
  const { proc } = await start(h, env, a, 'id-1');
  let first = 'no answer yet';
  const waiting = Promise.resolve(h.invoke('stop-session', a, 'id-1', { wait: true })).then((answer) => { first = plain(answer); });
  h.timers.advance(2000);
  rekeyByHand(h, 'id-1', 'id-2'); // a fork, a plan-accept or a /clear inside the 8 s
  assert.deepEqual(plain(await h.invoke('stop-session', a, 'id-1')), { ok: false, error: 'not running', rekeyedTo: 'id-2' });
  assert.deepEqual(plain(await h.invoke('stop-session', a, 'id-2')), { ok: true }, 'what the page then sends under the new id');
  assert.deepEqual(proc.calls.map((c) => c.op), ['kill'], 'neither sends a second kill');
  assert.equal(first, 'no answer yet');
  const from = [a.sent.length, b.sent.length];
  proc.emitExit({ exitCode: 0 });
  await waiting;
  assert.deepEqual(first, { ok: true, ended: true }, 'the wait is on the record, not on the id');
  for (const [win, start] of [[a, from[0]], [b, from[1]]]) {
    assert.deepEqual(got(win, 'process-exited', start), [['process-exited', 'id-2', 0, undefined, true]], 'one report, under the new id');
  }
  assert.equal(h.activeSessions.size, 0);
});

test("main-pty-wiring: once another terminal is started under an id, that id no longer leads to the terminal that moved on: a Stop under it stops the second terminal while it runs, and after its end answers 'not running' with no rekeyedTo and stops nothing else", async () => {
  const two = async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const first = await start(h, env, a, 'id-1');
    rekeyByHand(h, 'id-1', 'id-2');
    // Until another terminal is started under it, the old id is answered with where it went.
    assert.deepEqual(plain(await h.invoke('stop-session', a, 'id-1')), { ok: false, error: 'not running', rekeyedTo: 'id-2' });
    const second = await start(h, env, b, 'id-1', { isNew: false });
    return { h, a, b, first, second };
  };
  // The Stop comes BEFORE the second terminal has ended: the terminal stored under the id is stopped.
  {
    const { h, b, first, second } = await two();
    assert.equal((first.session.priorIds || []).includes('id-1'), false, 'from the start of the second terminal on, id-1 is no earlier id of the first');
    assert.deepEqual(plain(await h.invoke('stop-session', b, 'id-1')), { ok: true });
    assert.deepEqual(second.proc.calls.map((c) => c.op), ['kill']);
    second.proc.emitExit({ exitCode: 0 });
    // One more Stop under the same id, sent late: a second click on the row, confirmed after the end.
    assert.deepEqual(plain(await h.invoke('stop-session', b, 'id-1')), { ok: false, error: 'not running' }, 'no rekeyedTo');
    assert.deepEqual(first.proc.calls, [], 'the terminal that moved on is not stopped');
    assert.notEqual(first.session.stopRequested, true);
  }
  // The Stop comes only AFTER the second terminal has ended by itself.
  {
    const { h, a, b, first, second } = await two();
    second.proc.emitExit({ exitCode: 0 });
    for (const win of [a, b]) {
      assert.deepEqual(plain(await h.invoke('stop-session', win, 'id-1')), { ok: false, error: 'not running' }, 'no rekeyedTo');
      assert.deepEqual(plain(await h.invoke('stop-session', win, 'id-1', { wait: true })), { ok: false, error: 'not running' }, 'the same with wait');
    }
    h.timers.advance(60000);
    assert.deepEqual(first.proc.calls, [], 'nothing else is stopped, then or later');
    assert.notEqual(first.session.stopRequested, true);
    assert.equal(h.activeSessions.get('id-2'), first.session, 'the terminal that moved on is still on the list');
    assert.deepEqual(plain(await h.invoke('stop-session', a, 'id-2')), { ok: true }, 'under its own id it is stopped as ever');
    assert.deepEqual(first.proc.calls.map((c) => c.op), ['kill']);
  }
});

test("main-pty-wiring: a pty error on a live terminal is reported as 'pty' under the id it has now; after a Stop or an exit it is not reported", async () => {
  const env = spawnFakes();
  const spawn = env.globals.pty.spawn;
  // The fake process of spawnFakes, with the 'error' event a real terminal has.
  const pty = {
    spawn(...args) {
      const proc = spawn(...args);
      const listeners = [];
      proc.on = (name, fn) => { if (name === 'error') listeners.push(fn); };
      proc.emitError = (error) => { for (const fn of listeners) fn(error); };
      return proc;
    },
  };
  const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: { ...env.globals, pty } });
  const a = h.window();
  const reports = () => h.globals.mainFaults.calls.filter((c) => c[0] === 'report');
  const { proc } = await start(h, env, a, 's1');
  proc.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(reports().length, 0, 'a broken pipe on a live terminal is not news');
  const fault = Object.assign(new Error('read EIO'), { code: 'EIO' });
  proc.emitError(fault);
  rekeyByHand(h, 's1', 's1-new');
  proc.emitError(fault);
  assert.deepEqual(reports().map((c) => [c[1], c[2], plain(c[3])]), [['pty', fault, { sessionId: 's1' }], ['pty', fault, { sessionId: 's1-new' }]]);
  await h.invoke('stop-session', a, 's1-new');
  proc.emitError(fault);
  proc.emitExit({ exitCode: 0 });
  proc.emitError(fault);
  assert.equal(reports().length, 2, 'after a Stop or an exit a socket error is a debug line');
});

test("main-pty-wiring: a plain terminal's start-up line goes through the guard: once at 300 ms for a live terminal, never for one that was stopped or has ended", async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open', 'stop'], globals: env.globals });
  const a = h.window();
  const live = await start(h, env, a, 't-live', { options: { type: 'terminal' } });
  const stopped = await start(h, env, a, 't-stopped', { options: { type: 'terminal' } });
  const ended = await start(h, env, a, 't-ended', { options: { type: 'terminal' } });
  const claude = await start(h, env, a, 's1');
  h.timers.advance(100);
  await h.invoke('stop-session', a, 't-stopped');
  ended.proc.emitExit({ exitCode: 0 });
  h.timers.advance(199);
  assert.deepEqual(live.proc.calls, [], 'nothing at 299 ms');
  h.timers.advance(1);
  assert.equal(live.proc.calls.length, 1);
  assert.equal(live.proc.calls[0].op, 'write');
  assert.ok(live.proc.calls[0].data.startsWith('claude() {'), 'the shell function');
  assert.ok(live.proc.calls[0].data.endsWith(' clear\n'), 'then clear');
  h.timers.advance(60000);
  assert.equal(live.proc.calls.length, 1, 'once');
  assert.deepEqual(stopped.proc.calls.map((c) => c.op), ['kill'], 'nothing is typed into a stopping terminal');
  assert.deepEqual(ended.proc.calls, [], 'nor into one that has ended');
  assert.deepEqual(claude.proc.calls, [], 'a Claude session gets no start-up line');
});

test('main-pty-wiring: delete-track and before-quit kill through the guard: no second kill from delete-track for a session whose Stop was sent, and a failed kill is logged under its tag with the session id', async () => {
  const fakes = trackFakes();
  const h = boot({ blocks: ['stop', 'guarded', 'deleteTrack'], globals: fakes.globals });
  const a = h.window();
  const stopping = h.session('s-stopping', { owner: a, trackId: 'track-1' });
  const failing = killThrows(h.session('s-throws', { trackId: 'track-1' }));
  await h.invoke('stop-session', a, 's-stopping');
  assert.equal((await h.invoke('delete-track', a, 'track-1', { archiveSessions: true })).ok, true);
  assert.equal(ptyCalls(stopping, 'kill').length, 1, 'its Stop was sent: delete-track sends no second kill');
  assert.equal(ptyCalls(failing, 'kill').length, 1);
  assert.equal(failing.stopRequested, true);
  const tagged = h.log.lines.filter((l) => l.includes('[delete-track]'));
  assert.equal(tagged.length, 1, 'one line, for the kill that failed');
  assert.match(tagged[0], /^error \[delete-track\] session=s-throws kill failed: the pty is closed/);
  // A kill that throws inside delete-track is reported like a failed Stop (Jason's answer CK-B).
  assert.deepEqual(h.globals.mainFaults.calls.filter((c) => c[0] === 'report').map((c) => [c[1], c[2].message, plain(c[3])]), [['stop-failed', 'the pty is closed', { sessionId: 's-throws' }]], 'one stop-failed report, with the session id, for the kill that threw; none for the session whose Stop went through');

  const q = quitFakes();
  const atQuit = boot({ blocks: ['resize', 'beforeQuit'], globals: q.globals });
  const b = atQuit.window();
  q.session(atQuit, 's-bad', { killFails: true });
  const ok = q.session(atQuit, 's-ok', { owner: b });
  q.quit();
  const quitLines = atQuit.log.lines.filter((l) => l.includes('[quit]'));
  assert.equal(quitLines.length, 1);
  assert.match(quitLines[0], /^error \[quit\] session=s-bad kill failed: the pty is closed/);
  atQuit.emit('terminal-resize', b, 's-ok', 100, 40);
  atQuit.timers.advance(1000);
  assert.deepEqual(ok.pty.calls.map((c) => c.op), ['kill'], "after quit's kill a late resize reaches no pty");
});

test("main-pty-wiring: main.js has no direct '.pty.resize(', '.pty.write(' or '.pty.kill(' left", () => {
  const src = sourceOf('main.js');
  // Also the start-up line's old form, ptyProcess.write(: there is no exception.
  const direct = src.match(/\b(?:pty|ptyProcess)\s*\.\s*(?:write|resize|kill)\s*\(/g) || [];
  assert.deepEqual(direct, [], 'every terminal write, resize and kill goes through ptyGuard, in comments too');
  for (const call of ['ptyGuard.write(', 'ptyGuard.resize(', 'ptyGuard.kill(']) assert.ok(src.includes(call), call);
  assert.equal(src.includes('_isDisposed'), false, "the start-up line asks the guard, not a field the terminal object does not have");
});

// --- /clear re-key: the terminal's tag ---

test('main-pty-wiring: a Claude terminal gets a tag of its own in its environment and on its record, with one log line; a plain terminal gets none', async () => {
  const env = spawnFakes();
  const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
  const a = h.window();
  const one = await start(h, env, a, 's1');
  const two = await start(h, env, a, 's2');
  const term = await start(h, env, a, 't1', { options: { type: 'terminal' } });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const tagLines = () => h.log.lines.filter((line) => line.includes('[terminal-tag]'));

  for (const [id, started] of [['s1', one], ['s2', two]]) {
    assert.match(started.session.hostToken, UUID, id);
    assert.equal(started.proc.options.env.SWITCHBOARD_TERMINAL_ID, started.session.hostToken, id + ': the same tag in the environment handed to pty.spawn');
    assert.deepEqual(tagLines().filter((line) => line.includes('session=' + id + ' ')),
      [`info [terminal-tag] session=${id} tag=${started.session.hostToken.slice(0, 8)}`]);
  }
  assert.notEqual(one.session.hostToken, two.session.hostToken, 'two terminals, two tags');
  assert.equal(term.session.hostToken, null, 'a plain terminal has no tag');
  assert.equal('SWITCHBOARD_TERMINAL_ID' in term.proc.options.env, false);
  assert.equal(tagLines().length, 2, 'and no line');
});

test('main-pty-wiring: a terminal started again under the id of one that ended gets a tag of its own and a second log line; opening a running terminal again starts nothing and keeps its tag', async (t) => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const tagLines = (h, id) => h.log.lines.filter((line) => line.startsWith('info [terminal-tag] session=' + id + ' '));

  await t.test('a session that ended and is started again under the same id (a resume): two tags, each in its own environment, and two lines', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const first = await start(h, env, a, 's1');
    const firstTag = first.session.hostToken;
    assert.match(firstTag, UUID);
    first.proc.emitExit({ exitCode: 0, signal: undefined });
    assert.equal(h.activeSessions.has('s1'), false, 'the first terminal has ended and left the list');

    const second = await start(h, env, a, 's1', { isNew: false });
    assert.match(second.session.hostToken, UUID);
    assert.notEqual(second.session.hostToken, firstTag, 'the second terminal has a tag of its own');
    assert.equal(second.proc.options.env.SWITCHBOARD_TERMINAL_ID, second.session.hostToken, 'the second tag in the environment of the second spawn');
    assert.equal(first.proc.options.env.SWITCHBOARD_TERMINAL_ID, firstTag, "the first terminal's environment still has the first tag");
    assert.equal(first.session.hostToken, firstTag, "and so has the first terminal's record");
    assert.deepEqual(tagLines(h, 's1'),
      [firstTag, second.session.hostToken].map((tag) => `info [terminal-tag] session=s1 tag=${tag.slice(0, 8)}`));
  });

  await t.test('open-terminal for a terminal that is already running (a window reload, another window): nothing is started, the tag stays, no second line', async () => {
    const env = spawnFakes();
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    const a = h.window();
    const b = h.window();
    const { session, proc } = await start(h, env, a, 's1');
    const tag = session.hostToken;
    assert.match(tag, UUID);
    for (const win of [a, b]) {
      const answer = await h.invoke('open-terminal', win, 's1', PROJECT, false, undefined);
      assert.equal(answer.ok, true);
      assert.equal(answer.reattached, true);
    }
    assert.equal(env.spawned.length, 1, 'one process in all');
    assert.equal(h.activeSessions.get('s1'), session, 'the same record');
    assert.equal(session.hostToken, tag, 'with the tag it started with');
    assert.equal(proc.options.env.SWITCHBOARD_TERMINAL_ID, tag);
    assert.equal(tagLines(h, 's1').length, 1, 'a reattach writes no [terminal-tag] line');
  });
});

// --- /clear re-key: typing and resize follow a re-key for 5 seconds ---

const NOW_MS = 1800000000000;
/**
 * Both handlers on a clock that stands at NOW_MS (a block's Date is its own global, so the fake goes in
 * through globals). One session, shown by window `a`, stored under 'old-id' and moved to 'new-id'
 * `agoMs` before. rekeyByHand is the move of before /clear and does not stamp it, so the stamp is set here.
 */
function movedBoot(agoMs, { blocks = ['input', 'resize'] } = {}) {
  const h = boot({ blocks, globals: { Date: { now: () => NOW_MS } } });
  const a = h.window();
  const b = h.window();
  const s = h.session('old-id', { owner: a, firstResize: false });
  rekeyByHand(h, 'old-id', 'new-id');
  s.rekeyedAtMs = NOW_MS - agoMs;
  return { h, a, b, s };
}

test('main-pty-wiring: typing and resize under the id a session left at most 5 s ago reach its terminal, and the owner rule is asked under the live id', async (t) => {
  await t.test('4 s after the move: typing under the earlier id is one write to the moved terminal', () => {
    const { h, a, s } = movedBoot(4000);
    h.emit('terminal-input', a, 'old-id', 'x');
    assert.deepEqual(writes(s), ['x']);
    assert.equal(s.pty.calls.length, 1);
  });

  await t.test('4 s after the move: a resize under the earlier id reaches the moved terminal once', () => {
    const { h, a, s } = movedBoot(4000);
    h.emit('terminal-resize', a, 'old-id', 100, 30);
    assert.deepEqual(resizes(s), [[100, 30, 0]]);
    h.timers.advance(1000);
    assert.equal(s.pty.calls.length, 1);
  });

  await t.test('exactly 5 s is still followed; 5001 ms and 6 s are not', () => {
    const edge = movedBoot(5000);
    edge.h.emit('terminal-input', edge.a, 'old-id', 'x');
    assert.deepEqual(writes(edge.s), ['x']);
    for (const agoMs of [5001, 6000]) {
      const late = movedBoot(agoMs);
      late.h.emit('terminal-input', late.a, 'old-id', 'x');
      late.h.emit('terminal-resize', late.a, 'old-id', 100, 30);
      assert.deepEqual(late.s.pty.calls, [], agoMs + ' ms');
    }
  });

  await t.test('the live id itself works as before, whatever the age of the move', () => {
    const { h, a, s } = movedBoot(60000);
    h.emit('terminal-input', a, 'new-id', 'x');
    h.emit('terminal-resize', a, 'new-id', 100, 30);
    assert.deepEqual(writes(s), ['x']);
    assert.deepEqual(resizes(s), [[100, 30, 0]]);
  });

  await t.test('an older earlier id is never followed', () => {
    const { h, a, s } = movedBoot(1000);
    s.priorIds = ['first-id', 'old-id'];
    h.emit('terminal-input', a, 'first-id', 'x');
    h.emit('terminal-resize', a, 'first-id', 100, 30);
    assert.deepEqual(s.pty.calls, []);
  });

  await t.test('a window that does not own the live id types and resizes under the earlier id: nothing reaches the pty', () => {
    const { h, a, b, s } = movedBoot(4000);
    assert.equal(h.registry.ownerId('old-id'), null, 'the earlier id has no owner any more');
    assert.equal(h.registry.ownerId('new-id'), a.id);
    h.emit('terminal-input', b, 'old-id', 'typed in the other window\r');
    h.emit('terminal-resize', b, 'old-id', 100, 30);
    h.emit('terminal-input', NO_WINDOW, 'old-id', 'typed in no window\r');
    assert.deepEqual(s.pty.calls, []);
  });

  await t.test('the exact key wins: a second terminal stored under the earlier id gets what is addressed to it, the moved one gets none of it', () => {
    const { h, a, b, s } = movedBoot(4000);
    const resumed = h.session('old-id', { owner: b, firstResize: false });   // the cleared conversation, opened again
    h.emit('terminal-input', b, 'old-id', 'r');
    h.emit('terminal-resize', b, 'old-id', 90, 20);
    assert.deepEqual(writes(resumed), ['r']);
    assert.deepEqual(resizes(resumed), [[90, 20, 0]]);
    h.emit('terminal-input', a, 'old-id', 'x');   // a does not own the terminal that is under 'old-id' now
    assert.deepEqual(s.pty.calls, []);
    assert.equal(resumed.pty.calls.length, 2);
  });

  await t.test('a moved terminal that has ended is not followed', () => {
    const { h, a, s } = movedBoot(4000);
    s.exited = true;
    h.emit('terminal-input', a, 'old-id', 'x');
    h.emit('terminal-resize', a, 'old-id', 100, 30);
    assert.deepEqual(s.pty.calls, []);
  });

  // A guard, not a test of this commit: it passes before and after. Stop never follows (design change 26).
  await t.test('stop-session under the earlier id, 4 s after the move, kills nothing and says where the session went', async () => {
    const { h, a, s } = movedBoot(4000, { blocks: ['stop', 'input', 'resize'] });
    const answer = await h.invoke('stop-session', a, 'old-id');
    assert.deepEqual({ ...answer }, { ok: false, error: 'not running', rekeyedTo: 'new-id' });
    assert.deepEqual(ptyCalls(s, 'kill'), []);
    assert.notEqual(s.stopRequested, true);
  });
});

// --- /clear re-key: what main.js hands the detector ---

test('main-pty-wiring: main.js hands the detector copyStar, the note reader, broadcast and ownerId; the reader reads only <id>.origin.json of the claude-ctx folder', () => {
  const path = require('path');
  const ID = '11111111-2222-3333-4444-555555555555';
  const ABSENT = '99999999-2222-3333-4444-555555555555';
  const NOTE = { v: 1, session_id: ID };
  // Two cuts joined: the id pattern main.js already has, then the detector's wiring.
  const text = cut('main.js', 'const CTX_ID_RE = ', '// → { value, code }: code')
    + cut('main.js', "const sessionTransitions = require('./session-transitions');", '// --- fs.watch on projects directory ---');
  const run = (env) => {
    let given = null;
    const reads = [];
    const lines = [];
    const registry = { sendToOwner() {}, rekeyOwner() {}, broadcast() {}, ownerId() {} };
    const dbModule = { rekeyScheduleSession() {}, copyStar() {} };
    const fakes = { copySessionAssignment() {}, rekeyPlanLinks() {}, rekeyMcpServer() {} };
    const logAt = (level) => (...args) => { lines.push(level + ' ' + args.join(' ')); };
    load(text, { file: 'main.js', globals: {
      // This one load is the test's own, not a boot of the harness: no other block shares these globals.
      // It needs a stand-in that records what init is handed, and through `modules` the helper would
      // hand the block the REAL ./session-transitions (the file exists), so the require is given here.
      require: (name) => {
        assert.equal(name, './session-transitions');
        return { init: (ctx) => { given = ctx; }, detectSessionTransitions() {} };
      },
      PROJECTS_DIR: 'C:\\nowhere\\projects', activeSessions: new Map(),
      log: { debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error') },
      registry, dbModule, ...fakes, path, os: { homedir: () => 'C:\\home' }, process: { env },
      readCtxJson: (p) => {
        reads.push(p);
        return p.endsWith(ID + '.origin.json') ? { value: NOTE, code: null } : { value: null, code: 'ENOENT' };
      },
    } });
    return { given, reads, lines, registry, dbModule, fakes };
  };

  const first = run({ LOCALAPPDATA: 'C:\\la' });
  const dir = path.join('C:\\la', 'claude-ctx');
  assert.equal(first.given.copyStar, first.dbModule.copyStar);
  assert.equal(first.given.broadcast, first.registry.broadcast);
  assert.equal(first.given.ownerId, first.registry.ownerId);
  // What main.js handed over before this commit is still handed over.
  assert.equal(first.given.sendToOwner, first.registry.sendToOwner);
  assert.equal(first.given.rekeyOwner, first.registry.rekeyOwner);
  assert.equal(first.given.rekeyMcpServer, first.fakes.rekeyMcpServer);
  assert.equal(first.given.copySessionAssignment, first.fakes.copySessionAssignment);
  assert.equal(first.given.rekeyPlanLinks, first.fakes.rekeyPlanLinks);
  assert.equal(first.given.rekeyScheduleSession, first.dbModule.rekeyScheduleSession);
  for (const name of ['now', 'setTimer', 'clearTimer']) assert.equal(name in first.given, false, name + " is left to the module's default");

  assert.equal(first.given.readClearOrigin(ID), NOTE);
  assert.equal(first.given.readClearOrigin(ABSENT), null, 'a note that is not there');
  assert.deepEqual(first.reads, [path.join(dir, ID + '.origin.json'), path.join(dir, ABSENT + '.origin.json')]);
  for (const bad of ['..\\..\\x', '', undefined, null, 7, 'not-an-id', ID + '.json', ID + '\\..\\x']) {
    assert.equal(first.given.readClearOrigin(bad), null, JSON.stringify(bad));
  }
  assert.equal(first.reads.length, 2, 'what is not a session id touches no file');
  assert.deepEqual(first.lines.filter((line) => line.includes('[clear-detect]')), ['info [clear-detect] notes dir=' + dir]);

  const second = run({});   // no LOCALAPPDATA: the folder under the home folder, as read-ctx-state has it
  second.given.readClearOrigin(ID);
  assert.deepEqual(second.reads, [path.join('C:\\home', 'AppData', 'Local', 'claude-ctx', ID + '.origin.json')]);
});

test('main-pty-wiring: each of the two lookups of an earlier id names the other in its comment', () => {
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const live = main.indexOf('function resolveLiveSession(sessionId) {');
  assert.ok(live > 0);
  assert.match(main.slice(Math.max(0, live - 2500), live), /resolveInputSession/);
  const transitions = fs.readFileSync(path.join(__dirname, '..', 'session-transitions.js'), 'utf8');
  const input = transitions.indexOf('function resolveInputSession(');
  assert.ok(input > 0);
  assert.match(transitions.slice(Math.max(0, input - 1500), input), /resolveLiveSession/);
});

// --- Launch without Git Bash (task L): the open-terminal handler asks launch-plan.js ---

test('main-pty-wiring: on Windows a session starts claude.exe directly, a missing claude starts nothing, a pre-launch on Auto goes to Git Bash, and a plain terminal types the start-up line only into a shell that needs it', async (t) => {
  const { windowsCommandLine } = require('../launch-plan');
  const CLAUDE_EXE = 'C:\\bin\\claude.exe';
  const GIT_BASH = { root: 'C:\\Git', bash: 'C:\\Git\\bin\\bash.exe' };
  const PATH_ERROR = "claude was not found on PATH (searched the app's PATH; a PATH set only in a shell profile is not read)";
  // A Windows file system that holds only the files named.
  const windowsFs = (...files) => ({
    existsSync: (p) => files.includes(p),
    lstatSync: (p) => (files.includes(p) ? { isSymbolicLink: () => false } : undefined),
  });
  const onWindows = ({ files = [CLAUDE_EXE], gitBash = null, profile = { id: 'auto', path: 'C:\\pwsh\\pwsh.exe', args: [] } } = {}) => {
    const env = spawnFakes();
    env.globals.LAUNCH_HOST = { platform: 'win32', fs: windowsFs(...files), gitBash };
    env.globals.cleanPtyEnv = { Path: 'C:\\bin;C:\\Windows\\System32' };
    env.globals.resolveShell = () => profile;
    const h = boot({ blocks: ['resolve', 'open'], globals: env.globals });
    return { env, h, a: h.window() };
  };

  await t.test('a session: claude.exe with its arguments as one command line, the tag in its environment, and a [launch] line beside [terminal-tag]', async () => {
    const { env, h, a } = onWindows();
    const { session, proc } = await start(h, env, a, 's1');
    assert.equal(proc.shell, CLAUDE_EXE);
    assert.equal(typeof proc.args, 'string', 'node-pty is handed one command line, not an array');
    assert.equal(proc.args, windowsCommandLine(['--session-id', 's1', '--ide']));
    assert.equal(proc.options.env.SWITCHBOARD_TERMINAL_ID, session.hostToken, 'the tag is still in the environment handed to pty.spawn');
    const tagAt = h.log.lines.findIndex((line) => line.startsWith('info [terminal-tag] session=s1 '));
    const launchAt = h.log.lines.indexOf('info [launch] kind=session id=s1 how=direct file=' + CLAUDE_EXE);
    assert.ok(tagAt >= 0, 'the [terminal-tag] line');
    assert.ok(launchAt >= 0, 'the [launch] line');
    assert.equal(Math.abs(launchAt - tagAt), 1, 'the two lines stand together');
  });

  await t.test('claude not found: the answer names PATH, nothing is spawned, and the MCP server of the id is shut down', async () => {
    const { env, h, a } = onWindows({ files: [] });
    const answer = await h.invoke('open-terminal', a, 's1', PROJECT, true);
    assert.equal(answer.ok, false);
    assert.equal(answer.error, PATH_ERROR);
    assert.equal(env.spawned.length, 0, 'nothing was spawned');
    assert.deepEqual(env.mcpStarted, ['s1']);
    assert.deepEqual(env.mcpShutdowns, ['s1'], 'the MCP server started for the id is shut down');
    assert.equal(h.activeSessions.has('s1'), false, 'no record is left');
  });

  await t.test('a pre-launch command on an Auto project with Git Bash: a Git Bash login with the pre-launch, claude and --ide', async () => {
    const { env, h, a } = onWindows({ gitBash: GIT_BASH });
    const { proc } = await start(h, env, a, 's1', { options: { preLaunchCmd: 'aws-vault exec p --' } });
    assert.equal(proc.shell, GIT_BASH.bash);
    assert.deepEqual([...proc.args], ['-l', '-i', '-c', "aws-vault exec p -- claude '--session-id' 's1' --ide"]);
  });

  await t.test('a plain terminal whose profile is pwsh: -NoProfile -NoExit, and nothing typed at 300 ms', async () => {
    const { env, h, a } = onWindows({ profile: { id: 'pwsh', path: 'C:\\pwsh\\pwsh.exe', args: [] } });
    const { proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.equal(proc.shell, 'C:\\pwsh\\pwsh.exe');
    assert.equal(typeof proc.args, 'string');
    assert.ok(proc.args.includes('"-NoProfile" "-NoExit"'), proc.args);
    h.timers.advance(300);
    assert.deepEqual(proc.calls, [], 'no start-up line');
  });

  await t.test('a plain terminal whose profile is cmd: nothing typed', async () => {
    const { env, h, a } = onWindows({ profile: { id: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe', args: [] } });
    const { proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.equal(proc.shell, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual([...proc.args], []);
    h.timers.advance(300);
    assert.deepEqual(proc.calls, [], 'no start-up line');
  });

  await t.test('a plain terminal whose profile is Git Bash: a login shell and the start-up line as today', async () => {
    const { env, h, a } = onWindows({ profile: { id: 'git-bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [] } });
    const { proc } = await start(h, env, a, 't1', { options: { type: 'terminal' } });
    assert.deepEqual([...proc.args], ['-l', '-i']);
    h.timers.advance(300);
    assert.equal(proc.calls.length, 1);
    assert.equal(proc.calls[0].op, 'write');
    assert.ok(proc.calls[0].data.startsWith('claude() {'), 'the shell function');
    assert.ok(proc.calls[0].data.endsWith(' clear\n'), 'then clear');
  });
});

test('main-pty-wiring: the open-terminal handler asks launch-plan.js for the command: planLaunch once, planTerminal once, and no shellArgs or quoteArgvForShell of its own', () => {
  const open = cut('main.js', '// --- IPC: open-terminal ---', "ipcMain.handle('get-window-info', (event) => {");
  const count = (needle) => open.split(needle).length - 1;
  assert.equal(count('planLaunch('), 1);
  assert.equal(count('planTerminal('), 1);
  assert.equal(count('shellArgs('), 0);
  assert.equal(count('quoteArgvForShell('), 0);
});
