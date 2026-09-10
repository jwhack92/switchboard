// Ownership algebra for multi-window session tear-off.
//
// These are the invariants that make "two windows fighting over one PTY"
// unrepresentable rather than merely unlikely. They are pure map operations, so
// they run under plain `node --test` without an Electron app — only the routing
// helpers need BrowserWindow, and those are not exercised here.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const registry = require(path.join(__dirname, '..', 'window-registry'));

function reset() {
  registry._owners.clear();
}

test('setOwner returns the window a session was taken FROM, so the loser can be told to drop its view', () => {
  reset();
  assert.strictEqual(registry.setOwner('s1', 10), null, 'first claim has no previous owner');
  assert.strictEqual(registry.setOwner('s1', 20), 10, 'stealing reports the previous owner');
  assert.strictEqual(registry.ownerId('s1'), 20);
});

test('re-claiming by the same window is not a steal', () => {
  reset();
  registry.setOwner('s1', 10);
  assert.strictEqual(registry.setOwner('s1', 10), null,
    'same-window re-attach must not ask anyone to release');
});

test('a session has at most one owner', () => {
  reset();
  registry.setOwner('s1', 10);
  registry.setOwner('s1', 20);
  registry.setOwner('s1', 30);
  assert.deepStrictEqual(registry.sessionsOwnedBy(10), []);
  assert.deepStrictEqual(registry.sessionsOwnedBy(20), []);
  assert.deepStrictEqual(registry.sessionsOwnedBy(30), ['s1']);
});

test('clearOwner is owner-guarded — this is the tear-off race', () => {
  reset();
  // Destination window 20 has already claimed the session...
  registry.setOwner('s1', 10);
  registry.setOwner('s1', 20);
  // ...and now the SOURCE window 10 tears its view down and sends close-terminal.
  assert.strictEqual(registry.clearOwner('s1', 10), false,
    'a non-owner release must be ignored');
  assert.strictEqual(registry.ownerId('s1'), 20,
    'the destination must keep the session it is displaying');
  // The real owner can still release.
  assert.strictEqual(registry.clearOwner('s1', 20), true);
  assert.strictEqual(registry.ownerId('s1'), null);
});

test('clearOwner with no guard releases unconditionally (process exit path)', () => {
  reset();
  registry.setOwner('s1', 10);
  assert.strictEqual(registry.clearOwner('s1'), true);
  assert.strictEqual(registry.ownerId('s1'), null);
  assert.strictEqual(registry.clearOwner('s1'), false, 'releasing twice is a no-op');
});

test('isOwner distinguishes the owner from every other window', () => {
  reset();
  registry.setOwner('s1', 10);
  assert.ok(registry.isOwner('s1', 10));
  assert.ok(!registry.isOwner('s1', 20));
  assert.ok(!registry.isOwner('unknown', 10));
});

test('rekeyOwner follows a session whose id changes on fork', () => {
  reset();
  registry.setOwner('old', 10);
  registry.rekeyOwner('old', 'new');
  assert.strictEqual(registry.ownerId('new'), 10);
  assert.strictEqual(registry.ownerId('old'), null);
});

test('rekeyOwner on an unowned session does not invent ownership', () => {
  reset();
  registry.rekeyOwner('old', 'new');
  assert.strictEqual(registry.ownerId('new'), null,
    'a session displayed nowhere must not become owned by a fork');
});

test('closing a window releases only its own sessions', () => {
  reset();
  registry.setOwner('a', 10);
  registry.setOwner('b', 10);
  registry.setOwner('c', 20);

  const released = registry.releaseWindow(10);
  assert.deepStrictEqual(released.sort(), ['a', 'b']);
  assert.strictEqual(registry.ownerId('a'), null);
  assert.strictEqual(registry.ownerId('b'), null);
  assert.strictEqual(registry.ownerId('c'), 20,
    'the other window keeps the session it is showing — closing one window used '
    + 'to kill every PTY in the app');
});

test('a released session is unowned, not gone — any window can adopt it', () => {
  reset();
  registry.setOwner('a', 10);
  registry.releaseWindow(10);
  assert.strictEqual(registry.ownerId('a'), null);
  assert.strictEqual(registry.setOwner('a', 30), null,
    'adopting an unowned session asks nobody to release');
  assert.strictEqual(registry.ownerId('a'), 30);
});
