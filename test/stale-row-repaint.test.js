const test = require('node:test');
const assert = require('node:assert/strict');

const {
  forceRepaint,
  scheduleSettledRepaint,
  SETTLE_REPAINT_MS,
  MAX_REPAINT_WAIT_MS,
} = require('../public/terminal-manager');

// The WebGL renderer can leave a row painted with stale content after a burst
// of output — a line drawn twice, or an old line surviving under a new one.
// The buffer is correct: resizing the window restores the right text, and a
// resize's only relevant effect is forcing every row to repaint. So the cure is
// to repaint every row once, shortly after output stops.
//
// These pin the two properties that make that cheap and safe: a still-streaming
// session must not pay for a repaint on every flush, and a torn-down session
// must not be refreshed at all.

function makeEntry({ rows = 40, closed = false } = {}) {
  const calls = [];
  return {
    closed,
    _repaintTimer: 0,
    terminal: {
      rows,
      refresh(start, end) { calls.push([start, end]); },
    },
    calls,
  };
}

test('a forced repaint covers every row, not just the damaged ones', () => {
  const entry = makeEntry({ rows: 40 });
  forceRepaint(entry);
  assert.deepEqual(entry.calls, [[0, 39]]);
});

test('a torn-down entry is never refreshed', () => {
  const entry = makeEntry({ closed: true });
  forceRepaint(entry);
  scheduleSettledRepaint(entry);
  assert.equal(entry.calls.length, 0);
  assert.equal(entry._repaintTimer, 0, 'and no timer is left running');
});

test('an entry whose terminal is gone is ignored rather than throwing', () => {
  const entry = { closed: false, terminal: null };
  assert.doesNotThrow(() => forceRepaint(entry));
});

test('streaming output pays for one repaint, not one per flush', async () => {
  const entry = makeEntry();

  // Ten flushes in quick succession, each closer together than the settle
  // window — as a busy session produces.
  for (let i = 0; i < 10; i++) {
    scheduleSettledRepaint(entry);
    await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS / 4));
  }
  assert.equal(entry.calls.length, 0, 'nothing repaints while output keeps arriving');

  await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS * 2));
  assert.equal(entry.calls.length, 1, 'exactly one repaint once it settles');
  assert.deepEqual(entry.calls[0], [0, 39]);
});

test('a later burst repaints again', async () => {
  const entry = makeEntry();

  scheduleSettledRepaint(entry);
  await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS * 2));
  assert.equal(entry.calls.length, 1);

  scheduleSettledRepaint(entry);
  await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS * 2));
  assert.equal(entry.calls.length, 2, 'each settled burst gets its own repaint');
});

test('output that never settles still gets repainted', async () => {
  // The bug this pins: a plain debounce is starvable. Every flush pushed the
  // timer out, so a pane that keeps redrawing inside the settle window — a
  // subagent panel, which is exactly when the stale rows appear — never
  // settled and never repainted at all. The repair was unreachable in the one
  // case it was written for.
  const entry = makeEntry();

  const started = Date.now();
  while (Date.now() - started < MAX_REPAINT_WAIT_MS * 1.5) {
    scheduleSettledRepaint(entry);
    await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS / 3));
  }

  assert.ok(entry.calls.length >= 1,
    `continuous output repainted ${entry.calls.length} times; a starved debounce would be 0`);
  assert.ok(entry.calls.length <= 3,
    `and not once per flush — got ${entry.calls.length}`);
});

test('the deadline resets, so a later burst is debounced from scratch', async () => {
  const entry = makeEntry();
  scheduleSettledRepaint(entry);
  await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS * 2));
  assert.equal(entry.calls.length, 1);
  assert.ok(!entry._repaintDeadline, 'the deadline is cleared when the repaint fires');

  scheduleSettledRepaint(entry);
  assert.ok(entry._repaintDeadline > Date.now(), 'a fresh burst gets a fresh deadline');
  await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS * 2));
  assert.equal(entry.calls.length, 2);
});

test('the scheduled repaint clears its own timer handle when it fires', async () => {
  const entry = makeEntry();
  scheduleSettledRepaint(entry);
  assert.notEqual(entry._repaintTimer, 0, 'a timer is pending while waiting');
  await new Promise(r => setTimeout(r, SETTLE_REPAINT_MS * 2));
  assert.equal(entry._repaintTimer, 0);
});
