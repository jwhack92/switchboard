'use strict';
// The shared cut helper, test-support/source-cut.js: every cut-based pin test
// gets its block through it, so its own behaviour is fixed here first.
//
// Plain node. The source it cuts is a small fixture written to a temp folder,
// so nothing here depends on the text of main.js. The only repository files
// read are the helper itself and session-transitions.js (a module with no
// side effect when it loads: requires, declarations and one exports line).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROOT, cut, load, realOrStandIn, peek } = require('../test-support/source-cut');

const HELPER = path.join(__dirname, '..', 'test-support', 'source-cut.js');

// The line numbers in the messages below are the positions in this list.
const LINES = [
  '// fixture for test/source-cut.test.js',          // 1
  'const before = 1;',                               // 2
  '// --- block: greet ---',                         // 3
  'function greet(name) {',                          // 4
  "  return hello + ', ' + name;",                   // 5
  '}',                                               // 6
  'function boom() {',                               // 7
  "  throw new Error('boom from the block');",       // 8
  '}',                                               // 9
  '  // --- block: end --- words after the marker',  // 10
  'const after = 2;',                                // 11
  '// --- twice ---',                                // 12
  '// --- twice ---',                                // 13
  '',
];
const START = '// --- block: greet ---';
const END = '// --- block: end ---';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-source-cut-'));
const FILE = path.join(TMP, 'fixture.js');
const FILE_CRLF = path.join(TMP, 'fixture-crlf.js');
fs.writeFileSync(FILE, LINES.join('\n'));
fs.writeFileSync(FILE_CRLF, LINES.join('\r\n'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** The one message of a failed cut or load, as an assert.throws matcher. */
const says = (file, what) => ({ name: 'Error', message: `source-cut: ${file}: ${what}` });

const STAND_IN = { standIn: true };
const NO_SUCH = './no-such-module-for-the-source-cut-test';

// --- cut ---

test('source cut: a block is found, from the start marker up to the end marker and not into it', () => {
  const block = cut(FILE, START, END);
  assert.equal(block, LINES.slice(2, 9).join('\n') + '\n  ', 'lines 3 to 9, then only the indent of the end marker\'s line');
  assert.ok(block.startsWith(START));
  assert.ok(!block.includes(END));

  // The start is the marker itself, not the start of its line.
  assert.equal(cut(FILE, 'greet(name) {', '}'.concat('\nfunction boom')), "greet(name) {\n  return hello + ', ' + name;\n");
});

test('source cut: with includeEnd the block runs through the end of the end marker\'s line, and without an end marker to the end of the file', () => {
  assert.equal(cut(FILE, START, END, { includeEnd: true }), LINES.slice(2, 10).join('\n'));
  assert.equal(cut(FILE, START, END, { includeEnd: false }), cut(FILE, START, END));

  // Windows line endings: the line break is left off whole, not half.
  assert.equal(cut(FILE_CRLF, START, END, { includeEnd: true }), LINES.slice(2, 10).join('\r\n'));

  // An end marker on the last line, which has no line break after it.
  const last = path.join(TMP, 'last-line.js');
  fs.writeFileSync(last, 'one();\ntwo(); // the end');
  assert.equal(cut(last, 'one();', '// the', { includeEnd: true }), 'one();\ntwo(); // the end');

  assert.equal(cut(FILE, 'const after = 2;'), LINES.slice(10).join('\n'));
  assert.equal(cut(FILE, 'const after = 2;', null), cut(FILE, 'const after = 2;'));
});

test('source cut: a file name is read from the repository root, an absolute path as it is', () => {
  assert.equal(ROOT, path.join(__dirname, '..'));
  const exportsLine = cut('test-support/source-cut.js', 'module.exports = {');
  assert.ok(exportsLine.startsWith('module.exports = {'));
  assert.equal(exportsLine, cut(HELPER, 'module.exports = {'));
});

test('source cut: a missing start marker fails with one message that names the file and the marker', () => {
  assert.throws(() => cut(FILE, '// --- nowhere ---', END),
    says(FILE, 'start marker not found: "// --- nowhere ---"'));
  // The file is named the way the test named it.
  assert.throws(() => cut('test-support/source-cut.js', 'no such ' + 'text in the helper', 'module.exports'),
    says('test-support/source-cut.js', 'start marker not found: "no such text in the helper"'));
  for (const notAMarker of ['', undefined, null, 7]) {
    assert.throws(() => cut(FILE, notAMarker, END),
      says(FILE, `start marker must be a non-empty string, got ${JSON.stringify(notAMarker)}`));
  }
});

test('source cut: a missing end marker fails with one message that names the file and the marker', () => {
  assert.throws(() => cut(FILE, START, '// --- nowhere ---'),
    says(FILE, 'end marker not found: "// --- nowhere ---"'));
  assert.throws(() => cut(FILE, START, '// --- nowhere ---', { includeEnd: true }),
    says(FILE, 'end marker not found: "// --- nowhere ---"'));
  assert.throws(() => cut(FILE, START, ''),
    says(FILE, 'end marker must be a non-empty string, got ""'));
});

test('source cut: a repeated marker fails, as start or as end, and the message says how often and on which lines', () => {
  assert.throws(() => cut(FILE, '// --- twice ---', END),
    says(FILE, 'start marker found 2 times (lines 12, 13), must be found once: "// --- twice ---"'));
  // An end marker is not "the first one after the start": it must be the only one in the file.
  assert.throws(() => cut(FILE, START, '// --- twice ---'),
    says(FILE, 'end marker found 2 times (lines 12, 13), must be found once: "// --- twice ---"'));
  // A second copy before the start marker counts too.
  assert.throws(() => cut(FILE, 'function boom() {', '}'),
    says(FILE, 'end marker found 2 times (lines 6, 9), must be found once: "}"'));
  // Copies that overlap are counted one by one.
  const overlap = path.join(TMP, 'overlap.js');
  fs.writeFileSync(overlap, 'x\naaa\n');
  assert.throws(() => cut(overlap, 'aa'), says(overlap, 'start marker found 2 times (lines 2, 2), must be found once: "aa"'));
  // A marker that is all over the file: the count is whole, the lines are the first five.
  const many = path.join(TMP, 'many.js');
  fs.writeFileSync(many, 'm();\n'.repeat(7));
  assert.throws(() => cut(many, 'm();'), says(many, 'start marker found 7 times (lines 1, 2, 3, 4, 5, ...), must be found once: "m();"'));
  fs.writeFileSync(many, 'm();\n'.repeat(5));
  assert.throws(() => cut(many, 'm();'), says(many, 'start marker found 5 times (lines 1, 2, 3, 4, 5), must be found once: "m();"'));
});

test('source cut: an end marker that is not after the start marker fails and says where both are', () => {
  assert.throws(() => cut(FILE, 'const after = 2;', 'const before = 1;'),
    says(FILE, 'end marker is not after the start marker (end at line 2, start at line 11): "const before = 1;"'));
  // The same text as both markers, or an end marker inside the start marker.
  assert.throws(() => cut(FILE, START, START),
    says(FILE, `end marker is not after the start marker (end at line 3, start at line 3): ${JSON.stringify(START)}`));
  assert.throws(() => cut(FILE, 'function greet(name) {', 'greet(name)'),
    says(FILE, 'end marker is not after the start marker (end at line 4, start at line 4): "greet(name)"'));
});

test('source cut: a file that cannot be read fails with its name', () => {
  assert.throws(() => cut('no-such-file-for-the-source-cut-test.js', 'a', 'b'),
    says('no-such-file-for-the-source-cut-test.js', 'the file cannot be read (ENOENT)'));
});

// --- load ---

test('source cut: the loader runs a block against the fakes of the test and hands back its context', () => {
  const ctx = load(cut(FILE, START, END), { file: FILE, globals: { hello: 'Hello' } });
  assert.equal(ctx.greet('Jason'), 'Hello, Jason');
  assert.equal(ctx.hello, 'Hello');

  // Each load is a context of its own.
  const other = load(cut(FILE, START, END), { file: FILE, globals: { hello: 'Good morning' } });
  assert.equal(other.greet('Jason'), 'Good morning, Jason');
  assert.equal(ctx.greet('Jason'), 'Hello, Jason');

  // A function or var of the block is a field of the context; a const or let
  // is not, and is read with peek.
  const consts = load('const answer = base * 2; let next = answer + 1; var plain = 7;', { file: FILE, globals: { base: 21 } });
  assert.equal(consts.answer, undefined);
  assert.equal(peek(consts, 'answer'), 42);
  assert.equal(peek(consts, 'next'), 43);
  assert.equal(consts.plain, 7);

  // A context holds what the test put there, the loader's require, and the
  // console every vm context is born with (which is not Node's: a test that
  // wants to see a block's console calls gives its own).
  const bare = load('var seen = [typeof setTimeout, typeof process, typeof Buffer, typeof require, typeof console];', { file: FILE });
  assert.deepEqual([...bare.seen], ['undefined', 'undefined', 'undefined', 'function', 'object']);
  const lines = [];
  load("console.log('from the block');", { file: FILE, globals: { console: { log: (line) => lines.push(line) } } });
  assert.deepEqual(lines, ['from the block']);

  assert.throws(() => load('var a = 1;'), says('(no file)', 'load(block, { file }) needs the name of the file the block was cut from'));
  assert.throws(() => load('var a = 1;', { globals: {} }), says('(no file)', 'load(block, { file }) needs the name of the file the block was cut from'));
});

test('source cut: the loader hands over the real module when the file exists in the repository root', () => {
  const real = require('../session-transitions');
  assert.equal(typeof real.detectSessionTransitions, 'function');

  const ctx = load("const transitions = require('./session-transitions');", {
    file: 'main.js',
    modules: { './session-transitions': STAND_IN },
  });
  assert.equal(peek(ctx, 'transitions'), real, 'the real module, the same one a plain require gives');
  assert.notEqual(peek(ctx, 'transitions'), STAND_IN);

  // The rule on its own, for a module the block reaches as a global.
  assert.equal(realOrStandIn('./session-transitions', STAND_IN), real);
  assert.equal(realOrStandIn('./session-transitions.js', STAND_IN), real);
  assert.equal(realOrStandIn('./session-transitions'), real, 'no stand-in is needed for a file that is there');
  const viaGlobal = load('var same = sessionTransitions;', {
    file: 'main.js',
    globals: { sessionTransitions: realOrStandIn('./session-transitions', STAND_IN) },
  });
  assert.equal(viaGlobal.same, real);
});

test('source cut: the loader hands over the stand-in of the test when the file does not exist', () => {
  assert.equal(fs.existsSync(path.join(ROOT, NO_SUCH + '.js')), false);
  const ctx = load(`const missing = require(${JSON.stringify(NO_SUCH)});`, { file: 'main.js', modules: { [NO_SUCH]: STAND_IN } });
  assert.equal(peek(ctx, 'missing'), STAND_IN);
  assert.equal(realOrStandIn(NO_SUCH, STAND_IN), STAND_IN);
  assert.equal(realOrStandIn(NO_SUCH, null), null, 'null is a stand-in; only undefined is none');

  // A name that is not './something' is never looked up on disk: the test's
  // stand-in is used although Node has a real module of that name.
  const fakeFs = { fake: 'fs' };
  assert.equal(peek(load("const f = require('fs');", { file: 'main.js', modules: { fs: fakeFs } }), 'f'), fakeFs);
  assert.equal(realOrStandIn('fs', fakeFs), fakeFs);
  // Also when a root file has that name: to Node 'session-transitions' is a
  // package, not ./session-transitions.js, and so it is here.
  assert.equal(realOrStandIn('session-transitions', STAND_IN), STAND_IN);
  assert.equal(realOrStandIn('../' + path.basename(ROOT) + '/session-transitions', STAND_IN), STAND_IN, 'only ./ names are files of the root');
  // A folder of the repository is not a module file.
  assert.equal(realOrStandIn('./test', STAND_IN), STAND_IN);

  assert.throws(() => realOrStandIn(NO_SUCH),
    says(NO_SUCH, 'not a file in the repository root, and the test gave no stand-in'));
});

test('source cut: the two modules the pins name, ./session-transitions and ./pty-guard, each resolve by whether the file is there', () => {
  // On the day this was written session-transitions.js exists and pty-guard.js
  // does not. The crash guard adds pty-guard.js; this test holds on both sides.
  const names = ['./session-transitions', './pty-guard'];
  const ctx = load("var got = { a: require('./session-transitions'), b: require('./pty-guard') };", {
    file: 'main.js',
    modules: { './session-transitions': STAND_IN, './pty-guard': STAND_IN },
  });
  const got = [ctx.got.a, ctx.got.b];
  names.forEach((name, i) => {
    const there = fs.existsSync(path.join(ROOT, name + '.js'));
    assert.equal(got[i] === STAND_IN, !there, name);
    if (there) assert.equal(got[i], require(path.join(ROOT, name)), name);
  });
  assert.equal(fs.existsSync(path.join(ROOT, 'session-transitions.js')), true, 'the real-module case is covered');
});

test('source cut: a module the block requires that the test did not name is refused by name, and a require of the test replaces the loader\'s', () => {
  // The file exists; it is still not handed over unasked.
  assert.equal(fs.existsSync(path.join(ROOT, 'encode-project-path.js')), true);
  assert.throws(() => load("require('./encode-project-path');", { file: 'main.js', modules: { './session-transitions': STAND_IN } }),
    says('main.js', 'the block required "./encode-project-path", which the test did not name under modules'));
  assert.throws(() => load("require('child_process');", { file: 'main.js' }),
    says('main.js', 'the block required "child_process", which the test did not name under modules'));
  // Not until the block asks.
  const lazy = load("function later() { return require('child_process'); }", { file: 'main.js' });
  assert.throws(() => lazy.later(), says('main.js', 'the block required "child_process", which the test did not name under modules'));

  const own = load("var got = require('./session-transitions');", {
    file: 'main.js',
    globals: { require: (name) => 'mine: ' + name },
    modules: { './session-transitions': STAND_IN },
  });
  assert.equal(own.got, 'mine: ./session-transitions');
});

test('source cut: a block\'s own syntax error is reported with the file\'s name', () => {
  // A cut that stops inside the function: the usual way a marker goes wrong.
  const half = cut(FILE, 'function greet(name) {', 'return hello');
  let thrown = null;
  try { load(half, { file: FILE, globals: { hello: 'Hello' } }); } catch (e) { thrown = e; }
  assert.ok(thrown, 'the load fails');
  assert.equal(thrown.name, 'Error');
  assert.ok(thrown.message.startsWith(`source-cut: ${FILE}: the cut block does not parse at line 5; a marker probably cuts through a statement (SyntaxError: `), thrown.message);
  assert.ok(thrown.cause instanceof SyntaxError);

  // A name relative to the repository root is reported as the test gave it.
  // Both blocks end in a note no source file holds: a block whose text IS in
  // the named file is counted from its line there, and "line 1" would then
  // depend on the text of main.js and app.js.
  assert.throws(() => load('function ( // source-cut.test.js: made up, in no source file', { file: 'main.js' }),
    /^Error: source-cut: main\.js: the cut block does not parse at line 1; a marker probably cuts through a statement \(SyntaxError: /);
  assert.throws(() => load('const a = 1; const a = 2; // source-cut.test.js: made up, in no source file', { file: 'public/app.js' }),
    /^Error: source-cut: public\/app\.js: the cut block does not parse at line 1; .*\(SyntaxError: Identifier 'a' has already been declared\)$/);
});

test('source cut: what a block throws while it runs is passed on untouched, with the file and its own line numbers in the trace', () => {
  const ctx = load(cut(FILE, START, END), { file: FILE, globals: { hello: 'Hello' } });
  let thrown = null;
  try { ctx.boom(); } catch (e) { thrown = e; }
  assert.equal(thrown && thrown.message, 'boom from the block');
  assert.ok(String(thrown.stack).includes(FILE + ':8:'), String(thrown.stack));

  // At load time too: a block that names something no fake provides.
  let missing = null;
  try { load(cut(FILE, 'function boom() {', END) + 'notGiven();', { file: FILE }); } catch (e) { missing = e; }
  assert.equal(missing && missing.name, 'ReferenceError');
  assert.equal(missing.message, 'notGiven is not defined');
  assert.ok(!missing.message.includes('source-cut'));
});

// --- The helper as a file ---

test('source cut: the helper holds no test assertions and sits where node --test does not look for test files', () => {
  const text = fs.readFileSync(HELPER, 'utf8');
  assert.doesNotMatch(text, /require\(\s*['"](node:)?(assert|test)(\/strict)?['"]\s*\)/);
  assert.doesNotMatch(text, /\bassert\s*\(|\bassert\.\w|\b(test|describe|it)\(\s*['"`]/);

  // Node 24 runs **/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs} by
  // default: a file in a folder named exactly "test", or a file NAMED test,
  // test-* or *.test, *-test, *_test. "test-support" is a folder, not a file.
  const parts = path.relative(ROOT, HELPER).split(path.sep);
  assert.deepEqual(parts, ['test-support', 'source-cut.js']);
  assert.ok(!parts.slice(0, -1).includes('test'));
  assert.doesNotMatch(path.basename(HELPER, '.js'), /^test$|^test-|[._-]test$/);
});

// --- Added after the verifier's pass over this file ---

const Module = require('node:module');

/**
 * Runs fn while the real module file throws `error` as it loads: Node's own
 * loader for .js files is swapped for one that throws for that one file, and
 * the copy Node keeps of an earlier load is set aside. Both are put back.
 */
function whileItThrowsOnLoad(file, error, fn) {
  const loadJs = Module._extensions['.js'];
  const kept = require.cache[file];
  let asked = 0;
  delete require.cache[file];
  Module._extensions['.js'] = function (module, filename) {
    if (filename !== file) return loadJs.apply(this, arguments);
    asked++;
    throw error;
  };
  try { fn(); } finally {
    Module._extensions['.js'] = loadJs;
    if (kept) require.cache[file] = kept; else delete require.cache[file];
  }
  return asked;
}

test('source cut: a real module that throws while it loads throws its own error here too, and the stand-in is never used in its place', () => {
  const real = require('../session-transitions');
  const file = require.resolve('../session-transitions');
  assert.equal(file, path.join(ROOT, 'session-transitions.js'));
  const broken = new Error('session-transitions.js threw while loading (made up by the test)');
  const itsOwnError = (e) => e === broken;

  const asked = whileItThrowsOnLoad(file, broken, () => {
    // With a stand-in at hand: the error, not the stand-in. A pin that ran on
    // its stand-in because the real module is broken would be a pin that
    // cannot fail.
    assert.throws(() => realOrStandIn('./session-transitions', STAND_IN), itsOwnError);
    assert.throws(() => realOrStandIn('./session-transitions.js', STAND_IN), itsOwnError);
    // Without one: still the module's error, not "not a file in the repository root".
    assert.throws(() => realOrStandIn('./session-transitions'), itsOwnError);
    // Through a block's require, when the block runs and when it asks later.
    assert.throws(() => load("const transitions = require('./session-transitions');", {
      file: FILE, modules: { './session-transitions': STAND_IN },
    }), itsOwnError);
    const lazy = load("function later() { return require('./session-transitions'); }", {
      file: FILE, modules: { './session-transitions': STAND_IN },
    });
    assert.throws(() => lazy.later(), itsOwnError);
  });
  assert.equal(asked, 5, 'each of the five asked Node for the real file');

  // Everything is back as it was: the same module object as before.
  assert.equal(require('../session-transitions'), real);
  assert.equal(realOrStandIn('./session-transitions', STAND_IN), real);

  // Whatever the error is: a helper that falls back to the stand-in for some
  // kinds of error (a missing package, a syntax error, anything but a plain
  // Error) would run every cut pin on its stand-in in a folder without
  // node_modules, and the pin would pass.
  const kinds = {
    'a MODULE_NOT_FOUND error (a missing package)': () => Object.assign(new Error("Cannot find module 'left-pad' (made up by the test)"), { code: 'MODULE_NOT_FOUND' }),
    'a SyntaxError': () => new SyntaxError('Unexpected token (made up by the test)'),
    'a TypeError': () => new TypeError('x is not a function (made up by the test)'),
  };
  for (const [kind, make] of Object.entries(kinds)) {
    const error = make();
    const askedAgain = whileItThrowsOnLoad(file, error, () => {
      assert.throws(() => realOrStandIn('./session-transitions', STAND_IN), (e) => e === error, kind);
      assert.throws(() => realOrStandIn('./session-transitions.js', STAND_IN), (e) => e === error, kind);
      assert.throws(() => realOrStandIn('./session-transitions'), (e) => e === error, kind);
      assert.throws(() => load("const transitions = require('./session-transitions');", {
        file: FILE, modules: { './session-transitions': STAND_IN },
      }), (e) => e === error, kind);
      const lazyAgain = load("function later() { return require('./session-transitions'); }", {
        file: FILE, modules: { './session-transitions': STAND_IN },
      });
      assert.throws(() => lazyAgain.later(), (e) => e === error, kind);
    });
    assert.equal(askedAgain, 5, `${kind}: each of the five asked Node for the real file`);
  }
  assert.equal(require('../session-transitions'), real);
  assert.equal(realOrStandIn('./session-transitions', STAND_IN), real);
});

test('source cut: file names and module names go by the repository root, whatever the working folder is', () => {
  const real = require('../session-transitions');
  // A folder that looks like another checkout: files of the same names with
  // other contents. (The sessions that run these tests start in one.)
  const decoy = path.join(TMP, 'another-checkout');
  fs.mkdirSync(path.join(decoy, 'test-support'), { recursive: true });
  fs.writeFileSync(path.join(decoy, 'test-support', 'source-cut.js'), "module.exports = { decoy: 'the helper of another checkout' };\n");
  fs.writeFileSync(path.join(decoy, 'session-transitions.js'), "module.exports = { decoy: 'the module of another checkout' };\n");
  fs.writeFileSync(path.join(decoy, 'main.js'), '// decoy\n');

  const fromRoot = cut(HELPER, 'module.exports = {');
  assert.ok(!fromRoot.includes('decoy'));
  const here = process.cwd();
  let stack = '';
  process.chdir(decoy);
  try {
    assert.notEqual(path.resolve('test-support/source-cut.js'), HELPER, 'the working folder really is elsewhere');
    // cut: the repository's file, not the one in the working folder.
    assert.equal(cut('test-support/source-cut.js', 'module.exports = {'), fromRoot);
    // realOrStandIn and a block's require: the repository's module.
    assert.equal(realOrStandIn('./session-transitions', STAND_IN), real);
    const ctx = load("const transitions = require('./session-transitions'); function thrower() { throw new Error('thrown by the block'); }", {
      file: 'test-support/source-cut.js', modules: { './session-transitions': STAND_IN },
    });
    assert.equal(peek(ctx, 'transitions'), real);
    // A stack trace names the repository's file by its full path.
    try { ctx.thrower(); } catch (e) { stack = String(e.stack); }
    // A module that is only in the working folder is not a file of the repository.
    assert.equal(fs.existsSync(path.join(ROOT, 'another-checkout-only.js')), false);
    fs.writeFileSync(path.join(decoy, 'another-checkout-only.js'), 'module.exports = {};\n');
    assert.equal(realOrStandIn('./another-checkout-only', STAND_IN), STAND_IN);
  } finally {
    process.chdir(here);
  }
  assert.ok(stack.includes('thrown by the block'), stack);
  assert.ok(stack.includes(HELPER + ':'), stack);
  assert.ok(!stack.includes(decoy), stack);
});
