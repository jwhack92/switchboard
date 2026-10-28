'use strict';
// main.js contains read-memory to the Memory tab's files (memory-read.js with
// memoryPaths.allows). main.js cannot be loaded here; what is checked is the
// text that ships.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/** The text of one ipcMain.handle registration, up to the next one. */
function handler(channel) {
  const start = src.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `main.js registers ${channel}`);
  const next = src.indexOf('ipcMain.handle(', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

test('main.js requires readMemoryFile from ./memory-read', () => {
  assert.match(src, /const \{ readMemoryFile \} = require\('\.\/memory-read'\);/);
});

test('the read-memory handler goes through readMemoryFile with memoryPaths.allows', () => {
  const body = handler('read-memory');
  assert.match(body, /readMemoryFile\(/);
  assert.match(body, /memoryPaths\.allows/);
  assert.doesNotMatch(body, /fs\.existsSync\(/);
  assert.doesNotMatch(body, /CLAUDE_DIR/);
});
