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

  // Everything a block of main.js may name. A fix that makes the handlers
  // name something new (the crash guard's ptyGuard, say) adds it HERE, once.
  const shared = {
    ipcMain, activeSessions, registry, log, console: log.console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    // open-terminal's reattach path
    setMcpWindow: (id, win) => { mcpWindows.push([id, win]); },
    panelPaths: { watchWindow: (win) => win },
    ...globals,
  };
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
});

// --- Pin 4: terminal-resize, for a session that has printed nothing yet ---

// PIN, changed on purpose by the crash guard: nothing reaches the pty until the first output, then the last size once; the buffer hold is unchanged and is not set again when the held size is applied.
test("main pty wiring (pin, changed on purpose by the crash guard): a resize before the first output is passed to the pty at once, and a plain terminal's buffer hold runs 200 ms from the call", async (t) => {
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

    await t.test(`${shape}: a Claude session's resize reaches the pty inside the call`, () => {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = silent(h, 's1', { owner: a });
      h.emit('terminal-resize', a, 's1', 120, 30);
      assert.deepEqual(resizes(s), [[120, 30, 0]], 'before any timer ran and before any output');
    });

    await t.test(`${shape}: a Claude session's two nudge resizes reach the pty too, at 50 and 100 ms, with still no output`, () => {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = silent(h, 's1', { owner: a });
      h.emit('terminal-resize', a, 's1', 120, 30);
      h.timers.advance(1000);
      assert.deepEqual(resizes(s), [[120, 30, 0], [121, 30, 50], [120, 30, 100]]);
    });

    await t.test(`${shape}: a plain terminal's resize reaches the pty inside the call, and the buffer hold runs 200 ms from the call`, () => {
      const h = boot({ blocks: ['resize'] });
      const a = h.window();
      const s = silent(h, 't1', { owner: a, isPlainTerminal: true });
      h.emit('terminal-resize', a, 't1', 100, 40);
      assert.deepEqual(resizes(s), [[100, 40, 0]], 'before any timer ran and before any output');
      assert.equal(ptyCalls(s, 'resize')[0].bufferHeld, true);
      h.timers.advance(199);
      assert.equal(s._suppressBuffer, true, 'still held at 199 ms');
      h.timers.advance(1);
      assert.equal(s._suppressBuffer, false, 'released 200 ms after the call, with no output in between');
      h.timers.advance(1000);
      assert.equal(s.pty.calls.length, 1);
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

// PIN, changed on purpose by the crash guard: another live terminal stored under the first id will stay in the list with its owner and get no exit report; the first id is reported and cleared only while it still points at the terminal that ended.
test('main pty wiring (pin, second case changed on purpose by the crash guard): the exit report goes to every window with the stop flag under the live id and the record and owner are cleared; today, when another live terminal is stored under the first id, it is reported ended, removed and un-owned as well', async (t) => {
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

  // SECOND CASE: TODAY'S FAULT, pinned as the code behaves. The first
  // terminal starts under id-1 and is re-keyed to id-2. Then the row of id-1
  // is opened again: no adopt, nothing stored under id-1, so a second
  // terminal starts under it. When the first one ends, the exit code acts on
  // whatever is stored under the id it started with, and that is the second.
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

  await t.test('today: another live terminal stored under the first id is reported ended with the first one\'s code, signal and stop flag, is removed from the list and loses its owner', async () => {
    const { env, h, a, b, first, second } = await twoTerminalsOneFirstId();
    const from = [a.sent.length, b.sent.length];
    assert.equal((await h.invoke('stop-session', a, 'id-2')).ok, true);
    first.proc.emitExit({ exitCode: 1, signal: 15 });

    // Two reports to every window: the terminal that ended under its live
    // id, then the one that did not end, under the id it is stored under.
    for (const [win, start] of [[a, from[0]], [b, from[1]]]) {
      assert.deepEqual(got(win, 'process-exited', start), [
        ['process-exited', 'id-2', 1, 15, true],
        ['process-exited', 'id-1', 1, 15, true],
      ]);
    }
    assert.equal(h.activeSessions.has('id-2'), false);
    assert.equal(h.activeSessions.has('id-1'), false, 'the second terminal is off the list');
    assert.equal(h.activeSessions.size, 0);
    assert.equal(h.registry.ownerId('id-2'), null);
    assert.equal(h.registry.ownerId('id-1'), null, 'and no window owns it');

    // It did not end, was not stopped, and nothing of its own was cleaned up.
    assert.equal(first.session.exited, true);
    assert.equal(second.session.exited, false);
    assert.notEqual(second.session.stopRequested, true);
    assert.deepEqual(second.proc.calls, [], 'its process was not killed');
    assert.deepEqual(env.mcpShutdowns, ['id-2'], 'only the first terminal\'s MCP server was shut down');
    assert.ok(second.session.mcpServer);
  });

  await t.test('today: that second terminal runs on where nothing reaches it: its output goes to no window and stop-session answers not running', async () => {
    const { h, a, b, first, second } = await twoTerminalsOneFirstId();
    second.proc.emitData('before');
    assert.deepEqual(got(b, 'terminal-data'), [['terminal-data', 'id-1', 'before']], 'until then its window gets its output');

    first.proc.emitExit({ exitCode: 0, signal: undefined });
    const from = [a.sent.length, b.sent.length];
    second.proc.emitData('after');
    assert.deepEqual(a.sent.slice(from[0]), []);
    assert.deepEqual(b.sent.slice(from[1]), [], 'its output reaches no window');
    assert.deepEqual([...second.session.outputBuffer], ['before', 'after'], 'though the process still prints');

    const answer = await h.invoke('stop-session', b, 'id-1');
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'not running');
    assert.deepEqual(second.proc.calls, [], 'so it cannot be stopped from the app');
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
});
