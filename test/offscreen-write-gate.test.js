const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sessionIsOnScreen,
  trimHeldBuffer,
  HIDDEN_BUFFER_MAX_CHARS,
  ESC_SYNC_START,
  ESC_SYNC_END,
} = require('../public/terminal-manager');

// Every open session used to pay a full xterm parse and a renderer draw for
// every chunk of PTY output, whether or not it was on screen, with no bound on
// how many sessions stay open. Output for a hidden pane is now held in the
// batch buffer it was already accumulating in and written when the pane is
// shown.
//
// Two properties make that safe. Withholding must track what is actually
// visible — which is not simply the active session, because grid view shows
// many panes at once — and a session held off screen for a long time must not
// grow without bound.

// --- what counts as on screen ---------------------------------------------

test('the active session is on screen', () => {
  const view = { activeSessionId: 'a', gridViewActive: false, gridCards: null };
  assert.equal(sessionIsOnScreen('a', view), true);
});

test('a session that is not the active one is off screen', () => {
  const view = { activeSessionId: 'a', gridViewActive: false, gridCards: null };
  assert.equal(sessionIsOnScreen('b', view), false);
});

test('in grid view every card is on screen, active or not', () => {
  // The bug this pins: gating on activeSessionId alone would withhold output
  // from every grid pane except the focused one, so switching focus inside the
  // grid would reveal panes that had silently stopped updating.
  const view = {
    activeSessionId: 'a',
    gridViewActive: true,
    gridCards: new Map([['a', {}], ['b', {}], ['c', {}]]),
  };
  assert.equal(sessionIsOnScreen('a', view), true);
  assert.equal(sessionIsOnScreen('b', view), true);
  assert.equal(sessionIsOnScreen('c', view), true);
});

test('in grid view a session with no card is off screen', () => {
  const view = {
    activeSessionId: 'a',
    gridViewActive: true,
    gridCards: new Map([['a', {}]]),
  };
  assert.equal(sessionIsOnScreen('z', view), false);
});

test('grid view with no cards yet withholds nothing it cannot account for', () => {
  const view = { activeSessionId: 'a', gridViewActive: true, gridCards: null };
  assert.equal(sessionIsOnScreen('a', view), false);
});

test('unknown view state never withholds output', () => {
  // Fail open: losing terminal content is far worse than a wasted repaint, so
  // anything we cannot resolve is treated as visible.
  assert.equal(sessionIsOnScreen('a', null), true);
  assert.equal(sessionIsOnScreen('a', undefined), true);
});

// --- bounding a held buffer -----------------------------------------------

test('a buffer under the cap is left exactly as it was', () => {
  const buf = { chunks: ['one', 'two', 'three'] };
  const total = trimHeldBuffer(buf, 1000);
  assert.deepEqual(buf.chunks, ['one', 'two', 'three']);
  assert.equal(total, 11);
  assert.equal(buf.trimmed, undefined);
});

test('an over-cap buffer drops whole chunks oldest first', () => {
  const buf = { chunks: ['aaaa', 'bbbb', 'cccc', 'dddd'] };
  trimHeldBuffer(buf, 8);
  assert.deepEqual(buf.chunks, ['cccc', 'dddd']);
  assert.equal(buf.trimmed, true);
});

test('trimming always keeps the newest chunk, even when it alone exceeds the cap', () => {
  // A single synchronized redraw from Claude Code can be enormous. Dropping it
  // would flush an empty buffer and lose the frame entirely, so the last chunk
  // always survives.
  const buf = { chunks: ['x'.repeat(50)] };
  const total = trimHeldBuffer(buf, 10);
  assert.equal(buf.chunks.length, 1);
  assert.equal(total, 50);
});

test('the default cap is applied when none is given', () => {
  const buf = { chunks: ['a', 'b'] };
  assert.equal(trimHeldBuffer(buf), 2);
  assert.equal(typeof HIDDEN_BUFFER_MAX_CHARS, 'number');
  assert.ok(HIDDEN_BUFFER_MAX_CHARS > 0);
});

// --- synchronized frames survive trimming ---------------------------------
//
// Claude Code wraps a whole-UI redraw in DECSET 2026, and app.js counts one
// level of syncDepth per ARRIVING chunk that carries a marker. Trimming happens
// after that counting, so a naive front-drop can discard the chunk holding
// ESC[?2026h and strand the counter above zero — leaving the session waiting
// forever for a frame-end that already went past, on exactly the busy sessions
// that trim in the first place.

test('trimming drops forward to a chunk that opens a frame', () => {
  // 'xx' is already under the cap once 'aaaa' goes, so dropping it costs more
  // than the cap demanded — deliberately, to land on a frame boundary.
  const buf = {
    chunks: ['aaaa', 'xx', ESC_SYNC_START + 'f', 'ccc'],
    syncDepth: 1,
  };
  trimHeldBuffer(buf, 14);
  assert.equal(buf.chunks[0], ESC_SYNC_START + 'f');
  assert.equal(buf.trimmed, true);
});

test('the cap wins when it has to: no frame start survives to land on', () => {
  // Getting under the cap is forward-only, so the frame-start chunk can itself
  // be dropped. There is nothing to recover then, and that is correct — the
  // partial-escape artifact this leaves is self-healing on the next redraw,
  // whereas exceeding the cap is not.
  const buf = { chunks: ['old-a', 'old-b', ESC_SYNC_START + 'frame', 'body'], syncDepth: 1 };
  trimHeldBuffer(buf, 12);
  assert.deepEqual(buf.chunks, ['body']);
  assert.equal(buf.syncDepth, 0);
});

test('a stranded syncDepth is restated, not left elevated', () => {
  // The bug: the chunk carrying the frame-start is dropped, so the counter
  // keeps claiming we are mid-frame and output is held indefinitely.
  const buf = {
    chunks: [ESC_SYNC_START + 'opener', 'x'.repeat(40), 'tail'],
    syncDepth: 1,
  };
  trimHeldBuffer(buf, 10);
  assert.ok(!buf.chunks[0].includes(ESC_SYNC_START));
  assert.equal(buf.syncDepth, 0);
});

test('syncDepth is recounted from the chunks that actually survived', () => {
  const buf = {
    chunks: ['drop-me-please', ESC_SYNC_START + 'open', 'mid'],
    syncDepth: 99,
  };
  trimHeldBuffer(buf, 16);
  // One surviving chunk opens a frame and nothing closes it, so exactly one.
  assert.equal(buf.syncDepth, 1);
});

test('a closed frame leaves the counter back at zero', () => {
  const buf = {
    chunks: ['drop-this-one', ESC_SYNC_START + 'open', 'end' + ESC_SYNC_END],
    syncDepth: 7,
  };
  trimHeldBuffer(buf, 18);
  assert.equal(buf.syncDepth, 0);
});

test('an under-cap buffer keeps the syncDepth app.js is maintaining', () => {
  // Only trimming invalidates the counter. Left alone, it belongs to app.js and
  // must not be clobbered mid-frame.
  const buf = { chunks: [ESC_SYNC_START + 'open'], syncDepth: 1 };
  trimHeldBuffer(buf, 10_000);
  assert.equal(buf.syncDepth, 1);
});
