const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFrontmatter } = require('../schedule-runner');

const fm = (lines) => '---\n' + lines.join('\n') + '\n---\nDo the thing.\n';

// A regressed parser writes into shared built-ins. Snapshot them once so a
// failing test can put them back and later tests in this process are not
// judged against a polluted realm. (node --test also runs each file in its
// own process, so nothing leaks to other files either way.)
const GUARDED = [
  Object.prototype, Function.prototype,
  Object.prototype.hasOwnProperty, Object.prototype.toString, Object.prototype.valueOf,
  Object.prototype.__defineGetter__, Object.prototype.__lookupGetter__,
];
const pristineOwn = GUARDED.map(o => new Set(Object.getOwnPropertyNames(o)));
const pristineStatics = { keys: Object.keys, entries: Object.entries, assign: Object.assign, create: Object.create };

function restoreBuiltins() {
  GUARDED.forEach((o, i) => {
    for (const n of Object.getOwnPropertyNames(o)) if (!pristineOwn[i].has(n)) delete o[n];
  });
  Object.keys = pristineStatics.keys;
  Object.entries = pristineStatics.entries;
  Object.assign = pristineStatics.assign;
  Object.create = pristineStatics.create;
}

function assertBuiltinsIntact() {
  assert.equal(({})['permission-mode'], undefined);
  assert.equal(typeof Object.keys, 'function');
  assert.deepEqual(Object.keys({ a: 1 }), ['a']);
  assert.equal(Object.prototype.hasOwnProperty.call({ a: 1 }, 'a'), true);
  assert.equal(Object.prototype.toString.call({}), '[object Object]');
  GUARDED.forEach((o, i) => assert.deepEqual(new Set(Object.getOwnPropertyNames(o)), pristineOwn[i]));
}

// Parse hostile content with the realm restored after the test either way.
function parseHostile(t, content) {
  t.after(restoreBuiltins);
  return parseFrontmatter(content);
}

test('parseFrontmatter parses a legitimate schedule file as before', () => {
  const { meta, body } = parseFrontmatter(fm([
    'name: HN top articles',
    'cron: */15 9-17 * * 1-5',
    'enabled: true',
    'slug: hn-top',
    'cli:',
    '  model: sonnet-4-6',
    '  permission-mode: acceptEdits',
    '  # commented: out',
    '  add-dirs: C:\\x,D:\\y',
    '  max-budget-usd: 2.50',
    'notes: see C:\\x\\readme',
  ]));
  assert.deepEqual(meta, {
    name: 'HN top articles', cron: '*/15 9-17 * * 1-5', enabled: 'true', slug: 'hn-top',
    notes: 'see C:\\x\\readme',
    cli: { model: 'sonnet-4-6', 'permission-mode': 'acceptEdits', 'add-dirs': 'C:\\x,D:\\y', 'max-budget-usd': '2.50' },
  });
  assert.equal(body, 'Do the thing.');
  assert.equal(Object.getPrototypeOf(meta), Object.prototype);
  assert.equal(Object.getPrototypeOf(meta.cli), Object.prototype);
});

test('parseFrontmatter: an empty block, two blocks and a block followed by a scalar', () => {
  assert.deepEqual(parseFrontmatter(fm(['name: a', 'cli:', 'slug: s'])).meta, { name: 'a', slug: 's' });
  assert.deepEqual(parseFrontmatter(fm(['cli:', '  model: opus', 'extra:', '  k: v', 'slug: s'])).meta,
    { slug: 's', cli: { model: 'opus' }, extra: { k: 'v' } });
});

test('parseFrontmatter: a __proto__ block does not reach Object.prototype', (t) => {
  const { meta } = parseHostile(t, fm(['name: a', '__proto__:', '  permission-mode: bypassPermissions', 'cron: * * * * *']));
  assert.equal(({})['permission-mode'], undefined);
  assert.equal(Object.hasOwn(meta, '__proto__'), false);
  assert.deepEqual(meta, { name: 'a', cron: '* * * * *' });
  assertBuiltinsIntact();
});

test('parseFrontmatter: a constructor block does not overwrite Object.keys', (t) => {
  const { meta } = parseHostile(t, fm(['name: a', 'constructor:', '  keys: casse', 'cron: * * * * *']));
  assert.equal(typeof Object.keys, 'function');
  assert.equal(Object.hasOwn(meta, 'constructor'), false);
  assert.equal(meta.constructor, Object);
  assertBuiltinsIntact();
});

test('parseFrontmatter: blocks named after Object.prototype methods become own keys of meta, not writes on the built-in', (t) => {
  for (const key of ['hasOwnProperty', 'toString', 'valueOf', '__defineGetter__', '__lookupGetter__']) {
    const { meta } = parseHostile(t, fm(['name: a', key + ':', '  call: x', '  apply: x', 'cron: * * * * *']));
    assert.equal(Object.hasOwn(meta, key), true, key);
    assert.deepEqual(meta[key], { call: 'x', apply: 'x' });
    assert.equal(Object.hasOwn(Object.prototype[key], 'call'), false, key);
  }
  assertBuiltinsIntact();
});

test('parseFrontmatter: unsafe inner keys under cli are dropped', (t) => {
  const { meta } = parseHostile(t, fm(['cli:', '  __proto__: polluted', '  constructor: polluted', '  prototype: polluted', '  model: opus']));
  assert.deepEqual(meta, { cli: { model: 'opus' } });
  assert.equal(Object.getPrototypeOf(meta.cli), Object.prototype);
  assert.equal(({}).model, undefined);
  assertBuiltinsIntact();
});

test('parseFrontmatter: unsafe top-level scalars are dropped', (t) => {
  const { meta } = parseHostile(t, fm(['name: a', '__proto__: x', 'constructor: x', 'prototype: x', 'cron: * * * * *']));
  assert.deepEqual(meta, { name: 'a', cron: '* * * * *' });
  assert.equal(meta.constructor, Object);
  assertBuiltinsIntact();
});

test('parseFrontmatter: key spellings are trimmed before the unsafe check', (t) => {
  const inner = '  permission-mode: bypassPermissions';
  for (const spelled of ['__proto__ :', '\t__proto__:', '\uFEFF__proto__:']) {
    const { meta } = parseHostile(t, fm(['name: a', spelled, inner, 'cron: * * * * *']));
    assert.deepEqual(meta, { name: 'a', cron: '* * * * *' }, JSON.stringify(spelled));
    assert.equal(({})['permission-mode'], undefined, JSON.stringify(spelled));
  }
  // A tab-indented inner line under a hostile block is skipped like a space-indented one.
  parseHostile(t, fm(['name: a', '__proto__:', '\tpermission-mode: bypassPermissions']));
  assert.equal(({})['permission-mode'], undefined);
  // Quotes are not YAML-unescaped: the key is the literal text with quotes and is harmless.
  const { meta: quoted } = parseHostile(t, fm(['"__proto__":', inner]));
  assert.deepEqual(quoted, { '"__proto__"': { 'permission-mode': 'bypassPermissions' } });
  assertBuiltinsIntact();
});

test('parseFrontmatter: a file with all hostile blocks still yields its legitimate keys', (t) => {
  const { meta } = parseHostile(t, fm([
    'name: a', 'cron: 0 9 * * *', 'cli:', '  model: opus',
    '__proto__:', '  permission-mode: bypassPermissions',
    'constructor:', '  keys: casse',
    'hasOwnProperty:', '  call: x',
    '__proto__: x', 'constructor: x', 'tail: ok',
  ]));
  assert.equal(meta.name, 'a');
  assert.equal(meta.cron, '0 9 * * *');
  assert.deepEqual(meta.cli, { model: 'opus' });
  assert.equal(meta.tail, 'ok');
  assertBuiltinsIntact();
});

test('built-ins are intact after every hostile input in this file', () => {
  assertBuiltinsIntact();
});
