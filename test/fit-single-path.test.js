const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Sizing a terminal must go through ONE function.
//
// safeFit() clamps the row count to the band that is actually visible, because
// FitAddon.proposeDimensions() overshoots for `.terminal-container` — it is
// measured from the border box, which includes 8px of padding and the 5px the
// element is pulled up by its negative top inset, while overflow:hidden clips
// at that border box. Applying the raw proposal leaves the final row straddling
// the clip edge as a half-height sliver.
//
// FitAddon.fit() *is* "apply the raw proposal". A second call site using it
// silently undoes a correct fit: file-panel.js's refitActiveTerminal() ran on
// every session switch (switchPanel -> showPanel/hidePanel), one frame after
// showSession() had fitted properly, and overwrote the good row count with the
// bad one. The reported symptom was the bottom line cut in half after switching
// sessions, repaired only by resizing the window.
//
// safeFit() itself may call fit() as its own fallback; nothing else may.

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OWNER = 'terminal-manager.js';

function rendererScripts() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.endsWith('.js') && !f.includes('codemirror'))
    .sort();
}

function linesMatching(file, re) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').split('\n');
  const hits = [];
  src.forEach((line, i) => {
    if (re.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
      hits.push(`${file}:${i + 1}  ${line.trim()}`);
    }
  });
  return hits;
}

test('only terminal-manager.js calls fitAddon.fit()', () => {
  const offenders = [];
  for (const file of rendererScripts()) {
    if (file === OWNER) continue;
    offenders.push(...linesMatching(file, /\.fit\s*\(\s*\)/));
  }
  assert.deepEqual(offenders, [],
    'these bypass safeFit() and will re-introduce the clipped last row:\n  '
    + offenders.join('\n  ') + '\n  Call safeFit(entry) instead.');
});

test('only terminal-manager.js calls terminal.resize()', () => {
  const offenders = [];
  for (const file of rendererScripts()) {
    if (file === OWNER) continue;
    offenders.push(...linesMatching(file, /\bterminal\.resize\s*\(/));
  }
  assert.deepEqual(offenders, [],
    'terminal sizing must go through safeFit():\n  ' + offenders.join('\n  '));
});

test('only terminal-manager.js calls proposeDimensions()', () => {
  // Reading the proposal outside the owner is how a caller ends up applying it.
  const offenders = [];
  for (const file of rendererScripts()) {
    if (file === OWNER) continue;
    offenders.push(...linesMatching(file, /proposeDimensions\s*\(/));
  }
  assert.deepEqual(offenders, [],
    'proposeDimensions() overshoots and must not be consumed directly:\n  '
    + offenders.join('\n  '));
});

test('safeFit is reachable as a global for the other scripts', () => {
  // file-panel.js calls safeFit(entry) across script boundaries; these are
  // classic scripts sharing one global scope, so it must stay a top-level
  // function declaration rather than becoming module-scoped.
  const src = fs.readFileSync(path.join(PUBLIC_DIR, OWNER), 'utf8');
  assert.match(src, /^function safeFit\(/m,
    'safeFit must remain a top-level function declaration');
});

test('the sanity check itself works', () => {
  // Guard against the matcher silently matching nothing — a test that can never
  // fail is worse than no test.
  const owner = linesMatching(OWNER, /\.fit\s*\(\s*\)/);
  assert.ok(owner.length >= 1,
    'expected terminal-manager.js to contain its own fallback fit() call');
});
