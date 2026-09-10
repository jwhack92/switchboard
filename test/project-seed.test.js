const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveProjectPath } = require('../derive-project-path');
const { readSessionFile } = require('../read-session-file');

// Adding a project writes a one-line .jsonl "seed" into ~/.claude/projects/<folder>/.
// It exists because the folder name is a lossy slug of the path, so that file is
// the only durable record of which directory the folder belongs to.
//
// It used to be written as a user message with the text "New project". That made
// it indistinguishable from a real session: it appeared in the sidebar, and
// because clicking a session resumes its id, the user's real conversation got
// appended to the seed file — permanently titled "New project".
//
// The seed must therefore satisfy both halves: resolvable path, no session.

const PROJECT_PATH = 'C:\repo\brand-new';

function writeSeed(dir, line) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(file, JSON.stringify(line) + '\n');
  return file;
}

// Mirrors the object main.js writes when a project is added.
const SEED = { type: 'project-seed', cwd: PROJECT_PATH, timestamp: '2026-01-01T00:00:00Z' };

test('the project seed still resolves the folder back to its directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-seed-'));
  try {
    writeSeed(path.join(dir, 'folder'), SEED);
    assert.equal(deriveProjectPath(path.join(dir, 'folder')), PROJECT_PATH);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the project seed does not read as a session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-seed-'));
  try {
    const file = writeSeed(path.join(dir, 'folder'), SEED);
    assert.equal(readSessionFile(file, 'folder', PROJECT_PATH), null,
      'a seed must not surface in the sidebar as a session');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the old user-message seed is what produced the phantom "New project" session', () => {
  // Guards the regression: this shape resolves the path but ALSO reads as a
  // session, which is the bug. Kept so the two halves stay distinguishable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-seed-'));
  try {
    const legacy = {
      type: 'user', cwd: PROJECT_PATH, sessionId: 'x', uuid: 'y',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'New project' },
    };
    const file = writeSeed(path.join(dir, 'folder'), legacy);
    const s = readSessionFile(file, 'folder', PROJECT_PATH);
    assert.ok(s, 'sanity: the legacy shape did read as a session');
    assert.equal(s.summary, 'New project', 'and its title came from the fabricated text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
