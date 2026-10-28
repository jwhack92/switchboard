'use strict';
// main.js contains read-memory to the Memory tab's files (memory-read.js with
// memoryPaths.allows), and the Projects view's side cards read by project id
// through read-project-file. main.js and the renderer cannot be loaded here;
// what is checked is the text that ships.

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

test('main registers read-project-side-file through guarded', () => {
  assert.ok(src.includes("ipcMain.handle('read-project-side-file', guarded((id, name) => projects.readProjectSideFile(id, name)))"));
});

test('preload exposes readProjectSideFile, and no preload key is defined twice', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(preload.includes("readProjectSideFile: (id, name) => ipcRenderer.invoke('read-project-side-file', id, name)"));
  // In an object literal the later of two equal keys wins, silently: the file
  // browser's readProjectFile (projectPath, relativePath) would replace a
  // second readProjectFile and the side cards would call the wrong channel.
  for (const key of ['readProjectSideFile', 'readProjectFile']) {
    const count = preload.split(/\r?\n/).filter((line) => new RegExp(`^\\s*${key}:`).test(line)).length;
    assert.equal(count, 1, `${key} is defined once in preload.js`);
  }
});

test('the Projects view reads side cards by id, not by path', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'projects-view.js'), 'utf8');
  const start = view.indexOf('async function loadProjectFiles(');
  assert.ok(start >= 0, 'loadProjectFiles is in projects-view.js');
  const body = view.slice(start, view.indexOf('\n}\n', start));
  assert.ok(body.includes('window.api.readProjectSideFile(project.id, name)'));
  assert.ok(!body.includes('readMemory'));
  assert.ok(!body.includes('project.root'));
});
