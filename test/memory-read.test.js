'use strict';
// memory-read.js: `read-memory` reads only a file the Memory tab listed.
// Plain node, a stubbed guard and a stubbed read; the last test puts the real
// panel-path guard behind it, as main.js does with memoryPaths.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { readMemoryFile } = require('../memory-read');
const { createPanelPathGuard } = require('../save-containment');

/** A log that keeps its warn lines. */
function logger() {
  const warns = [];
  return { warns, warn: (text) => warns.push(String(text)) };
}

/** A read that records what it was asked for. */
function reader(result) {
  const asked = [];
  return {
    asked,
    readFile(filePath) {
      asked.push(filePath);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('reads a .md file the guard allows', () => {
  const read = reader('# hi');
  const out = readMemoryFile(path.join(os.tmpdir(), 'm.md'), { allows: () => true, readFile: read.readFile, log: logger() });
  assert.equal(out, '# hi');
  assert.equal(read.asked.length, 1);
});

test('the guard decides, after path.resolve', () => {
  const input = path.join(os.tmpdir(), 'a', '..', 'm.md');
  const seen = [];
  readMemoryFile(input, { allows: (p) => { seen.push(p); return true; }, readFile: () => '', log: logger() });
  assert.deepEqual(seen, [path.resolve(input)]);
});

test('refuses a .md the guard does not hold, reads nothing and warns once', () => {
  const read = reader('secret');
  const log = logger();
  const input = path.join(os.tmpdir(), 'elsewhere', 'CLAUDE.md');
  const out = readMemoryFile(input, { allows: () => false, readFile: read.readFile, log });
  assert.equal(out, '');
  assert.equal(read.asked.length, 0);
  assert.equal(log.warns.length, 1);
  assert.ok(log.warns[0].includes(path.resolve(input)), log.warns[0]);
});

test('refuses a path that does not end in .md, even when allowed', () => {
  const read = reader('text');
  const out = readMemoryFile('C:/x/notes.txt', { allows: () => true, readFile: read.readFile, log: logger() });
  assert.equal(out, '');
  assert.equal(read.asked.length, 0);
});

test('refuses a non-string without asking the guard', () => {
  for (const value of [undefined, 42, {}]) {
    let asked = 0;
    const out = readMemoryFile(value, { allows: () => { asked++; return true; }, readFile: () => 'x', log: logger() });
    assert.equal(out, '');
    assert.equal(asked, 0);
  }
});

test('a read that throws gives empty text', () => {
  const gone = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  const out = readMemoryFile(path.join(os.tmpdir(), 'gone.md'), { allows: () => true, readFile: reader(gone).readFile, log: logger() });
  assert.equal(out, '');
});

test('the real guard: a listed file is read under another letter case', { skip: process.platform !== 'win32' }, () => {
  const guard = createPanelPathGuard({ realpath: (p) => p, platform: 'win32' });
  guard.surface('C:\\Users\\a\\.claude\\CLAUDE.md');
  const out = readMemoryFile('c:\\users\\A\\.claude\\claude.md', { allows: guard.allows, readFile: () => 'ok', log: logger() });
  assert.equal(out, 'ok');
});
