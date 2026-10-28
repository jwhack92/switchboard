'use strict';
// projects.readProjectSideFile: the Projects view's side cards (CLAUDE.md, plan,
// tracker, todos) read by project id. main takes the root from its own row,
// so the window can no longer name a path. Plain node and a fake db, as
// test/projects-scheduling.test.js does: projects.js takes its database
// through init(ctx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projects = require('../projects');

const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-project-file-'));
const root = path.join(outer, 'proj');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# rules');
fs.writeFileSync(path.join(root, 'plan.md'), '# plan');
fs.writeFileSync(path.join(root, 'plan-tracker.md'), '- [ ] one');
// One level up: a wrong implementation that joins the name as given would read this.
fs.writeFileSync(path.join(outer, 'secret.md'), 'secret');

projects.init({ db: { getProject: (id) => (id === 'p1' ? { id: 'p1', root } : null) }, log: {} });

test.after(() => fs.rmSync(outer, { recursive: true, force: true }));

test("reads CLAUDE.md from the project's own root", () => {
  assert.deepEqual(projects.readProjectSideFile('p1', 'CLAUDE.md'), { ok: true, content: '# rules' });
});

test('each side-card name is allowed', () => {
  assert.deepEqual(projects.PROJECT_SIDE_FILES, ['CLAUDE.md', 'plan.md', 'plan-tracker.md', 'todos.md']);
  for (const name of projects.PROJECT_SIDE_FILES) {
    assert.equal(projects.readProjectSideFile('p1', name).ok, true, name);
  }
});

test('a missing side-card file reads as empty text', () => {
  assert.deepEqual(projects.readProjectSideFile('p1', 'todos.md'), { ok: true, content: '' });
});

test('a name outside the list is refused', () => {
  for (const name of ['notes.md', '../secret.md', 'sub/CLAUDE.md', 'CLAUDE.md\\..\\x.md', 'claude.md', 42]) {
    assert.deepEqual(projects.readProjectSideFile('p1', name), { error: `Unknown file: ${String(name)}` }, String(name));
  }
});

test('an unknown project is an error', () => {
  assert.deepEqual(projects.readProjectSideFile('nope', 'CLAUDE.md'), { error: 'Project not found' });
});
