// Containment for the file-browser's destructive actions.
//
// manageProjectEntry can RENAME and TRASH real files, so the only thing
// standing between a crafted relativePath from the renderer and an arbitrary
// path on disk is resolveManagedEntry. These tests pin that boundary.
//
// The interesting design choice it makes is resolving the PARENT rather than
// the leaf: renaming or trashing a symlink must act on the link itself, not
// follow it to the target. Resolving the leaf through fs.realpathSync would
// silently retarget both operations at whatever the link points at — which,
// for a link pointing outside the project, means acting outside the project
// while every containment check still passes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveManagedEntry } = require('../file-management');

function scratch() {
  // realpath: on macOS os.tmpdir() is a /var -> /private/var symlink, and
  // resolveProjectEntry realpaths the root, so an unresolved root would fail
  // its own isWithinRoot check for reasons that have nothing to do with the
  // test.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fm-')));
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(project, 'inside.txt'), 'in');
  fs.writeFileSync(path.join(project, 'sub', 'nested.txt'), 'n');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'out');
  return { dir, project };
}

test('an entry inside the project resolves', () => {
  const { project } = scratch();
  const { filePath, stat } = resolveManagedEntry(project, 'inside.txt');
  assert.equal(filePath, path.join(project, 'inside.txt'));
  assert.ok(stat.isFile());
});

test('a nested entry resolves', () => {
  const { project } = scratch();
  const { filePath } = resolveManagedEntry(project, path.join('sub', 'nested.txt'));
  assert.equal(filePath, path.join(project, 'sub', 'nested.txt'));
});

test('.. cannot walk out of the project', () => {
  const { project } = scratch();
  assert.throws(() => resolveManagedEntry(project, path.join('..', 'outside.txt')));
});

test('a deeper .. chain cannot walk out either', () => {
  const { project } = scratch();
  assert.throws(() => resolveManagedEntry(project, path.join('sub', '..', '..', 'outside.txt')));
});

test('an absolute path is refused outright', () => {
  const { dir, project } = scratch();
  assert.throws(() => resolveManagedEntry(project, path.join(dir, 'outside.txt')),
    /Invalid project-relative path/);
});

test('an empty or non-string relativePath is refused', () => {
  const { project } = scratch();
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.throws(() => resolveManagedEntry(project, bad), /Invalid project-relative path/);
  }
});

test('the project folder itself cannot be renamed or trashed', () => {
  const { project } = scratch();
  // '.' resolves to the root, which would otherwise let a rename move the
  // whole project or a trash delete it.
  assert.throws(() => resolveManagedEntry(project, '.'),
    /The project folder itself cannot be changed/);
});

test('a symlink is acted on as the LINK, not followed to its target', (t) => {
  const { dir, project } = scratch();
  const link = path.join(project, 'link.txt');
  try {
    fs.symlinkSync(path.join(dir, 'outside.txt'), link);
  } catch (err) {
    // Windows needs a privilege for this; skip rather than fail.
    t.skip(`symlink not permitted here: ${err.code}`);
    return;
  }
  const { filePath, stat } = resolveManagedEntry(project, 'link.txt');
  // The link itself, still inside the project — NOT dir/outside.txt.
  assert.equal(filePath, link);
  assert.ok(stat.isSymbolicLink(), 'lstat must see the link, not its target');
});

test('a link whose PARENT escapes the project is still refused', (t) => {
  const { dir, project } = scratch();
  const escape = path.join(project, 'escape');
  try {
    fs.symlinkSync(dir, escape, 'dir');
  } catch (err) {
    t.skip(`symlink not permitted here: ${err.code}`);
    return;
  }
  // escape/outside.txt has a parent that realpaths OUTSIDE the project. The
  // parent is the thing resolveManagedEntry checks, so this must throw.
  assert.throws(() => resolveManagedEntry(project, path.join('escape', 'outside.txt')));
});

test('a missing entry throws rather than resolving to nothing', () => {
  const { project } = scratch();
  assert.throws(() => resolveManagedEntry(project, 'does-not-exist.txt'));
});
