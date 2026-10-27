'use strict';
// pty-guard.js: the one gate for every write, resize and kill of a session's
// pty. Plain node, hand-made timers, no Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createPtyGuard } = require('../pty-guard');

/** Hand-made timers: only advance() moves the clock. */
function clock() {
  let now = 0; let seq = 0; let pending = [];
  return {
    setTimer(fn, ms) {
      const timer = { id: ++seq, at: now + (Number(ms) > 0 ? Number(ms) : 0), ms, fn, unrefs: 0, unref() { timer.unrefs++; return timer; } };
      pending.push(timer);
      return timer;
    },
    clearTimer(timer) { pending = pending.filter((t) => t !== timer); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at; pending = pending.filter((t) => t !== due); due.fn();
      }
      now = end;
    },
    waiting: () => pending.slice(),
  };
}

/** One guard on a fake clock, with a recording log and the sessions onStall was called with. */
function make() {
  const clk = clock();
  const lines = []; // [level, first argument as text, second argument]
  const at = (level) => (...args) => { lines.push([level, String(args[0]), args[1]]); };
  const log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  const stalls = [];
  const guard = createPtyGuard({ log, setTimer: clk.setTimer, clearTimer: clk.clearTimer, onStall: (session) => { stalls.push(session); } });
  const level = (name) => lines.filter((l) => l[0] === name).map((l) => l[1]);
  return { guard, clk, lines, level, stalls };
}

/** A session record whose pty notes every call. No ptyGate: it has printed nothing yet. */
function silent(fields = {}) {
  const calls = [];
  return {
    exited: false,
    pty: {
      calls,
      write(data) { calls.push(['write', data]); },
      resize(cols, rows) { calls.push(['resize', cols, rows]); },
      kill() { calls.push(['kill']); },
    },
    ...fields,
  };
}
/** The same, for a terminal that has printed. */
const printed = (fields = {}) => silent({ ptyGate: { hasOutput: true }, ...fields });
const STOP = { sessionId: 's1' };

test('pty-guard: a resize for a session whose stop was requested never reaches the pty', () => {
  const { guard } = make();
  const s = printed();
  assert.equal(guard.resize(s, 100, 40), true);
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true });
  assert.equal(guard.resize(s, 110, 40), false);
  assert.deepEqual(s.pty.calls, [['resize', 100, 40], ['kill']]);
  assert.equal(s.ptyGate.killRequested, true);
});

test("pty-guard: a resize that throws 'already exited' is swallowed and the next is not attempted", () => {
  const { guard, lines, level } = make();
  const s = printed();
  let tries = 0;
  s.pty.resize = () => { tries++; throw new Error('Cannot resize a pty that has already exited'); };
  assert.equal(guard.resize(s, 100, 40), false);
  assert.equal(s.ptyGate.closed, true);
  assert.equal(guard.resize(s, 100, 40), false);
  assert.equal(guard.write(s, 'x'), false, 'a closed pty takes no typing either');
  assert.equal(tries, 1);
  assert.deepEqual(s.pty.calls, []);
  assert.deepEqual(level('debug'), ['[pty-guard] resize dropped: the pty has already exited']);
  assert.deepEqual(level('warn'), []);
  // Any other throw: not closed, tried again next time, one warn line for the session.
  const other = printed();
  const boom = new Error('boom');
  other.pty.resize = () => { tries++; throw boom; };
  assert.equal(guard.resize(other, 100, 40), false);
  assert.equal(guard.resize(other, 100, 40), false);
  assert.equal(tries, 3);
  assert.notEqual(other.ptyGate.closed, true);
  assert.deepEqual(level('warn'), ['[pty-guard] resize failed: boom']);
  assert.equal(lines.find((l) => l[0] === 'warn')[2], boom, 'the error itself goes to the log, for its stack');
});

test('pty-guard: zero, negative, NaN, infinite, non-integer, non-number and >32767 sizes never reach the pty', () => {
  const { guard, clk } = make();
  const BAD = [[0, 24], [-1, 24], [NaN, 24], [Infinity, 24], [80.5, 24], ['80', 24], [32768, 24], [null, 24], [undefined, 24],
    [80, 0], [80, -1], [80, NaN], [80, Infinity], [80, 24.5], [80, '24'], [80, 32768], [80, null], [80, undefined]];
  const s = printed();
  for (const [cols, rows] of BAD) assert.equal(guard.resize(s, cols, rows), false, `${cols} x ${rows}`);
  assert.deepEqual(s.pty.calls, []);
  assert.equal(guard.resize(s, 1, 1), true);
  assert.equal(guard.resize(s, 32767, 32767), true);
  assert.deepEqual(s.pty.calls, [['resize', 1, 1], ['resize', 32767, 32767]]);
  // A bad size is not held either.
  const quiet = silent();
  for (const [cols, rows] of BAD) assert.equal(guard.resize(quiet, cols, rows), false, `held: ${cols} x ${rows}`);
  guard.markOutput(quiet);
  clk.advance(0);
  assert.deepEqual(quiet.pty.calls, []);
});

test('pty-guard: a resize before the first output is held, and only the last size is applied after it', () => {
  const { guard, clk } = make();
  const s = silent();
  for (const [cols, rows] of [[90, 20], [100, 30], [110, 40]]) assert.equal(guard.resize(s, cols, rows), 'held');
  assert.deepEqual(s.pty.calls, []);
  guard.markOutput(s);
  assert.deepEqual(s.pty.calls, [], 'the first output alone applies nothing');
  assert.notEqual(s.ptyGate.hasOutput, true, 'and the terminal does not count as printed before the 0 ms step');
  assert.equal(guard.resize(s, 120, 50), 'held', 'a size that comes before that step is still held, and wins');
  assert.equal(clk.waiting().length, 1);
  assert.equal(clk.waiting()[0].ms, 0);
  clk.advance(0);
  assert.deepEqual(s.pty.calls, [['resize', 120, 50]]);
  assert.equal(s.ptyGate.hasOutput, true);
  assert.equal(s.ptyGate.pendingSize, null);
  guard.markOutput(s);
  guard.markOutput(s);
  clk.advance(1000);
  assert.deepEqual(s.pty.calls, [['resize', 120, 50]], 'later output applies nothing and arms no timer');
  assert.deepEqual(clk.waiting(), []);
  assert.equal(guard.resize(s, 130, 60), true, 'from then on a size goes straight to the pty');
  // No size was asked before the first output: nothing is applied.
  const none = silent();
  guard.markOutput(none);
  clk.advance(0);
  assert.deepEqual(none.pty.calls, []);
  assert.equal(none.ptyGate.hasOutput, true);
});

test('pty-guard: two stops give one kill and the second answers ok', () => {
  const { guard } = make();
  const s = printed();
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true });
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true, already: true });
  assert.deepEqual(s.pty.calls, [['kill']]);
});

test('pty-guard: a kill that throws is reported, keeps the gate closed, and every later Stop tries again', () => {
  const { guard, lines, level } = make();
  const s = printed();
  const boom = new Error('the pty is closed');
  let kills = 0;
  s.pty.kill = () => { kills++; if (kills < 3) throw boom; };
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: false, error: 'stop failed', cause: boom });
  assert.equal(guard.stopState(s), 'failed');
  assert.equal(guard.resize(s, 100, 40), false);
  assert.equal(guard.write(s, 'x'), false);
  assert.deepEqual(s.pty.calls, [], 'the gate stays closed after a kill that threw');
  assert.equal(guard.kill(s, '[stop]', STOP).ok, false);
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true });
  assert.equal(kills, 3, 'every Stop tried again');
  assert.deepEqual(level('error'), ['[stop] session=s1 kill failed: the pty is closed', '[stop] session=s1 kill failed: the pty is closed']);
  assert.equal(lines.find((l) => l[0] === 'error')[2], boom);
  assert.equal(guard.stopState(s), 'failed', 'it stays failed until the session ends');
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true, already: true });
  // With no id handed in, the line still has its tag and the message.
  const other = printed();
  other.pty.kill = () => { throw boom; };
  guard.kill(other, '[quit]');
  assert.equal(level('error')[2], '[quit] session=unknown kill failed: the pty is closed');
});

test('pty-guard: a stop that has not ended the session after 8 s is reported once and allows one more kill', () => {
  const { guard, clk, stalls, level } = make();
  const s = printed();
  guard.kill(s, '[stop]', STOP);
  assert.equal(clk.waiting().length, 1);
  assert.equal(clk.waiting()[0].ms, 8000);
  assert.equal(clk.waiting()[0].unrefs, 1, 'the stall timer must not keep the app alive');
  clk.advance(7999);
  assert.deepEqual(stalls, []);
  assert.equal(guard.stopState(s), 'stopping');
  clk.advance(1);
  assert.deepEqual(stalls, [s]);
  assert.equal(guard.stopState(s), 'stalled');
  assert.deepEqual(level('warn'), ['[stop] session=s1 has not ended 8000 ms after the kill']);
  clk.advance(60000);
  assert.equal(stalls.length, 1, 'reported once');
  assert.deepEqual(s.pty.calls, [['kill']], 'the stall kills nothing by itself');
  assert.equal(guard.resize(s, 100, 40), false, 'the gate does not reopen');
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true }, 'one more kill is allowed');
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true, already: true });
  assert.deepEqual(s.pty.calls, [['kill'], ['kill']]);
  clk.advance(8000);
  assert.equal(stalls.length, 2, 'one call for each kill that stalled');
  // A session that ends inside the 8 s is not reported, and its timer is called off.
  const quick = printed();
  guard.kill(quick, '[stop]', { sessionId: 's2' });
  clk.advance(3000);
  guard.noteExit(quick);
  quick.exited = true;
  assert.deepEqual(clk.waiting(), []);
  clk.advance(60000);
  assert.equal(stalls.includes(quick), false);
  // A throwing onStall does not leave the timer.
  const loud = createPtyGuard({ log: { debug() {}, info() {}, warn() {}, error() {} }, setTimer: clk.setTimer, clearTimer: clk.clearTimer, onStall: () => { throw new Error('report failed'); } });
  loud.kill(printed(), '[stop]', STOP);
  assert.doesNotThrow(() => clk.advance(8000));
});

test('pty-guard: force kills even when a kill was already sent', () => {
  const { guard, clk, stalls, level } = make();
  const s = printed();
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true });
  assert.deepEqual(guard.kill(s, '[quit]', { force: true, sessionId: 's1' }), { ok: true });
  assert.deepEqual(s.pty.calls, [['kill'], ['kill']]);
  const fresh = printed();
  assert.deepEqual(guard.kill(fresh, '[quit]', { force: true, sessionId: 's2' }), { ok: true });
  assert.equal(guard.resize(fresh, 100, 40), false, 'a kill at quit closes the gate like any kill');
  assert.deepEqual(fresh.pty.calls, [['kill']]);
  for (const gone of [null, undefined, printed({ exited: true })]) {
    assert.deepEqual(guard.kill(gone, '[quit]', { force: true }), { ok: false, error: 'not running' });
  }
  assert.deepEqual(guard.kill(null, '[stop]'), { ok: false, error: 'not running' }, 'the options may be left out');
  // No report at quit (Jason's answer CK-E). A kill made with force that has
  // not ended its terminal after 8 s sets the flags and writes its line like
  // any kill, and does not call onStall. That holds for `s` too: the 8 s watch
  // of its Stop was replaced by the watch of the forced kill.
  clk.advance(8000);
  assert.deepEqual(stalls, [], 'the stall of a kill made with force is not reported');
  assert.deepEqual([guard.stopState(s), guard.stopState(fresh)], ['stalled', 'stalled']);
  assert.deepEqual(level('warn'), ['[quit] session=s1 has not ended 8000 ms after the kill', '[quit] session=s2 has not ended 8000 ms after the kill']);
});

test('pty-guard: typed input for a stopping or closed session is dropped, and a throwing write does not escape', () => {
  const { guard, level } = make();
  const live = printed();
  assert.equal(guard.write(live, 'ls\r'), true);
  assert.deepEqual(live.pty.calls, [['write', 'ls\r']]);
  assert.equal(guard.write(silent(), 'x'), true, 'typing is not held before the first output: only sizes are');
  const stopping = printed();
  guard.kill(stopping, '[stop]', STOP);
  assert.equal(guard.write(stopping, 'x'), false);
  assert.deepEqual(stopping.pty.calls, [['kill']]);
  const ended = printed({ exited: true });
  assert.equal(guard.write(ended, 'x'), false);
  assert.deepEqual(ended.pty.calls, []);
  assert.equal(guard.write(null, 'x'), false);
  const broken = printed();
  let tries = 0;
  broken.pty.write = () => { tries++; throw new Error('EPIPE'); };
  assert.equal(guard.write(broken, 'x'), false);
  assert.equal(guard.write(broken, 'y'), false);
  assert.equal(tries, 2, 'a throwing write does not close the gate');
  assert.deepEqual(level('warn'), ['[pty-guard] write failed: EPIPE'], 'one line for the session');
});

test('pty-guard: socket errors after a kill or exit are debug lines; a non-benign error on a live session reaches onFault', () => {
  const { guard, level } = make();
  const sockets = () => {
    const out = []; const input = [];
    return { out, input, proc: { on(name, fn) { if (name === 'error') out.push(fn); }, _agent: { inSocket: { on(name, fn) { if (name === 'error') input.push(fn); } } } } };
  };
  const err = (code) => Object.assign(new Error('socket ' + code), { code });
  const live = printed();
  const a = sockets();
  const faults = [];
  guard.watchPtyErrors(live, a.proc, (error) => { faults.push(error); });
  assert.equal(a.out.length, 1, 'one listener on the terminal');
  assert.equal(a.input.length, 1, 'and one on its input socket');
  for (const code of ['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED']) a.out[0](err(code));
  assert.deepEqual(faults, []);
  assert.equal(level('debug').length, 4);
  for (const line of level('debug')) assert.ok(line.startsWith('[pty-guard] '), line);
  const real = err('EIO');
  a.out[0](real);
  a.input[0](real);
  assert.deepEqual(faults, [real, real]);
  guard.kill(live, '[stop]', STOP);
  a.out[0](real);
  assert.equal(faults.length, 2, 'after a Stop an error is a debug line');
  const ended = printed();
  const b = sockets();
  guard.watchPtyErrors(ended, b.proc, (error) => { faults.push(error); });
  guard.noteExit(ended);
  ended.exited = true;
  b.input[0](real);
  assert.equal(faults.length, 2, 'after the exit too');
  assert.equal(level('debug').length, 6);
  // Nothing here may throw: no `on`, an `on` that throws, no agent, a throwing onFault.
  assert.doesNotThrow(() => guard.watchPtyErrors(printed(), {}, () => {}));
  assert.doesNotThrow(() => guard.watchPtyErrors(printed(), { on() { throw new Error('no'); }, _agent: { inSocket: { on() { throw new Error('no'); } } } }, () => {}));
  const c = sockets();
  guard.watchPtyErrors(printed(), c.proc, () => { throw new Error('report failed'); });
  assert.doesNotThrow(() => c.out[0](real));
});

test('pty-guard: stopState says none, stopping, stalled or failed and keeps the last of stalled and failed until the session ends; whenStopped answers true for an end and false for the 8 s mark', async () => {
  const { guard, clk } = make();
  assert.equal(guard.stopState(null), 'none');
  assert.equal(await guard.whenStopped(null), false);
  const s = printed();
  assert.equal(guard.stopState(s), 'none');
  assert.equal(await guard.whenStopped(s), false, 'no kill is waiting');
  guard.kill(s, '[stop]', STOP);
  assert.equal(guard.stopState(s), 'stopping');
  let first = 'not yet';
  const waiting = guard.whenStopped(s).then((v) => { first = v; });
  clk.advance(7999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first, 'not yet');
  clk.advance(1);
  await waiting;
  assert.equal(first, false);
  assert.equal(guard.stopState(s), 'stalled');
  assert.equal(await guard.whenStopped(s), false, 'stalled, and no new kill is waiting');
  guard.kill(s, '[stop]', STOP);
  assert.equal(guard.stopState(s), 'stalled', 'a new kill does not take the state back');
  const second = guard.whenStopped(s);
  guard.noteExit(s);
  s.exited = true;
  assert.equal(await second, true);
  assert.equal(guard.stopState(s), 'none', 'the state goes when the session ends');
  assert.equal(await guard.whenStopped(s), true);
  // Failed, then a kill that goes through and stalls: the later of the two shows.
  const f = printed();
  let fail = true;
  f.pty.kill = () => { if (fail) throw new Error('the pty is closed'); };
  guard.kill(f, '[stop]', STOP);
  assert.equal(guard.stopState(f), 'failed');
  assert.equal(await guard.whenStopped(f), false, 'a kill that threw is not waiting for anything');
  fail = false;
  guard.kill(f, '[stop]', STOP);
  assert.equal(guard.stopState(f), 'failed');
  clk.advance(8000);
  assert.equal(guard.stopState(f), 'stalled');
  fail = true;
  guard.kill(f, '[stop]', STOP);
  assert.equal(guard.stopState(f), 'failed');
});

test('pty-guard: a held size is never applied to a session that was stopped or has ended before the 0 ms step', () => {
  const { guard, clk } = make();
  const stopped = silent();
  assert.equal(guard.resize(stopped, 100, 40), 'held');
  guard.markOutput(stopped);
  guard.kill(stopped, '[stop]', STOP);
  clk.advance(0);
  assert.deepEqual(stopped.pty.calls, [['kill']]);
  const ended = silent();
  guard.resize(ended, 100, 40);
  guard.markOutput(ended);
  guard.noteExit(ended);
  ended.exited = true;
  clk.advance(0);
  assert.deepEqual(ended.pty.calls, []);
  // Stopped before any output: a size that comes afterwards is not even held.
  const early = silent();
  guard.kill(early, '[stop]', STOP);
  assert.equal(guard.resize(early, 100, 40), false);
  guard.markOutput(early);
  clk.advance(0);
  assert.deepEqual(early.pty.calls, [['kill']]);
});

test('pty-guard: a record that already carries ptyGate keeps that object, and the guard makes one on first touch', () => {
  const { guard } = make();
  const gate = { hasOutput: true };
  const s = silent({ ptyGate: gate });
  assert.equal(guard.resize(s, 100, 40), true);
  guard.kill(s, '[stop]', STOP);
  assert.equal(s.ptyGate, gate, 'the same object');
  assert.equal(gate.killRequested, true);
  assert.equal(gate.killSent, true);
  const quiet = silent({ ptyGate: { hasOutput: false } });
  assert.equal(guard.resize(quiet, 100, 40), 'held');
  assert.deepEqual(quiet.ptyGate.pendingSize, { cols: 100, rows: 40 });
  const bare = silent();
  assert.equal(bare.ptyGate, undefined);
  assert.equal(guard.stopState(bare), 'none');
  assert.equal(bare.ptyGate, undefined, 'a read-out makes nothing');
  guard.markOutput(bare);
  assert.equal(typeof bare.ptyGate, 'object');
});

test("pty-guard: the file says a change needs an app restart, names task-manager.js's killSent, requires nothing and has no timer of its own", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pty-guard.js'), 'utf8');
  const head = src.slice(0, src.indexOf('function createPtyGuard'));
  assert.match(head, /a change here needs an app restart/);
  assert.match(head, /task-manager\.js/);
  assert.match(head, /killSent/);
  assert.deepEqual(Object.keys(require('../pty-guard')), ['createPtyGuard']);
  assert.equal(/\brequire\(/.test(src), false, 'pure: it requires nothing');
  assert.equal(/setTimeout|setImmediate|setInterval|Date\.now/.test(src), false, 'every wait goes through the handed-in setTimer; these words may not stand in a comment either');
});

test('pty-guard: kill goes through killPty, once, with the session pty; the guard does not call pty.kill itself', () => {
  const clk = clock();
  const handed = [];
  const guard = createPtyGuard({ log: { debug() {}, info() {}, warn() {}, error() {} }, setTimer: clk.setTimer, clearTimer: clk.clearTimer, onStall() {}, killPty: (pty) => { handed.push(pty); } });
  const s = printed();
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true });
  assert.equal(handed.length, 1);
  assert.equal(handed[0], s.pty);
  assert.deepEqual(s.pty.calls, [], 'pty.kill was not called by the guard');
});

test('pty-guard: no killPty given, pty.kill is called (the default)', () => {
  const { guard } = make();
  const s = printed();
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true });
  assert.deepEqual(s.pty.calls, [['kill']]);
});

test('pty-guard: a killPty that throws gives ok false, stop failed, the same cause, and the kill failed line', () => {
  const clk = clock();
  const lines = [];
  const at = (level) => (...args) => { lines.push([level, String(args[0]), args[1]]); };
  const boom = new Error('the pty is closed');
  const guard = createPtyGuard({ log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, setTimer: clk.setTimer, clearTimer: clk.clearTimer, onStall() {}, killPty: () => { throw boom; } });
  const s = printed();
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: false, error: 'stop failed', cause: boom });
  assert.equal(guard.stopState(s), 'failed');
  assert.deepEqual(lines.filter((l) => l[0] === 'error').map((l) => l[1]), ['[stop] session=s1 kill failed: the pty is closed']);
  assert.equal(lines.find((l) => l[0] === 'error')[2], boom);
});

test('pty-guard: with killPty, a forced second kill at quit calls killPty again', () => {
  const clk = clock();
  let kills = 0;
  const guard = createPtyGuard({ log: { debug() {}, info() {}, warn() {}, error() {} }, setTimer: clk.setTimer, clearTimer: clk.clearTimer, onStall() {}, killPty: () => { kills++; } });
  const s = printed();
  guard.kill(s, '[stop]', STOP);
  assert.deepEqual(guard.kill(s, '[stop]', STOP), { ok: true, already: true });
  assert.deepEqual(guard.kill(s, '[quit]', { force: true, sessionId: 's1' }), { ok: true });
  assert.equal(kills, 2);
});
