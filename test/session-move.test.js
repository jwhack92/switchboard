// The ordering contract for moving a live session between windows.
//
// Order is the whole correctness story here. If the source window's release is
// processed before the destination has claimed the session, close-terminal
// detaches a session the destination is displaying. So ownership must flip
// FIRST, and only then may either renderer be told anything.
//
// session-move.js takes its collaborators via init(), so this runs without an
// Electron app.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const sessionMove = require(path.join(__dirname, '..', 'session-move'));

function harness({ sessions = { s1: { projectPath: '/proj' } }, windows = [10, 20] } = {}) {
  const calls = [];
  const owners = new Map();

  const registry = {
    windowById: (id) => (windows.includes(id)
      ? { id, isMinimized: () => false, restore() {}, focus() { calls.push(['focus', id]); } }
      : null),
    setOwner: (sessionId, windowId) => {
      const prev = owners.get(sessionId);
      owners.set(sessionId, windowId);
      calls.push(['setOwner', sessionId, windowId]);
      return prev == null || prev === windowId ? null : prev;
    },
    sendTo: (windowId, channel, payload) => {
      calls.push(['sendTo', windowId, channel, payload]);
      return true;
    },
    broadcast: (channel) => { calls.push(['broadcast', channel]); },
    windowAtPoint: () => null,
  };

  const created = [];
  sessionMove.init({
    registry,
    dragProxy: { show() {}, move() {}, setMode() {}, hide() {}, destroy() {} },
    log: { info() {}, warn() {}, error() {} },
    createWindow: (opts) => {
      const id = 99;
      created.push(opts);
      windows.push(id);
      return { id, isMinimized: () => false, restore() {}, focus() {} };
    },
    getSessionMeta: (id) => sessions[id] || null,
  });

  return { calls, owners, created };
}

test('ownership flips BEFORE either renderer is told — the tear-off race', () => {
  const { calls } = harness();

  const res = sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 20, serialized: 'BUF', sourceWindowId: 10,
  });
  assert.ok(res.ok, res.error);

  const kinds = calls.map(c => c[0]);
  const ownerAt = kinds.indexOf('setOwner');
  const firstSend = kinds.indexOf('sendTo');
  assert.ok(ownerAt >= 0, 'ownership must be assigned');
  assert.ok(firstSend > ownerAt,
    'no renderer may be messaged until the destination owns the session');
});

test('the destination is told to adopt and the source to release', () => {
  const { calls } = harness();
  sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 20, serialized: 'BUF', sourceWindowId: 10,
  });

  const adopt = calls.find(c => c[0] === 'sendTo' && c[2] === 'adopt-session');
  const release = calls.find(c => c[0] === 'sendTo' && c[2] === 'release-session');

  assert.ok(adopt, 'destination must receive adopt-session');
  assert.strictEqual(adopt[1], 20);
  assert.strictEqual(adopt[3].sessionId, 's1');
  assert.strictEqual(adopt[3].serialized, 'BUF',
    'the serialized scrollback must reach the destination, or history is lost');

  assert.ok(release, 'source must receive release-session');
  assert.strictEqual(release[1], 10);

  assert.ok(calls.indexOf(adopt) < calls.indexOf(release),
    'adopt is dispatched before release');
});

test('adopt carries the projectPath, which the destination may not know', () => {
  const { calls } = harness();
  sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 20, serialized: '', sourceWindowId: 10,
  });
  const adopt = calls.find(c => c[2] === 'adopt-session');
  assert.strictEqual(adopt[3].projectPath, '/proj');
});

test('adopt carries isPlainTerminal, captured while the session is still alive', () => {
  // If the session dies before the adopt is delivered, main can no longer say
  // what kind of session it was — activeSessions is gone by then. The
  // destination needs it to know whether relaunching means `claude` or a bare
  // shell, so it has to travel with the move rather than be looked up later.
  const { calls } = harness({ sessions: { s1: { projectPath: '/proj', isPlainTerminal: true } } });
  sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 20, serialized: '', sourceWindowId: 10,
  });
  const adopt = calls.find(c => c[2] === 'adopt-session');
  assert.strictEqual(adopt[3].isPlainTerminal, true);
});

test('a tear-off carries isPlainTerminal too, on the construction payload', () => {
  const { created } = harness({ sessions: { s1: { projectPath: '/proj', isPlainTerminal: true } } });
  sessionMove.moveSession({
    sessionId: 's1', targetWindowId: null, serialized: 'buf', sourceWindowId: 10,
  });
  assert.strictEqual(created[0].adopt.isPlainTerminal, true);
});

test('a Claude session reports isPlainTerminal false, not undefined', () => {
  // The renderer treats the flag as a boolean; a missing value must read as
  // "not a plain terminal" rather than as absent metadata.
  const { calls } = harness();
  sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 20, serialized: '', sourceWindowId: 10,
  });
  const adopt = calls.find(c => c[2] === 'adopt-session');
  assert.strictEqual(adopt[3].isPlainTerminal, false);
});

test('dropping a session on the window it already lives in is a no-op', () => {
  const { calls } = harness();
  const res = sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 10, serialized: 'BUF', sourceWindowId: 10,
  });
  assert.ok(!res.ok);
  assert.ok(res.noop);
  assert.deepStrictEqual(calls, [], 'nothing may be sent, and ownership must not churn');
});

test('a session that is not running cannot be moved', () => {
  const { calls } = harness({ sessions: {} });
  const res = sessionMove.moveSession({
    sessionId: 'ghost', targetWindowId: 20, serialized: '', sourceWindowId: 10,
  });
  assert.ok(!res.ok);
  assert.match(res.error, /not running/);
  assert.deepStrictEqual(calls, []);
});

test('a target window that no longer exists becomes a tear-off, not a lost session', () => {
  const { calls, created } = harness({ windows: [10] });
  const res = sessionMove.moveSession({
    sessionId: 's1', targetWindowId: 4242, serialized: 'BUF', sourceWindowId: 10,
  });
  assert.ok(res.ok, res.error);
  assert.ok(res.created, 'a closed target must fall back to a new window');
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].adopt.sessionId, 's1');
  assert.strictEqual(created[0].adopt.serialized, 'BUF');
  // Still ordered: own it, then release the source.
  const kinds = calls.map(c => c[0]);
  assert.ok(kinds.indexOf('setOwner') < kinds.indexOf('sendTo'));
});

test('tearing off to a new window hands the buffer over at construction', () => {
  const { created, calls } = harness();
  const res = sessionMove.moveSession({
    sessionId: 's1', targetWindowId: null, serialized: 'HISTORY', sourceWindowId: 10,
  });
  assert.ok(res.ok, res.error);
  assert.ok(res.created);
  assert.strictEqual(created[0].adopt.serialized, 'HISTORY');
  const release = calls.find(c => c[2] === 'release-session');
  assert.ok(release, 'the source still has to drop its view');
  assert.strictEqual(release[1], 10);
});

test('a cancelled drag moves nothing', () => {
  harness();
  assert.strictEqual(sessionMove.isDragging(), false);
  const res = sessionMove.dragEnd({ serialized: 'x' });
  assert.ok(!res.ok, 'ending a drag that never started must not move anything');
});
