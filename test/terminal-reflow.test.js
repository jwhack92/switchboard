const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// xterm re-wraps existing scrollback in place when the column count changes.
// Claude Code hard-wraps its own output, so any line that happens to land on the
// column limit gets flagged soft-wrapped and is then merged with the next one —
// rewriting text that was already correct in the buffer.
//
// xterm exposes no direct switch. Reflow is a side effect of the Windows pty
// hint, so this pins both the option we ship and the upstream logic it depends
// on: if xterm changes that logic, this test should fail rather than the
// protection silently disappearing.

const SRC = path.join(__dirname, '..', 'public', 'terminal-manager.js');
const XTERM = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');

/** Mirror of xterm's _isReflowEnabled. */
function isReflowEnabled(opts, hasScrollback = true) {
  const e = opts.windowsPty;
  return e && e.buildNumber
    ? hasScrollback && e.backend === 'conpty' && e.buildNumber >= 21376
    : hasScrollback && !opts.windowsMode;
}

test('the shipped windowsPty value disables reflow', () => {
  assert.equal(isReflowEnabled({ windowsPty: { backend: 'winpty', buildNumber: 26200 } }), false);
});

test('leaving windowsPty unset would enable reflow — the state that corrupted text', () => {
  assert.equal(isReflowEnabled({ windowsPty: {}, windowsMode: false }), true);
});

test('the honest conpty value would NOT have helped on a modern build', () => {
  // Worth pinning: declaring the real backend looks correct and does nothing,
  // because the buildNumber clears xterm's >= 21376 threshold.
  assert.equal(isReflowEnabled({ windowsPty: { backend: 'conpty', buildNumber: 26200 } }), true);
});

test('terminal-manager actually passes the option', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /windowsPty:\s*\{\s*backend:\s*'winpty'/,
    'the Terminal must be constructed with the reflow-disabling hint');
});

test('xterm still derives reflow from windowsPty the way we assume', () => {
  // If this fails, xterm changed the mechanism and the comment in
  // terminal-manager.js is now describing something that no longer exists.
  const lib = fs.readFileSync(XTERM, 'utf8');
  assert.ok(lib.includes('_isReflowEnabled'),
    'xterm no longer has _isReflowEnabled — re-check how reflow is controlled');
  assert.ok(lib.includes('21376'),
    'xterm no longer gates reflow on build 21376 — the shipped option may not work');
});
