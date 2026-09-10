const test = require('node:test');
const assert = require('node:assert/strict');

const { safeFit, rowsThatActuallyFit } = require('../public/terminal-manager');

// FitAddon.proposeDimensions() overshoots for `.terminal-container`: the element
// has 8px of vertical padding and sits 5px above its parent via a negative top
// inset, while overflow:hidden clips at its border box. The final row then
// straddles the clip edge and renders as a half-height sliver.
//
// The first attempt at fixing that corrected AFTER the resize, inside a
// requestAnimationFrame. It removed the sliver but introduced a worse problem:
// proposeDimensions() kept returning the uncorrected number, so every fit grew
// the terminal a row and shrank it back — two PTY resizes and two full-screen
// TUI repaints for a pane whose size never changed.
//
// These tests pin both properties: no sliver, AND no work when nothing moved.

const CELL = 17;          // px per row
const PAD_TOP = 8;        // .terminal-container padding-top
const NEG_INSET = 5;      // inset: -5px ... pulls the box above its parent

function makeEntry({ parentTop = 100, parentHeight = 850, rows = 40, cols = 200 } = {}) {
  const parentBottom = parentTop + parentHeight;
  // Container border box: 5px taller than the parent, sticking out the top.
  const containerTop = parentTop - NEG_INSET;
  const containerBottom = parentBottom;
  const screenTop = containerTop + PAD_TOP;

  const resizes = [];
  const rafs = [];

  const screen = {
    getBoundingClientRect: () => ({
      top: screenTop,
      height: entry.terminal.rows * CELL,
      bottom: screenTop + entry.terminal.rows * CELL,
    }),
  };
  const clip = {
    getBoundingClientRect: () => ({ top: containerTop, bottom: containerBottom }),
  };
  const element = {
    querySelector: sel => (sel === '.xterm-screen' ? screen : null),
    closest: sel => (sel === '.terminal-container' ? clip : null),
  };

  const entry = {
    closed: false,
    terminal: {
      rows, cols, element,
      resize(c, r) {
        // Mirror xterm's own guard: an identical resize is a no-op and fires
        // nothing. (@xterm/xterm: `e!==this.cols||t!==this.rows ? ... : ...`)
        if (c === this.cols && r === this.rows) return;
        this.cols = c; this.rows = r;
        resizes.push({ cols: c, rows: r });
      },
    },
    fitAddon: {
      // Models the overshoot: measured from the container's border box, which
      // includes the padding and the 5px it is pulled up by.
      proposeDimensions: () => ({
        cols,
        rows: Math.floor((containerBottom - containerTop) / CELL),
      }),
    },
  };
  return { entry, resizes, rafs, screenTop, containerBottom };
}

// safeFit may schedule one rAF retry; run it synchronously in tests.
function withRaf(fn) {
  const original = global.requestAnimationFrame;
  const queue = [];
  global.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  try {
    fn();
    // Drain, bounded — a runaway loop is itself a failure.
    let guard = 0;
    while (queue.length) {
      if (++guard > 10) throw new Error('requestAnimationFrame loop did not settle');
      queue.shift()();
    }
    return guard;
  } finally {
    global.requestAnimationFrame = original;
  }
}

// ------------------------------------------------------------ no sliver

test('the fitted row count leaves no row straddling the clip edge', () => {
  const { entry, screenTop, containerBottom } = makeEntry();
  withRaf(() => safeFit(entry));
  const screenBottom = screenTop + entry.terminal.rows * CELL;
  assert.ok(screenBottom <= containerBottom,
    `screen bottom ${screenBottom} must not pass the clip edge ${containerBottom}`);
});

test('it clamps below what proposeDimensions asked for', () => {
  const { entry } = makeEntry();
  const proposed = entry.fitAddon.proposeDimensions().rows;
  withRaf(() => safeFit(entry));
  assert.ok(entry.terminal.rows < proposed,
    `expected fewer than the proposed ${proposed} rows, got ${entry.terminal.rows}`);
});

// ------------------------------------------------------------ idempotence

test('a second fit with unchanged geometry issues NO resize', () => {
  // The regression. Previously this fired two resizes every time, which meant
  // two SIGWINCHes and two full TUI repaints for a pane that had not moved.
  const { entry, resizes } = makeEntry();
  withRaf(() => safeFit(entry));
  const afterFirst = resizes.length;
  assert.ok(afterFirst >= 1, 'the first fit should size the pane');

  withRaf(() => safeFit(entry));
  assert.equal(resizes.length, afterFirst, 'a no-op fit must not resize anything');
});

test('ten consecutive fits settle to a single resize in total', () => {
  const { entry, resizes } = makeEntry();
  for (let i = 0; i < 10; i++) withRaf(() => safeFit(entry));
  assert.equal(resizes.length, 1,
    `expected the pane to settle after one resize, saw ${resizes.length}`);
});

test('the row count never oscillates across repeated fits', () => {
  const { entry } = makeEntry();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    withRaf(() => safeFit(entry));
    seen.push(entry.terminal.rows);
  }
  assert.equal(new Set(seen).size, 1, `row count flapped: ${seen.join(',')}`);
});

// ------------------------------------------------------------ resizing

test('growing the pane adds rows in one resize', () => {
  const small = makeEntry({ parentHeight: 500 });
  withRaf(() => safeFit(small.entry));
  const smallRows = small.entry.terminal.rows;

  const big = makeEntry({ parentHeight: 900, rows: smallRows });
  withRaf(() => safeFit(big.entry));
  assert.ok(big.entry.terminal.rows > smallRows, 'a taller pane must fit more rows');
  assert.equal(big.resizes.length, 1, 'and it should take exactly one resize');
});

// ------------------------------------------------- degenerate geometry

test('an unrendered pane falls back to the proposal rather than collapsing', () => {
  const { entry } = makeEntry({ rows: 0 });   // nothing painted yet
  const proposed = entry.fitAddon.proposeDimensions().rows;
  assert.equal(rowsThatActuallyFit(entry, proposed), proposed);
});

test('a hidden pane falls back rather than shrinking to nothing', () => {
  const { entry } = makeEntry();
  // display:none collapses every rect to zero.
  entry.terminal.element.closest = () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 0 }) });
  assert.equal(rowsThatActuallyFit(entry, 40), 40);
});

test('a detached terminal returns the proposal untouched', () => {
  const { entry } = makeEntry();
  entry.terminal.element = null;
  assert.equal(rowsThatActuallyFit(entry, 40), 40);
});

test('it never returns fewer than two rows', () => {
  const { entry } = makeEntry({ parentHeight: 4 });
  assert.ok(rowsThatActuallyFit(entry, 1) >= 2);
});

test('the rAF retry cannot become a standing loop', () => {
  // An unmeasurable pane looks again a few times — a pane that just became
  // visible can need a frame — but it must never spin every frame forever.
  const { entry } = makeEntry({ rows: 0 });
  const drained = withRaf(() => safeFit(entry));
  assert.ok(drained <= 4, `retries must be bounded, drained ${drained}`);
});

test('an unmeasurable pane is left at its current size, not resized on a guess', () => {
  const { entry, resizes } = makeEntry({ rows: 0 });
  withRaf(() => safeFit(entry));
  assert.equal(resizes.length, 0,
    'nothing measurable means nothing known — it must not resize');
});

// ------------------------------------------------- switching sessions

// Switching sessions hides one .terminal-container and shows another, then
// fits. If the incoming pane is not measurable at that instant — it was
// display:none a moment ago, or an ancestor still is — the fit has nothing to
// measure. What it must NOT do then is fall back to the raw proposeDimensions()
// number, because that is the overshooting value whose last row gets clipped.
// Reported symptom: the branch line under "bypass permissions on" cut in half
// after a session switch, staying that way until the window was resized.

/** Make an entry's pane unmeasurable, the way display:none does. */
function hide(h) {
  h.entry.terminal.element.querySelector = sel =>
    (sel === '.xterm-screen'
      ? { getBoundingClientRect: () => ({ top: 0, height: 0, bottom: 0 }) }
      : null);
  h.entry.terminal.element.closest = () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 0 }) });
}

test('a fit on an unmeasurable pane does not apply the overshooting proposal', () => {
  const h = makeEntry();
  withRaf(() => safeFit(h.entry));           // settle while visible
  const good = h.entry.terminal.rows;
  const proposed = h.entry.fitAddon.proposeDimensions().rows;
  assert.ok(good < proposed, 'sanity: the clamped size is below the proposal');

  hide(h);
  withRaf(() => safeFit(h.entry));
  assert.notEqual(h.entry.terminal.rows, proposed,
    'an unmeasurable pane must never be resized to the unclamped proposal');
});

test('switching away and back leaves the pane correctly sized', () => {
  const h = makeEntry();
  withRaf(() => safeFit(h.entry));
  const good = h.entry.terminal.rows;

  hide(h);                                    // switched away
  withRaf(() => safeFit(h.entry));

  // Switched back: measurable again, same geometry as before.
  const fresh = makeEntry({ rows: h.entry.terminal.rows });
  h.entry.terminal.element = fresh.entry.terminal.element;
  Object.defineProperty(h.entry.terminal, 'rows', {
    value: h.entry.terminal.rows, writable: true, configurable: true,
  });
  withRaf(() => safeFit(h.entry));

  assert.equal(h.entry.terminal.rows, good,
    'after a round trip the pane must be back at the size that actually fits');
});

test('an unmeasurable pane retries a bounded number of times, then stops', () => {
  const h = makeEntry();
  hide(h);
  const drained = withRaf(() => safeFit(h.entry));
  assert.ok(drained >= 1, 'it should look again rather than give up instantly');
  assert.ok(drained <= 8, `retries must be bounded, drained ${drained}`);
});

test('a pane sized for a bigger window is shrunk when it is shown again', () => {
  // Only the ACTIVE session is refitted on window resize (public/app.js:986-989),
  // so a background session keeps the row count it had when the window was
  // larger. Its screen is then taller than the container, and the bottom row is
  // clipped — which is what showed up as a half-height branch line after a
  // session switch. Showing it must bring it back down.
  const big = makeEntry({ parentHeight: 900 });
  withRaf(() => safeFit(big.entry));
  const rowsWhenLarge = big.entry.terminal.rows;

  // Window shrinks while this session sits in the background, then it is shown.
  const shown = makeEntry({ parentHeight: 600, rows: rowsWhenLarge });
  withRaf(() => safeFit(shown.entry));

  assert.ok(shown.entry.terminal.rows < rowsWhenLarge,
    `stale ${rowsWhenLarge} rows must be reduced, got ${shown.entry.terminal.rows}`);
  const screenBottom = shown.screenTop + shown.entry.terminal.rows * CELL;
  assert.ok(screenBottom <= shown.containerBottom,
    'and nothing may straddle the clip edge afterwards');
});
