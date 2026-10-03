const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applySyncMarkers,
  ESC_SYNC_START,
  ESC_SYNC_END,
} = require('../public/terminal-manager');

// Claude Code wraps a whole UI frame in DECSET 2026 so the terminal draws it
// atomically. We honour that by holding incoming chunks until the nesting
// returns to zero. Get the nesting wrong and the buffer flushes mid-frame,
// which is a torn display — half of the old frame, half of the new one.
//
// The previous implementation was two `includes` checks, and these are the
// three ways that lied.

const S = ESC_SYNC_START;
const E = ESC_SYNC_END;

function newBuf() { return { syncDepth: 0, syncCarry: '' }; }

test('a plain frame opens and closes', () => {
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, S + 'hello'), 1);
  assert.equal(applySyncMarkers(buf, 'more' + E), 0);
});

test('output with no markers leaves the depth alone', () => {
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, 'just text'), 0);
  applySyncMarkers(buf, S);
  assert.equal(applySyncMarkers(buf, 'inside the frame'), 1);
});

test('two whole frames in one chunk net to zero, not to one', () => {
  // `includes` is a boolean: it counted this as a single start and a single
  // end. That happened to net correctly here, but only by luck —
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, S + 'a' + E + S + 'b' + E), 0);
});

test('two starts in one chunk count twice', () => {
  // — and here the luck runs out. One `includes` saw "a start", depth 1, and
  // the matching second end then drove it to 0 while a frame was still open.
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, S + 'outer' + S + 'inner'), 2);
  assert.equal(applySyncMarkers(buf, E), 1, 'still inside the outer frame');
  assert.equal(applySyncMarkers(buf, E), 0);
});

test('a chunk that ends one frame and opens the next stays open', () => {
  // The order matters and `includes` could not see it: END then START was
  // computed as +1 -1 = 0, flushing a frame that had only just begun.
  const buf = newBuf();
  applySyncMarkers(buf, S);
  assert.equal(applySyncMarkers(buf, 'tail' + E + S + 'head'), 1);
});

test('a marker split across two IPC chunks is still seen', () => {
  const buf = newBuf();
  const half = Math.floor(S.length / 2);
  assert.equal(applySyncMarkers(buf, 'text' + S.slice(0, half)), 0);
  assert.equal(applySyncMarkers(buf, S.slice(half) + 'frame'), 1, 'the halves rejoin');
});

test('a split end marker closes the frame', () => {
  const buf = newBuf();
  applySyncMarkers(buf, S + 'frame');
  applySyncMarkers(buf, E.slice(0, 3));
  assert.equal(applySyncMarkers(buf, E.slice(3)), 0);
});

test('the carried tail never recounts a marker it already reported', () => {
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, S), 1);
  // The whole marker is shorter than the carry window would have to be to
  // hold it, so a following chunk cannot see it a second time.
  assert.equal(applySyncMarkers(buf, 'x'), 1);
  assert.equal(applySyncMarkers(buf, 'y'), 1);
});

test('an unmatched end clamps at zero rather than going negative', () => {
  // A negative depth would never climb back to 0 and the buffer would never
  // flush again — the session would simply stop printing.
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, E + E + E), 0);
  assert.equal(applySyncMarkers(buf, S + 'recovers'), 1);
});

test('the start and end markers are not confused for one another', () => {
  // They differ only in the final character.
  assert.notEqual(S, E);
  assert.equal(S.slice(0, -1), E.slice(0, -1));
  const buf = newBuf();
  assert.equal(applySyncMarkers(buf, E), 0);
  assert.equal(applySyncMarkers(buf, S), 1);
});
