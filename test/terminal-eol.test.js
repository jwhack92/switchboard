const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Session terminals must NOT convert bare LF to CR+LF.
//
// Claude Code draws by diff. It positions the cursor, then moves down a row
// with a bare \n and expects the column to stay where it was — that is what LF
// means on a VT terminal. It then skips cells it believes are already right
// with \e[1C. Captured from a real session on 2026-10-01:
//
//   \e[11;3H \e[K \n The one m \e[1C asurement \e[1C that separates th \e[1C m n ...
//
// With convertEol the \n also returned the cursor to column 1, so the row
// landed two cells left of where the CLI aimed it, and each skipped cell showed
// whatever an older frame had left there:
//
//   "The one mxasurementethat separates thom nteded DevToolssopen"
//
// The raw PTY bytes were correct throughout; the damage was made here.

const SRC = path.join(__dirname, '..', 'public', 'terminal-manager.js');
const TASKS = path.join(__dirname, '..', 'public', 'task-runner.js');

/** The options object passed to the first `new Terminal({...})` in a file. */
function terminalOptions(file) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.indexOf('new Terminal({');
  assert.ok(at >= 0, `${path.basename(file)} constructs a Terminal`);
  // Up to the matching close of the options object.
  let depth = 0;
  for (let i = at + 'new Terminal('.length; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced Terminal options');
}

test('session terminals are constructed with convertEol off', () => {
  const opts = terminalOptions(SRC);
  assert.match(opts, /convertEol:\s*false/,
    'a bare LF from the CLI must move down without returning to column 1');
  assert.doesNotMatch(opts, /convertEol:\s*true/);
});

test('our own plain-text writes do not depend on convertEol', () => {
  // With conversion off, a bare \n in a banner would staircase. Every message
  // we write into a session terminal must carry its own \r.
  const files = ['app.js', 'dialogs.js'].map(f => path.join(__dirname, '..', 'public', f));
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/terminal\.write\(\s*(`[^`]*`|'[^']*')/g)) {
      const literal = m[1];
      const bareLf = /(?<!\\r)\\n/.test(literal);
      assert.ok(!bareLf, `${path.basename(file)} writes a bare \\n: ${literal}`);
    }
  }
});

test('the exit banner used on tear-off carries explicit CR+LF', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const m = src.match(/const ADOPT_EXIT_BANNER = '([^']*)'/);
  assert.ok(m, 'ADOPT_EXIT_BANNER is defined');
  assert.doesNotMatch(m[1], /(?<!\\r)\\n/);
});

test('the task runner keeps convertEol, deliberately', () => {
  // Task logs are plain line output, which is what convertEol is for. If this
  // ever changes it should be a decision, not a side effect of the fix above.
  assert.match(terminalOptions(TASKS), /convertEol:\s*true/);
});
