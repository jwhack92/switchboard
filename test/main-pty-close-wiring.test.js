'use strict';
// main.js hands closePty (pty-close.js) to the pty guard, so every pty-guard
// kill (quit, Stop, track delete) closes a ConPTY terminal without node-pty's
// console-list fork. main.js cannot be loaded here; what is checked is the
// text that ships.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('main.js requires ./pty-close for closePty', () => {
  assert.match(src, /const \{ closePty \} = require\('\.\/pty-close'\);/);
});

test('the createPtyGuard call passes killPty, and it is closePty', () => {
  const start = src.indexOf('createPtyGuard({');
  assert.ok(start >= 0);
  const call = src.slice(start, src.indexOf('});', start));
  const line = call.split('\n').find((l) => /^\s*killPty:/.test(l));
  assert.ok(line, 'a killPty: line in the createPtyGuard call');
  assert.match(line, /closePty/);
});
