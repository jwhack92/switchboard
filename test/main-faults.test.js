'use strict';
// main-faults.js, the crash guard's fault list and fault file, tested in plain
// Node: no Electron, no app. Every test runs the REAL module over fakes (a log,
// an app, a dialog, a process, a window, a broadcast) in a temp folder of its
// own, on a hand-made clock that only advance() moves, so no test waits for
// real time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cut, load, peek } = require('../test-support/source-cut');
const { createMainFaults } = require('../main-faults');

/** Hand-made timers on a clock that only advance() moves: fakeTimers() of test/main-pty-wiring.test.js, starting at `start`. */
function fakeClock(start) {
  let now = start;
  let seq = 0;
  let pending = [];
  const add = (fn, ms, args) => {
    const delay = Number(ms) > 0 ? Number(ms) : 0;
    const timer = { id: ++seq, at: now + delay, fn, args, unref: () => timer, ref: () => timer, hasRef: () => true };
    pending.push(timer);
    return timer;
  };
  const drop = (timer) => { pending = pending.filter((t) => t !== timer && t.id !== timer); };
  return {
    setTimeout: (fn, ms, ...args) => add(fn, ms, args),
    clearTimeout: drop,
    get now() { return now; },
    /** Moves the clock on by ms and runs every timer that falls due, in order. A callback that throws, throws here. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        drop(due);
        due.fn(...due.args);
      }
      now = end;
    },
  };
}

/** What a fake process, app, window or webContents is made of: listeners by name. None of the four uses `this`. */
function emitter() {
  let listeners = [];
  return {
    on: (name, fn) => { listeners.push({ name, fn, once: false }); },
    once: (name, fn) => { listeners.push({ name, fn, once: true }); },
    emit: (name, ...args) => {
      for (const listener of listeners.filter((l) => l.name === name)) {
        if (listener.once) listeners = listeners.filter((l) => l !== listener);
        listener.fn(...args);
      }
    },
    count: (name) => listeners.filter((l) => l.name === name).length,
  };
}

/**
 * The real module over fakes, in a temp folder of its own.
 *   opts.prefill          the fault file before the factory runs: an array of objects (JSON lines) or a string
 *   opts.oldPrefill       a string for main-faults.old.log
 *   opts.logThrows        every level of the log throws
 *   opts.noLogFile        the log has no `transports`
 *   opts.noAppPath        app.getPath throws
 *   opts.dialog === null  the factory is handed null for the dialog
 *   opts.dialogThrows     showErrorBox throws
 *   opts.onBox            called first inside showErrorBox, with no argument, before the box is noted
 *   opts.broadcastThrows  the broadcast throws
 */
function make(opts = {}) {
  const h = {};
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-main-faults-'));
  h.file = path.join(h.dir, 'main-faults.log');
  h.oldFile = path.join(h.dir, 'main-faults.old.log');
  if (Array.isArray(opts.prefill)) fs.writeFileSync(h.file, opts.prefill.map((line) => JSON.stringify(line) + '\n').join(''));
  else if (typeof opts.prefill === 'string') fs.writeFileSync(h.file, opts.prefill);
  if (typeof opts.oldPrefill === 'string') fs.writeFileSync(h.oldFile, opts.oldPrefill);
  if (opts.noLogFile && !opts.noAppPath) fs.mkdirSync(path.join(h.dir, 'from-app', 'logs'), { recursive: true });   // the module does not create folders

  h.clock = fakeClock(1000000);

  const logCalls = [];
  const level = (name) => (...args) => {
    if (opts.logThrows) throw new Error('the log throws');
    logCalls.push([name, ...args]);
  };
  h.log = { calls: logCalls, error: level('error'), warn: level('warn'), info: level('info'), debug: level('debug') };
  if (!opts.noLogFile) h.log.transports = { file: { getFile: () => ({ path: path.join(h.dir, 'main.log') }) } };
  h.logged = (name) => h.log.calls.filter((c) => c[0] === name);

  const appCalls = [];
  const appEvents = emitter();
  const noted = (name) => (...args) => { appCalls.push([name, ...args]); return name; };
  h.app = {
    calls: appCalls,
    on: appEvents.on,
    emit: appEvents.emit,
    quit: noted('quit'),
    exit: noted('exit'),
    relaunch: noted('relaunch'),
    getVersion: () => '9.9.9',
    getPath: (n) => { if (opts.noAppPath) throw new Error('the app has no path'); return path.join(h.dir, 'from-app', n); },
  };

  const boxes = [];
  h.dialog = {
    boxes,
    showErrorBox(title, content) {
      if (typeof opts.onBox === 'function') opts.onBox();
      if (opts.dialogThrows) throw new Error('the dialog throws');
      boxes.push([title, content]);
    },
  };

  h.sent = [];
  const broadcast = (channel, record) => {
    if (opts.broadcastThrows) throw new Error('the broadcast throws');
    h.sent.push([channel, record]);
  };

  const stderrText = [];
  h.stderr = { text: stderrText, write(s) { stderrText.push(s); } };

  const procEvents = emitter();
  h.proc = { on: procEvents.on, emit: procEvents.emit, count: procEvents.count };

  h.win = () => {
    const own = emitter();
    const contents = emitter();
    return { on: own.on, emit: own.emit, webContents: { on: contents.on, once: contents.once, emit: contents.emit } };
  };

  h.faults = createMainFaults({
    log: h.log,
    app: h.app,
    dialog: opts.dialog === null ? null : h.dialog,
    broadcast,
    now: () => h.clock.now,
    stderr: h.stderr,
    setTimer: h.clock.setTimeout,
    clearTimer: h.clock.clearTimeout,
  });

  h.lines = (file = h.file) => {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  h.loaded = () => {
    const win = h.win();
    h.faults.noteWindow(win);
    win.webContents.emit('did-finish-load');
    return win;
  };
  return h;
}

test('main-faults: an uncaught exception after a window has loaded is logged once with its stack, written to the fault file, and shows no box', () => {
  const h = make();
  h.faults.installListeners(h.proc);
  assert.equal(h.proc.count('uncaughtException'), 1);
  assert.equal(h.proc.count('unhandledRejection'), 1);
  h.loaded();
  const err = new Error('disk on fire');
  h.proc.emit('uncaughtException', err, 'uncaughtException');
  const errors = h.logged('error');
  assert.equal(errors.length, 1);
  assert.match(errors[0][1], /^\[main-fault\] kind=internal id=\S+ origin=uncaughtException$/);
  assert.equal(errors[0][2], err.stack);
  const lines = h.lines();
  assert.deepEqual(lines.map((l) => l.ev), ['start', 'fault']);
  assert.deepEqual([lines[0].version, typeof lines[0].pid, lines[0].run === lines[1].run], ['9.9.9', 'number', true]);
  const { t, run, ...fault } = lines[1];
  const list = h.faults.list();
  assert.deepEqual(fault, { ev: 'fault', id: list[0].id, kind: 'internal', origin: 'uncaughtException', n: 1, firstLine: 'Error: disk on fire', sessionId: null, stack: err.stack });
  assert.deepEqual(list, [{ id: list[0].id, kind: 'internal', sessionId: null, firstLine: 'Error: disk on fire', count: 1, firstAt: 1000000, lastAt: 1000000, previousRun: false, dismissed: false, stack: err.stack, runErrors: 0 }]);
  assert.deepEqual(h.sent, [['main-fault', list[0]]]);
  assert.deepEqual(h.dialog.boxes, []);
  assert.deepEqual(h.app.calls, []);
  assert.equal(h.faults.logFile(), h.file);
});

test('main-faults: 1000 identical faults in one second give at most 3 full entries and one summary, at most 3 notice sends, and a last send carrying count 1000', () => {
  const h = make();
  h.faults.installListeners(h.proc);
  h.loaded();
  const err = new Error('same again');
  for (let i = 0; i < 1000; i++) { h.proc.emit('uncaughtException', err); h.clock.advance(1); }
  assert.equal(h.logged('error').length, 3);
  assert.deepEqual(h.logged('warn'), []);                       // nothing yet: the 30 s have not passed
  h.clock.advance(30000);
  const id = h.faults.list()[0].id;
  assert.deepEqual(h.logged('warn').map((c) => c[1]), [`[main-fault] kind=internal id=${id} line="Error: same again" repeated 997 more times`]);
  assert.ok(h.sent.length <= 3, 'sends: ' + h.sent.length);
  assert.equal(h.sent[h.sent.length - 1][1].count, 1000);
  const lines = h.lines();
  assert.deepEqual(lines.filter((l) => l.ev === 'fault').map((l) => [l.n, 'stack' in l]), [[1, true], [2, false], [3, false]]);
  assert.deepEqual(lines.filter((l) => l.ev === 'repeat').map((l) => [l.id, l.kind, l.firstLine, l.count]), [[id, 'internal', 'Error: same again', 997]]);
  h.faults.flush();
  assert.equal(h.logged('warn').length, 1, 'a flush with nothing pending writes nothing');
  h.proc.emit('uncaughtException', err);
  h.faults.flush();
  assert.match(h.logged('warn')[1][1], / repeated 1 more times$/);
});

test('main-faults: 100 faults that differ only in a number or a uuid are one signature; 300 truly different faults keep at most 200 signatures and at most 20 full entries a minute', () => {
  let h = null;
  const start = () => { h = make(); h.faults.installListeners(h.proc); h.loaded(); };
  const raise = (message) => { h.proc.emit('uncaughtException', new Error(message)); };   // every Error is built on this ONE line, so all have the same frames
  // part 1
  start();
  for (let i = 0; i < 100; i++) raise(`session ${crypto.randomUUID()} failed after ${i} ms at 0x${(0xabcdef + i).toString(16)}`);
  raise('could not open "C:\\a.txt"'); raise("could not open 'D:\\b.txt'");
  const list = h.faults.list();
  assert.deepEqual(list.map((r) => r.count).sort((a, b) => a - b), [2, 100]);
  // part 2, a new make(): words(i) turns i into letters (0 -> 'g', 1 -> 'h', 20 -> 'gg', 21 -> 'hh', ...), so no two of
  // 0 to 300 share a signature. Exactly this body: no letter from a to f, because rule S folds a run of 6 or more hex digits.
  start();
  const LETTERS = 'ghijklmnopqrstuvwxyz';
  const words = (i) => LETTERS[i % 20].repeat(Math.floor(i / 20) + 1);
  for (let i = 0; i < 300; i++) raise('failure ' + words(i));
  assert.equal(h.logged('error').length, 20);
  assert.equal(h.faults.list().length, 50);
  assert.equal(h.faults.list()[0].firstLine, 'Error: failure ' + words(299));
  h.clock.advance(60001);
  raise('failure ' + words(300));                                 // the 301st: pushes number 100 out
  assert.equal(h.logged('error').length, 21, 'a minute later a full entry is written again');
  raise('failure ' + words(150));                                 // still held
  assert.equal(h.sent[h.sent.length - 1][1].count, 2);
  raise('failure ' + words(99));                                  // dropped long ago, so it is new again
  assert.equal(h.sent[h.sent.length - 1][1].count, 1);
  // part 3, a new make(), the same raise and words: a record that is dropped leaves nothing unwritten and is not sent again
  start();
  for (let i = 0; i < 4; i++) raise('failure ' + words(0));        // 3 full entries; the 4th is only counted; the 2nd armed one send
  const id0 = h.sent[0][1].id;
  for (let i = 1; i <= 200; i++) raise('failure ' + words(i));     // the 201st signature pushes number 0 out
  assert.equal(h.logged('error').length, 20);                      // 3 for number 0, then numbers 1 to 17
  assert.deepEqual(h.logged('warn').map((c) => c[1]), [`[main-fault] kind=internal id=${id0} line="Error: failure g" repeated 1 more times`]);
  assert.deepEqual(h.lines().filter((l) => l.ev === 'repeat').map((l) => [l.id, l.firstLine, l.count]), [[id0, 'Error: failure g', 1]]);
  assert.equal(h.sent.length, 201);                                // one send for each new record
  h.clock.advance(1000);
  assert.equal(h.sent.length, 201, 'the send that was armed for the dropped record is called off');
  h.faults.flush();                                                // numbers 18 to 200 write their counts now
  assert.equal(h.logged('warn').filter((c) => c[1].includes(`id=${id0} `)).length, 1, 'and its count is not written a second time');
});

test('main-faults: Dismiss tells every window; the same error again only raises the count, and re-opens the notice once 60 seconds have passed since the Dismiss', () => {
  const h = make();
  h.faults.installListeners(h.proc);
  h.loaded();
  const err = new Error('again and again');
  h.proc.emit('uncaughtException', err);
  const id = h.faults.list()[0].id;
  h.clock.advance(5000);
  h.faults.dismiss(id);
  assert.deepEqual(h.sent[h.sent.length - 1], ['main-fault', { ...h.faults.list()[0], dismissed: true }]);
  assert.equal(h.faults.list()[0].dismissed, true);
  h.clock.advance(59999);
  h.proc.emit('uncaughtException', err);
  assert.deepEqual([h.faults.list()[0].count, h.faults.list()[0].dismissed], [2, true]);
  h.clock.advance(1);
  h.proc.emit('uncaughtException', err);
  assert.deepEqual([h.faults.list()[0].count, h.faults.list()[0].dismissed], [3, false]);
  h.clock.advance(1000);
  assert.deepEqual([h.sent[h.sent.length - 1][1].count, h.sent[h.sent.length - 1][1].dismissed], [3, false]);
  const before = h.sent.length;
  h.faults.dismiss('no-such-id');
  assert.equal(h.sent.length, before);
});

test('main-faults: a stop or pty report is one record per kind and session, whatever the message, and is listed with the full session id', () => {
  const h = make();
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const B = 'bbbbbbbb-1111-2222-3333-444444444444';
  h.faults.report('stop-stalled', null, { sessionId: A });
  h.faults.report('stop-stalled', null, { sessionId: B });
  h.faults.report('stop-failed', new Error('kill EPERM'), { sessionId: A });
  h.faults.report('stop-failed', new Error('something else'), { sessionId: A });
  h.faults.report('pty', new Error('read EIO'), { sessionId: A });
  const got = h.faults.list().map((r) => [r.kind, r.sessionId, r.firstLine, r.count]).sort();
  assert.deepEqual(got, [['pty', A, 'Error: read EIO', 1], ['stop-failed', A, 'Error: kill EPERM', 2], ['stop-stalled', A, '', 1], ['stop-stalled', B, '', 1]]);
  assert.deepEqual(h.logged('warn').map((c) => c[1]), [0, 1].map((i) => `[main-fault] kind=stop-stalled id=${h.sent[i][1].id} origin=report session=${[A, B][i]}`));
  assert.match(h.logged('error')[0][1], new RegExp(`^\\[main-fault\\] kind=stop-failed id=\\S+ origin=report session=${A}$`));
  assert.deepEqual(h.dialog.boxes, []);
  assert.deepEqual(h.app.calls, []);                             // report() never shows a box and never exits
  // these records have a cap of their own: 200, and the one created first is dropped
  const g = make();
  for (let i = 0; i <= 200; i++) g.faults.report('stop-stalled', null, { sessionId: 'sess-' + i });   // 201 sessions: sess-0 is dropped
  g.clock.advance(1000);
  g.faults.report('stop-stalled', null, { sessionId: 'sess-1' });   // still held: its count rises
  assert.deepEqual([g.sent[g.sent.length - 1][1].sessionId, g.sent[g.sent.length - 1][1].count], ['sess-1', 2]);
  g.faults.report('stop-stalled', null, { sessionId: 'sess-0' });   // dropped, so it is a new record again
  assert.deepEqual([g.sent[g.sent.length - 1][1].sessionId, g.sent[g.sent.length - 1][1].count], ['sess-0', 1]);
});

test('main-faults: a throwing logger, a throwing broadcast, a throwing dialog, a null error and an error whose stack getter throws never make the handler throw', () => {
  const hLog = make({ logThrows: true });
  for (const h of [hLog, make({ broadcastThrows: true }), make({ dialogThrows: true }), make()]) {
    h.faults.installListeners(h.proc);
    h.faults.installBreadcrumbs(h.proc, h.app);
    for (const error of [null, undefined, new Error('x'), { get stack() { throw new Error('getter'); } }, Object.create(null)]) {
      assert.doesNotThrow(() => h.proc.emit('uncaughtException', error));
      assert.doesNotThrow(() => h.proc.emit('unhandledRejection', error));
    }
    assert.doesNotThrow(() => h.faults.report());
    assert.doesNotThrow(() => h.faults.report('pty', null, null));
    assert.doesNotThrow(() => h.faults.dismiss());
    assert.doesNotThrow(() => h.faults.noteWindow(null));
    assert.doesNotThrow(() => h.faults.noteWindow({}));
    assert.doesNotThrow(() => h.faults.noteExitPath());
    assert.doesNotThrow(() => h.faults.flush());
    assert.doesNotThrow(() => h.faults.list());
    assert.doesNotThrow(() => h.faults.logFile());
    assert.doesNotThrow(() => h.faults.installBreadcrumbs(null, null));
    assert.doesNotThrow(() => h.faults.installListeners(null));
    assert.doesNotThrow(() => h.faults.noteMainLoaded());
    // the stack getter that throws
    assert.equal(h.faults.list().find((r) => r.firstLine === '(unreadable error)').stack, '(unreadable error)');
    // null and undefined
    assert.ok(h.faults.list().some((r) => r.firstLine === '' && r.stack === ''));
  }
  // the throwing logger (hLog = the make({ logThrows: true }) case): the first line reaches stderr, and the file still has the fault
  assert.ok(hLog.stderr.text.includes('[main-fault] Error: x\n'));
  assert.ok(hLog.lines().some((l) => l.ev === 'fault' && l.firstLine === 'Error: x'));
});

test('main-faults: a rejection with a non-Error reason is logged readably and listed', () => {
  const h = make(); h.faults.installListeners(h.proc); h.loaded();
  h.proc.emit('unhandledRejection', 'plain text reason', Promise.resolve());
  h.proc.emit('unhandledRejection', { code: 7, why: 'nope' }, Promise.resolve());
  assert.deepEqual(h.faults.list().map((r) => r.firstLine).sort(), ['plain text reason', "{ code: 7, why: 'nope' }"]);
  assert.deepEqual(h.logged('error').map((c) => c[2]), ['plain text reason', "{ code: 7, why: 'nope' }"]);
  assert.match(h.logged('error')[0][1], /^\[main-fault\] kind=internal id=\S+ origin=unhandledRejection$/);
  assert.deepEqual(h.lines().filter((l) => l.ev === 'fault').map((l) => l.origin), ['unhandledRejection', 'unhandledRejection']);
});

test('main-faults: a fault raised while one is being handled is only counted, and a fault file that cannot be written loses nothing in the main log', () => {
  // (1) the logger raises a fault of its own, once
  const h = make(); h.faults.installListeners(h.proc); h.loaded();
  const real = h.log.error; let again = true;
  h.log.error = (...a) => { real(...a); if (again) { again = false; h.proc.emit('uncaughtException', new Error('from the logger')); } };
  h.proc.emit('uncaughtException', new Error('outer'));
  assert.deepEqual(h.faults.list().map((r) => [r.firstLine, r.count]), [['Error: outer', 1]]);
  h.faults.flush();
  assert.deepEqual(h.lines().filter((l) => l.ev === 'nested').map((l) => l.count), [1]);
  // (2) the folder goes away after the start line
  const g = make(); g.faults.installListeners(g.proc); g.loaded();
  fs.rmSync(g.dir, { recursive: true, force: true });
  assert.doesNotThrow(() => g.proc.emit('uncaughtException', new Error('no folder')));
  assert.equal(g.logged('error').length, 1);
  assert.equal(g.faults.list().length, 1);
});

test('main-faults: a first line longer than 300 characters and an error text longer than 8192 are cut in the list, in the event and in the fault file, and every line written stays one line', () => {
  const h = make(); h.faults.installListeners(h.proc); h.loaded();
  const err = new Error('m'.repeat(5000));
  err.stack = 'Error: ' + 'm'.repeat(5000) + '\n' + '    at somewhere (file.js:1:1)\n'.repeat(700);   // about 27 000 characters
  h.proc.emit('uncaughtException', err);
  const record = h.faults.list()[0];
  assert.equal(record.firstLine, ('Error: ' + 'm'.repeat(5000)).slice(0, 300));
  assert.equal(record.stack, err.stack.slice(0, 8192));
  assert.deepEqual([h.sent[0][1].firstLine.length, h.sent[0][1].stack.length], [300, 8192]);
  const raw = () => fs.readFileSync(h.file, 'utf8').split('\n').filter(Boolean);
  assert.equal(raw().length, 2, 'the start line and ONE fault line: JSON escapes the line breaks of the stack');
  const fault = JSON.parse(raw()[1]);
  assert.deepEqual([fault.ev, fault.firstLine, fault.stack], ['fault', record.firstLine, record.stack]);
  for (let i = 0; i < 3; i++) h.proc.emit('uncaughtException', err);   // the 4th occurrence is only counted
  h.faults.flush();
  assert.deepEqual(h.logged('warn').map((c) => c[1]), [`[main-fault] kind=internal id=${record.id} line=${JSON.stringify(record.firstLine)} repeated 1 more times`]);
  assert.equal(raw().length, 5, 'the start line, three fault lines and one repeat line');
});

test('main-faults: before any window has loaded, the first fault shows exactly one box; if main has not finished loading, app.exit(1) follows', () => {
  const TITLE = 'A JavaScript error occurred in the main process';
  // (1) main.js has not finished loading
  let h = make();
  h.faults.installBreadcrumbs(h.proc, h.app);
  h.faults.installListeners(h.proc);
  const first = new Error('broke while loading');
  h.proc.emit('uncaughtException', first);
  h.proc.emit('uncaughtException', new Error('a second one'));
  assert.deepEqual(h.dialog.boxes, [[TITLE, first.stack + '\n\n' + h.file]]);
  assert.deepEqual(h.app.calls, [['exit', 1]]);                  // the original, once, and only for the first fault
  const crumbs = h.lines().filter((l) => l.ev === 'crumb' && l.name === 'app.exit');
  assert.deepEqual(crumbs.map((l) => [l.code, l.caller]), [[1, 'main-faults: start-up fault']]);
  assert.equal(h.faults.list().length, 2, 'both faults are listed for the window that loads later');
  assert.equal(h.logged('error').length, 2);
  // (2) main.js finished loading, no window yet: the box, no exit
  h = make(); h.faults.installListeners(h.proc); h.faults.noteMainLoaded();
  h.proc.emit('unhandledRejection', new Error('early rejection'));
  assert.equal(h.dialog.boxes.length, 1);
  assert.deepEqual(h.app.calls, []);
  // (3) a window has loaded: no box, no exit, also when main.js has not finished
  h = make(); h.faults.installListeners(h.proc); h.loaded();
  h.proc.emit('uncaughtException', new Error('later'));
  assert.deepEqual([h.dialog.boxes, h.app.calls], [[], []]);
  // (4) a window was made but has not finished loading: still the box
  h = make(); h.faults.installListeners(h.proc); h.faults.noteMainLoaded(); h.faults.noteWindow(h.win());
  h.proc.emit('uncaughtException', new Error('window still loading'));
  assert.equal(h.dialog.boxes.length, 1);
  // (5) no fault file: the box holds the error text alone
  h = make({ noLogFile: true, noAppPath: true }); h.faults.installListeners(h.proc); h.faults.noteMainLoaded();
  const bare = new Error('nowhere to write');
  h.proc.emit('uncaughtException', bare);
  assert.deepEqual(h.dialog.boxes, [[TITLE, bare.stack]]);
  // (6) a box that throws still lets the exit follow
  h = make({ dialogThrows: true }); h.faults.installListeners(h.proc);
  h.proc.emit('uncaughtException', new Error('box broke'));
  assert.deepEqual(h.app.calls, [['exit', 1]]);
  // (7) the box comes last: when it comes up, the full entry is already in the main log and the fault line in the file
  //     (a native box can stay open for minutes, and the process can be ended while it does)
  let seen = null;
  h = make({ onBox: () => { seen = [h.logged('error').length, h.lines().map((l) => l.ev)]; } });
  h.faults.installListeners(h.proc); h.faults.noteMainLoaded();
  h.proc.emit('uncaughtException', new Error('written before the box'));
  assert.deepEqual(seen, [1, ['start', 'fault']]);
});

test('main-faults: with dialog null (T3) no box is ever shown; the fault is logged, filed and listed, and a start that failed while loading still exits', () => {
  let h = make({ dialog: null }); h.faults.installListeners(h.proc);
  const err = new Error('silent start-up fault');
  assert.doesNotThrow(() => h.proc.emit('uncaughtException', err));
  assert.deepEqual(h.app.calls, [['exit', 1]]);
  assert.equal(h.logged('error')[0][2], err.stack);
  assert.equal(h.lines().filter((l) => l.ev === 'fault')[0].stack, err.stack);
  assert.equal(h.faults.list()[0].dismissed, false, 'it shows as a notice once a window has loaded');
  h = make({ dialog: null }); h.faults.installListeners(h.proc); h.faults.noteMainLoaded();
  h.proc.emit('uncaughtException', new Error('after loading'));
  assert.deepEqual(h.app.calls, []);
});

test('main-faults: the fault file is main-faults.log beside the main log, else in app.getPath(\'logs\'), else there is none', () => {
  let h = make();
  assert.equal(path.basename(h.faults.logFile()), 'main-faults.log');
  assert.equal(path.dirname(h.faults.logFile()), h.dir);
  h = make({ noLogFile: true });
  assert.equal(h.faults.logFile(), path.join(h.dir, 'from-app', 'logs', 'main-faults.log'));
  h = make({ noLogFile: true, noAppPath: true });
  assert.equal(h.faults.logFile(), null);
  assert.doesNotThrow(() => h.faults.report('internal', new Error('no file')));
  assert.equal(h.logged('error').length, 1);
});

test("main-faults: the fault file rotates above 256 KB, and a previous run with a start line but no exit line yields one 'did not close normally' record", () => {
  const OLD = (extra = []) => [
    { t: 10, run: 'r1', ev: 'start', version: '1', pid: 1 },
    { t: 20, run: 'r1', ev: 'fault', id: 'a', kind: 'internal', origin: 'uncaughtException', n: 1, firstLine: 'Error: old one', sessionId: null, stack: 'Error: old one\n    at x' },
    { t: 30, run: 'r1', ev: 'repeat', id: 'a', kind: 'internal', firstLine: 'Error: old one', count: 4 },
    ...extra,
  ];
  const strip = (r) => { const { id, ...rest } = r; return rest; };
  // (1) a start line and no closing line
  let h = make({ prefill: OLD() });
  assert.deepEqual(h.faults.list().map(strip), [
    { kind: 'last-run', sessionId: null, firstLine: '', count: 1, firstAt: 1000000, lastAt: 1000000, previousRun: true, dismissed: false, stack: '', runErrors: 5 },
    { kind: 'internal', sessionId: null, firstLine: 'Error: old one', count: 5, firstAt: 20, lastAt: 30, previousRun: true, dismissed: true, stack: 'Error: old one\n    at x', runErrors: 0 },
  ]);
  assert.deepEqual([h.sent, h.logged('error'), h.logged('warn')], [[], [], []]);
  assert.equal(new Set(h.faults.list().map((r) => r.id)).size, 2);
  // (2) each closing line: no 'last-run' record, the old fault is still listed as dismissed
  for (const closing of [{ ev: 'exit', code: 0 }, { ev: 'crumb', name: 'windows-session-end' }, { ev: 'crumb', name: 'app.exit', code: 0, caller: 'x' }]) {
    h = make({ prefill: OLD([{ t: 40, run: 'r1', ...closing }]) });
    assert.deepEqual(h.faults.list().map((r) => [r.kind, r.dismissed]), [['internal', true]], JSON.stringify(closing));
  }
  // (3) a crumb that is not a closing line does not close the run
  h = make({ prefill: OLD([{ t: 40, run: 'r1', ev: 'crumb', name: 'before-quit' }, { t: 41, run: 'r1', ev: 'crumb', name: 'updater-install' }]) });
  assert.equal(h.faults.list()[0].kind, 'last-run');
  // (4) only the last run counts: an older run that did not close, then one that did
  h = make({ prefill: [{ t: 1, run: 'r0', ev: 'start', version: '1', pid: 1 }, { t: 2, run: 'r1', ev: 'start', version: '1', pid: 2 }, { t: 3, run: 'r1', ev: 'exit', code: 0 }] });
  assert.deepEqual(h.faults.list(), []);
  // (5) no file (the first start of this build), an empty file, a file of rubbish: no record, no throw
  for (const prefill of [undefined, '', 'not json\n{"half":', '[1,2]\n"text"\n{"ev":"start"}\n']) assert.deepEqual(make({ prefill }).faults.list(), []);
  // (6) a long run whose start line lies outside the last 64 KB is still recognised
  const crumb = JSON.stringify({ t: 5, run: 'r9', ev: 'crumb', name: 'window-all-closed' }) + '\n';
  h = make({ prefill: JSON.stringify({ t: 1, run: 'r9', ev: 'start', version: '1', pid: 1 }) + '\n' + crumb.repeat(Math.ceil(100000 / crumb.length)) });
  assert.deepEqual(h.faults.list().map((r) => [r.kind, r.runErrors]), [['last-run', 0]]);
  // (7) rotation
  const big = JSON.stringify({ t: 1, run: 'r1', ev: 'start', version: '1', pid: 1 }) + '\n' + JSON.stringify({ t: 2, run: 'r1', ev: 'exit', code: 0 }) + '\n';
  const filler = big.repeat(Math.ceil((256 * 1024) / big.length));
  h = make({ prefill: filler, oldPrefill: 'an older old file\n' });
  assert.equal(fs.readFileSync(h.oldFile, 'utf8'), filler);
  assert.deepEqual(h.lines().map((l) => l.ev), ['start']);
  assert.deepEqual(h.faults.list(), [], 'the previous run was read before the file was moved');
  // (8) a file just under the limit is appended to
  h = make({ prefill: big });
  assert.deepEqual(h.lines().map((l) => l.ev), ['start', 'exit', 'start']);
  assert.equal(fs.existsSync(h.oldFile), false);
  // (9) Jason's answer CK-C: a second app instance that lost the single-instance lock wrote a run of its own into the same
  //     file and quit at once. Its lines are left out, so the instance that went on running is still "the previous run".
  const SECOND = [
    { t: 50, run: 'r2', ev: 'start', version: '1', pid: 2 },
    { t: 51, run: 'r2', ev: 'crumb', name: 'second-instance' },
    { t: 52, run: 'r2', ev: 'crumb', name: 'app.quit', caller: 'x' },
    { t: 53, run: 'r2', ev: 'exit', code: 0 },
  ];
  h = make({ prefill: OLD(SECOND) });                              // r1 never closed, and r2 wrote the last lines
  assert.deepEqual(h.faults.list().map((r) => [r.kind, r.runErrors, r.dismissed]), [['last-run', 5, false], ['internal', 0, true]]);
  h = make({ prefill: OLD([...SECOND, { t: 60, run: 'r1', ev: 'exit', code: 0 }]) });   // r1 closed after the second instance had gone
  assert.deepEqual(h.faults.list().map((r) => r.kind), ['internal']);
  h = make({ prefill: SECOND });                                   // nothing but the second instance: no previous run
  assert.deepEqual(h.faults.list(), []);
  // (10) a record of the previous run never shares an id with a record of this run, also when the file holds the very id
  //      this run gives the same error
  const again = new Error('the same error in two runs');
  const fresh = make(); fresh.faults.report('internal', again);
  const sameId = fresh.faults.list()[0].id;
  h = make({ prefill: [
    { t: 10, run: 'r1', ev: 'start', version: '1', pid: 1 },
    { t: 20, run: 'r1', ev: 'fault', id: sameId, kind: 'internal', origin: 'report', n: 1, firstLine: 'Error: the same error in two runs', sessionId: null, stack: again.stack },
  ] });
  h.faults.report('internal', again);
  let three = h.faults.list();                                     // the new record, the 'last-run' record, the old fault
  assert.deepEqual(three.map((r) => [r.kind, r.previousRun, r.dismissed, r.count]), [['internal', false, false, 1], ['last-run', true, false, 1], ['internal', true, true, 1]]);
  assert.equal(new Set(three.map((r) => r.id)).size, 3, 'three records, three ids');
  h.faults.dismiss(three[0].id);                                   // Dismiss of the new record
  three = h.faults.list();
  assert.deepEqual(three.map((r) => [r.previousRun, r.dismissed]), [[false, true], [true, false], [true, true]], 'the records of the previous run are as they were');
  // (11) the tail holds two runs and the OLDER one has errors: only the lines of the previous run count
  const CLOSED_R1 = OLD([{ t: 40, run: 'r1', ev: 'exit', code: 0 }]);
  h = make({ prefill: [...CLOSED_R1, { t: 50, run: 'r2', ev: 'start', version: '1', pid: 2 }] });
  assert.deepEqual(h.faults.list().map((r) => [r.kind, r.runErrors]), [['last-run', 0]]);   // r2 did not close and recorded nothing; r1's fault gives no record
  h = make({ prefill: [...CLOSED_R1, { t: 50, run: 'r2', ev: 'start', version: '1', pid: 2 }, { t: 60, run: 'r2', ev: 'exit', code: 0 }] });
  assert.deepEqual(h.faults.list(), []);
  // (12) the first fault line of an id (n = 1, the one with the stack) lies outside what was read: the record has no stack.
  //      An id that has repeat lines only gives no record, but its count is among the run's errors.
  h = make({ prefill: [
    { t: 10, run: 'r1', ev: 'fault', id: 'a', kind: 'internal', origin: 'report', n: 2, firstLine: 'Error: second of a', sessionId: null },
    { t: 20, run: 'r1', ev: 'repeat', id: 'b', kind: 'internal', firstLine: 'Error: only counted', count: 7 },
  ] });
  assert.deepEqual(h.faults.list().map(strip), [
    { kind: 'last-run', sessionId: null, firstLine: '', count: 1, firstAt: 1000000, lastAt: 1000000, previousRun: true, dismissed: false, stack: '', runErrors: 8 },
    { kind: 'internal', sessionId: null, firstLine: 'Error: second of a', count: 1, firstAt: 10, lastAt: 10, previousRun: true, dismissed: true, stack: '', runErrors: 0 },
  ]);
});

test('main-faults: the list is newest first and holds at most 50; a window that loads later still gets every record', () => {
  const h = make({ prefill: [{ t: 10, run: 'r1', ev: 'start', version: '1', pid: 1 }] });   // a 'last-run' record at 1000000
  h.clock.advance(10); h.faults.report('stop-stalled', null, { sessionId: 's-one' });
  h.clock.advance(10); h.faults.report('internal', new Error('newest'));
  assert.deepEqual(h.faults.list().map((r) => r.kind), ['internal', 'stop-stalled', 'last-run']);
  assert.notEqual(h.faults.list()[0], h.faults.list()[0], 'a fresh object each time');
  assert.doesNotThrow(() => JSON.stringify(h.faults.list()));
});

test("main-faults: breadcrumbs: wrapped app.exit writes one line with the caller and then calls the original; process 'exit', before-quit, will-quit and render-process-gone each write one line", () => {
  const h = make();
  const original = { quit: h.app.quit, exit: h.app.exit, relaunch: h.app.relaunch };
  h.faults.installBreadcrumbs(h.proc, h.app);
  h.faults.installBreadcrumbs(h.proc, h.app);                    // a second call adds nothing
  assert.equal(h.proc.count('exit'), 1);
  assert.equal(h.proc.count('uncaughtException'), 0, 'the breadcrumbs install no error listener');
  for (const name of ['quit', 'exit', 'relaunch']) assert.notEqual(h.app[name], original[name], name + ' is wrapped');
  function quitFromTheTest() { return h.app.exit(3); }
  assert.equal(quitFromTheTest(), 'exit', "the original's answer comes back");
  h.app.relaunch({ args: ['x'] }); h.app.quit();
  assert.deepEqual(h.app.calls, [['exit', 3], ['relaunch', { args: ['x'] }], ['quit']]);
  h.app.emit('before-quit', {}); h.app.emit('will-quit', {}); h.app.emit('window-all-closed');
  h.app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: -1073741819 });
  h.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'killed', exitCode: 9 });
  const win = h.win(); h.faults.noteWindow(win); win.emit('session-end', {});
  h.faults.noteExitPath('updater-install');
  const counted = new Error('counted');
  for (let i = 0; i < 5; i++) h.faults.report('internal', counted);   // 3 full entries, 2 only counted
  h.proc.emit('exit', 0);
  const lines = h.lines().slice(1);                              // without the start line
  assert.deepEqual(lines.filter((l) => l.ev === 'crumb').map((l) => l.name),
    ['app.exit', 'app.relaunch', 'app.quit', 'before-quit', 'will-quit', 'window-all-closed', 'render-process-gone', 'child-process-gone', 'windows-session-end', 'updater-install']);
  const exitCrumb = lines.find((l) => l.name === 'app.exit');
  assert.equal(exitCrumb.code, 3);
  assert.match(exitCrumb.caller, /quitFromTheTest/);
  assert.ok(exitCrumb.caller.split('\n').length <= 6);
  assert.doesNotMatch(exitCrumb.caller, /main-faults\.js/, "the wrapper's own frame is left out");
  const gone = lines.find((l) => l.name === 'render-process-gone');
  assert.deepEqual([gone.reason, gone.exitCode], ['crashed', -1073741819]);
  const child = lines.find((l) => l.name === 'child-process-gone');
  assert.deepEqual([child.type, child.reason, child.exitCode], ['GPU', 'killed', 9]);
  assert.deepEqual(lines.slice(-2).map((l) => [l.ev, l.count, l.code]), [['repeat', 2, undefined], ['exit', undefined, 0]], 'the exit line is last, after the pending counts');
  assert.deepEqual(h.logged('info').map((c) => c[1]).filter((s) => /name=(app\.exit|before-quit|updater-install)$/.test(s)),
    ['[main-fault] crumb name=app.exit', '[main-fault] crumb name=before-quit', '[main-fault] crumb name=updater-install']);
  // an app whose three methods cannot be replaced still gets its listeners
  const frozen = Object.freeze({ on: h.app.on, quit() {}, exit() {}, relaunch() {} });
  assert.doesNotThrow(() => make().faults.installBreadcrumbs(h.proc, frozen));
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const count = (text) => SRC.split(text).length - 1;
const REQUIRE_BLOCK = () => cut('main.js', 'const MAIN_FAULTS_METHODS =', '// Environment for PTY children');
/** Runs main.js's own block. opts.require replaces the block's require (a broken or missing module). */
function runRequireBlock(opts = {}) {
  const h = make({ noLogFile: true, noAppPath: true });          // the real module, with no file to write
  const globals = { log: h.log, app: h.app, dialog: h.dialog, registry: { broadcast: (...a) => { h.sent.push(a); } }, process: h.proc };
  if (opts.require) globals.require = opts.require;
  const ctx = load(REQUIRE_BLOCK(), { file: 'main.js', globals, modules: { './main-faults': {} } });
  return { h, mainFaults: peek(ctx, 'mainFaults'), names: [...peek(ctx, 'MAIN_FAULTS_METHODS')] };
}
const NAMES = ['report', 'list', 'dismiss', 'clear', 'noteWindow', 'noteMainLoaded', 'noteExitPath', 'flush', 'installBreadcrumbs', 'installListeners', 'logFile'];

test('main-faults wiring (main.js): the guarded require gives the real module with the breadcrumbs installed, and a stand-in with one log line when the module cannot be used', () => {
  // the real module
  const ok = runRequireBlock();
  assert.deepEqual(ok.names, NAMES);
  for (const name of NAMES.filter((n) => n !== 'clear')) assert.equal(typeof ok.mainFaults[name], 'function', name);
  assert.equal(ok.h.proc.count('exit'), 1, 'installBreadcrumbs(process, app) ran');
  assert.equal(ok.h.app.exit('x'), 'exit');
  assert.deepEqual(ok.h.logged('info').map((c) => c[1]), ['[main-fault] crumb name=app.exit'], 'app.exit is wrapped by the real module');
  assert.deepEqual(ok.h.logged('error'), []);
  assert.equal(ok.mainFaults.logFile(), null);
  // a module that does not load, one with no factory, one whose factory throws, one that lacks a method
  const broken = [
    [() => { throw new SyntaxError('Unexpected token in main-faults.js'); }, /Unexpected token in main-faults\.js/],
    [() => ({}), /./],
    [() => ({ createMainFaults() { throw new Error('factory failed'); } }), /factory failed/],
    [() => ({ createMainFaults: () => ({ report() {} }) }), /main-faults\.js has no list\(\)/],
  ];
  for (const [require, said] of broken) {
    const bad = runRequireBlock({ require });
    const errors = bad.h.logged('error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], '[main-fault] load failed');
    assert.match(String(errors[0][2] && errors[0][2].message), said);
    for (const name of NAMES) assert.equal(typeof bad.mainFaults[name], 'function', name);
    assert.deepEqual([...bad.mainFaults.list()], []);
    for (const name of NAMES.filter((n) => n !== 'list')) assert.equal(bad.mainFaults[name]('x', 'y'), undefined, name);
    assert.equal(bad.h.proc.count('exit'), 0, 'the stand-in installs nothing');
    assert.deepEqual(bad.h.app.calls, []);
  }
  // a logger that throws does not stop main.js loading
  assert.doesNotThrow(() => { const h = make({ logThrows: true, noLogFile: true, noAppPath: true });
    load(REQUIRE_BLOCK(), { file: 'main.js', globals: { log: h.log, app: h.app, dialog: h.dialog, registry: {}, process: h.proc, require: () => { throw new Error('gone'); } } }); });
  // the place: after the reloader line, before pty-env, once
  assert.equal(count("require('./main-faults')"), 1);
  assert.ok(SRC.indexOf("require('electron-reloader')") < SRC.indexOf("require('./main-faults')"));
  assert.ok(SRC.indexOf("require('./main-faults')") < SRC.indexOf("require('./pty-env')"));
  assert.match(REQUIRE_BLOCK(), /createMainFaults\(\{ log, app, dialog, broadcast: registry\.broadcast \}\)/);
});

test('main-faults wiring (main.js): every window is noted, the breadcrumb comes before quitAndInstall, and noteMainLoaded is the last statement', () => {
  const head = cut('main.js', 'function createWindow(opts = {}) {', "win.webContents.on('did-finish-load', () => {");
  assert.equal(head.split('mainFaults.noteWindow(win);').length - 1, 1);
  assert.ok(head.indexOf('const win = new BrowserWindow({') < head.indexOf('mainFaults.noteWindow(win);'));
  assert.equal(count('mainFaults.noteWindow('), 1);
  assert.match(SRC, /app\.on\('will-quit', \(\) => \{[^]*?\r?\n\}\);\s+(?:\/\/[^\n]*\s+)*mainFaults\.noteMainLoaded\(\);\s*$/);
  assert.equal(count('mainFaults.noteMainLoaded('), 1);
  // the updater handler, run
  for (const present of [true, false]) {
    const order = [];
    const handlers = new Map();
    load(cut('main.js', "ipcMain.handle('updater-install', () => {", '// --- Scheduled task ticker ---'), { file: 'main.js', globals: {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      autoUpdater: present ? { quitAndInstall() { order.push('quitAndInstall'); } } : null,
      mainFaults: { noteExitPath: (name) => { order.push('crumb ' + name); } } } });
    handlers.get('updater-install')();
    assert.deepEqual(order, present ? ['crumb updater-install', 'quitAndInstall'] : []);
  }
});

test('main-faults wiring (main.js): get-main-faults, dismiss-main-fault and open-main-log are a few calls each', async () => {
  const boot = ({ file, showThrows } = {}) => {
    const handlers = new Map(); const calls = [];
    const records = [{ id: 'f1' }];
    load(cut('main.js', '// --- IPC: main faults ---', '// --- IPC: MCP bridge ---'), { file: 'main.js', globals: {
      ipcMain: { handle: (name, fn) => { assert.equal(handlers.has(name), false, name); handlers.set(name, fn); } }, path,
      shell: { showItemInFolder: (p) => { calls.push(['showItemInFolder', p]); if (showThrows) throw new Error('explorer said no'); } },
      mainFaults: { list: () => records, dismiss: (id) => { calls.push(['dismiss', id]); }, logFile: () => file } } });
    return { handlers, calls, records };
  };
  const FILE = path.join(os.tmpdir(), 'sb-logs', 'main-faults.log');
  let b = boot({ file: FILE });
  // the three channels of this commit, by name; the block may come to hold more (a later commit adds the Clear handler to it)
  for (const name of ['dismiss-main-fault', 'get-main-faults', 'open-main-log']) assert.equal(b.handlers.has(name), true, name);
  assert.equal(await b.handlers.get('get-main-faults')({}), b.records);
  assert.deepEqual({ ...await b.handlers.get('dismiss-main-fault')({}, 'f1') }, { ok: true });
  assert.deepEqual({ ...await b.handlers.get('open-main-log')({}) }, { ok: true, dir: path.dirname(FILE) });
  assert.deepEqual(b.calls, [['dismiss', 'f1'], ['showItemInFolder', FILE]]);
  for (const none of [null, undefined]) {                        // no fault file, and the stand-in's answer
    b = boot({ file: none });
    assert.deepEqual({ ...await b.handlers.get('open-main-log')({}) }, { ok: false, error: 'no fault file' });
    assert.deepEqual(b.calls, []);
  }
  b = boot({ file: FILE, showThrows: true });
  assert.deepEqual({ ...await b.handlers.get('open-main-log')({}) }, { ok: false, error: 'explorer said no' });
  // away from the clipboard handler, and no channel twice
  for (const name of ['get-main-faults', 'dismiss-main-fault', 'open-main-log']) assert.equal(count(`ipcMain.handle('${name}'`), 1, name);
  assert.ok(SRC.indexOf("ipcMain.handle('diag-dir', () => DIAG_DIR);") < SRC.indexOf('// --- IPC: main faults ---'));
});

test('main-faults wiring (main.js): the app instance that loses the single-instance lock marks its run before it quits', () => {
  // Jason's answer CK-C. The branch cannot be cut and run (its else-branch is the whole start of the app), so its text is read:
  // the mark is the last statement before app.quit(), with nothing but comment lines above it in the branch.
  assert.match(SRC, /if \(!gotSingleInstanceLock\) \{\s+(?:\/\/[^\n]*\s+)*mainFaults\.noteExitPath\('second-instance'\);\s+app\.quit\(\);\s+\} else \{/);
  assert.equal(count("mainFaults.noteExitPath('second-instance')"), 1, 'one writer of the mark: a run that holds it is left out as the previous run');
  // and the module writes it as a crumb of that name, which is what rule P looks for
  const h = make();
  h.faults.noteExitPath('second-instance');
  assert.deepEqual(h.lines().filter((l) => l.ev === 'crumb').map((l) => l.name), ['second-instance']);
});
