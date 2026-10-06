'use strict';
// test-support/source-cut.js: the one shared helper of the cut-based tests.
//
// What it is for. main.js and the window scripts under public/ cannot be
// loaded in a test (Electron, node-pty, a window). A test cuts the block it is
// about out of the source text by two marker strings and runs that text in a
// vm context against fakes, so what is tested is the text that ships.
//   cut(file, start, end, options)   the text of a block
//   load(block, options)             run it; real modules where they exist
//   realOrStandIn(name, standIn)     the rule load() uses for one module
//   peek(context, expression)        read a const or let the block declared
//
// Rules for this file.
// - It must stay free of test assertions: no node:assert, no node:test. It
//   throws plain Errors that start "source-cut: <file>: "; the tests assert.
// - It lives in test-support/, outside test/, so "node --test" does not run it.
// - Every cut-based pin runs its block through load(). When a fix moves code
//   into a module, load() is the one place that changes; the pins do not.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** The repository root. File names are relative to it; an absolute path is used as it is. */
const ROOT = path.join(__dirname, '..');

/** Every failure of this file is one of these. */
const fail = (file, what, cause) => new Error(`source-cut: ${file}: ${what}`, cause ? { cause } : undefined);

function readSource(file) {
  try { return fs.readFileSync(path.resolve(ROOT, file), 'utf8'); } catch (e) {
    throw fail(file, `the file cannot be read (${e.code || e.message})`, e);
  }
}

/** The 1-based line of the character at index. */
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Where the marker starts. It must be in the file exactly once. */
function onlyPlace(src, file, which, marker) {
  if (typeof marker !== 'string' || marker === '') {
    throw fail(file, `${which} marker must be a non-empty string, got ${JSON.stringify(marker)}`);
  }
  const at = [];
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) at.push(i);
  if (at.length === 0) throw fail(file, `${which} marker not found: ${JSON.stringify(marker)}`);
  if (at.length > 1) {
    const lines = at.slice(0, 5).map((i) => lineOf(src, i)).join(', ') + (at.length > 5 ? ', ...' : '');
    throw fail(file, `${which} marker found ${at.length} times (lines ${lines}), must be found once: ${JSON.stringify(marker)}`);
  }
  return at[0];
}

/**
 * The text of `file` from the first character of the start marker (not from
 * the start of its line) up to the end marker.
 *
 *   cut(file, start, end)                         stops just before the end marker:
 *                                                 the end marker's line is NOT included
 *   cut(file, start, end, { includeEnd: true })   runs through the end of the line the
 *                                                 end marker is on (no line break)
 *   cut(file, start)                              runs to the end of the file
 *
 * Each marker must be in the whole file exactly once, and the end marker must
 * come after the start marker. Anything else throws one Error:
 *   source-cut: <file>: <start|end> marker not found: "<marker>"
 *   source-cut: <file>: <start|end> marker found N times (lines a, b), must be found once: "<marker>"
 *   source-cut: <file>: end marker is not after the start marker (end at line a, start at line b): "<marker>"
 */
function cut(file, start, end, { includeEnd = false } = {}) {
  const src = readSource(file);
  const a = onlyPlace(src, file, 'start', start);
  if (end == null) return src.slice(a);
  const b = onlyPlace(src, file, 'end', end);
  if (b < a + start.length) {
    throw fail(file, `end marker is not after the start marker (end at line ${lineOf(src, b)}, start at line ${lineOf(src, a)}): ${JSON.stringify(end)}`);
  }
  if (!includeEnd) return src.slice(a, b);
  const afterEnd = b + end.length;
  const lineBreak = src.slice(afterEnd).search(/\r?\n/);
  return lineBreak === -1 ? src.slice(a) : src.slice(a, afterEnd + lineBreak);
}

/** The path of the repository-root file a './name' stands for, or null. */
function repositoryFile(name) {
  if (typeof name !== 'string' || !name.startsWith('./')) return null; // 'fs', 'electron': never a file of ours
  for (const candidate of [name, name + '.js']) {
    const full = path.join(ROOT, candidate);
    try { if (fs.statSync(full).isFile()) return full; } catch { /* not there */ }
  }
  return null;
}

/**
 * The real module when './name' (or './name.js') is a file in the repository
 * root, else the test's stand-in. A real module that throws while loading
 * throws here too: it is never replaced by the stand-in. A name that does not
 * start with './' always gets the stand-in.
 */
function realOrStandIn(name, standIn) {
  const file = repositoryFile(name);
  if (file) return require(file);
  if (standIn === undefined) throw fail(String(name), 'not a file in the repository root, and the test gave no stand-in');
  return standIn;
}

/** How many lines of `file` come before the block, so stack traces show the file's own line numbers. */
function linesBefore(file, block) {
  try {
    const src = readSource(file);
    const at = src.indexOf(block);
    return at === -1 ? 0 : lineOf(src, at) - 1;
  } catch { return 0; }
}

/**
 * Runs a cut block in a vm context of its own and returns that context.
 *   file      (required) the file the block was cut from; named in every error and stack trace
 *   globals   the test's fakes; they become the block's globals. A new context has no
 *             timers, process or Buffer, and its own console prints nowhere: give them here.
 *   modules   { './pty-guard': standIn, ... }: what the block's require() may ask for, each
 *             resolved by realOrStandIn. Any other name throws. A `require` in globals replaces it.
 * A block that does not parse throws "source-cut: <file>: the cut block does
 * not parse ...". What the block throws while it runs is passed on untouched.
 */
function load(block, { file, globals = {}, modules = {} } = {}) {
  if (typeof file !== 'string' || file === '') throw fail('(no file)', 'load(block, { file }) needs the name of the file the block was cut from');
  let script;
  try {
    script = new vm.Script(block, { filename: path.resolve(ROOT, file), lineOffset: linesBefore(file, block) });
  } catch (e) {
    const line = /:(\d+)\s*$/.exec(String(e.stack).split('\n')[0]);
    throw fail(file, `the cut block does not parse${line ? ` at line ${line[1]}` : ''}; a marker probably cuts through a statement (${e.name}: ${e.message})`, e);
  }
  const blockRequire = (name) => {
    if (!Object.prototype.hasOwnProperty.call(modules, name)) {
      throw fail(file, `the block required ${JSON.stringify(name)}, which the test did not name under modules`);
    }
    return realOrStandIn(name, modules[name]);
  };
  const context = vm.createContext({ require: blockRequire, ...globals });
  script.runInContext(context);
  return context;
}

/** The value of an expression inside a loaded context: the way to reach a const or let of the block. */
const peek = (context, expression) => vm.runInContext(expression, context);

module.exports = { ROOT, cut, load, realOrStandIn, peek };
