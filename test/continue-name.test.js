const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A continued session is named after the one it continues.
//
// Jason: "When I continue in new session, the session name should be the
// previous session name with an incrementing number". His answers on the
// details: "Relaunch work" becomes "Relaunch work 2", then "Relaunch work 3";
// a session with no typed name uses the title it was showing; and a title
// that ends in a number of its own keeps it ("Upgrade Electron 41" becomes
// "Upgrade Electron 41 2", then "Upgrade Electron 41 3").
//
// Five parts, each running the text that ships:
//   - the rule (public/continue-name.js continuedName), required directly;
//   - the list of names Continue has given (createStore), on a fake Storage;
//   - launchNewSession out of public/app.js, cut by its markers and run in a
//     vm context against fakes (app.js itself touches the DOM at load);
//   - the session-forked listener out of public/app.js, the same way: a name
//     has to follow a session whose id changes;
//   - the rename box, startRename out of public/sidebar.js, the same way.
// The wiring in handoffContinue is in test/ctx-handoff.test.js, which has the
// harness for it.
//
// What this cannot prove: that a real <input> behaves as the fake one here
// does, or that main stores the name. Those need the app.

const ContinueName = require('../public/continue-name.js');
const { continuedName, createStore, PLACEHOLDER, MAX_STEM, MAX_STEPS, STORE_KEY, MAX_REMEMBERED } = ContinueName;

const APP = path.join(__dirname, '..', 'public', 'app.js');
const SIDEBAR = path.join(__dirname, '..', 'public', 'sidebar.js');

/** The source from `start` up to `end` (or the end of the file). `start` must be there once. */
function cut(src, start, end, file) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `marker not found in ${file}: ${start}`);
  assert.equal(src.indexOf(start, a + 1), -1, `marker is not unique in ${file}: ${start}`);
  if (end == null) return src.slice(a);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `end marker not found after it in ${file}: ${end}`);
  return src.slice(a, b);
}

/** Let everything that is already settled run. */
const settle = () => new Promise((r) => setImmediate(r));

// --- The rule ---

test('continuedName: the first continuation is the title and 2', () => {
  assert.equal(continuedName('Relaunch work'), 'Relaunch work 2');
  assert.equal(continuedName('Relaunch work', {}), 'Relaunch work 2');
  assert.equal(continuedName('Relaunch work', { ours: false }), 'Relaunch work 2');
  // Nothing to count up yet, whoever named it.
  assert.equal(continuedName('Relaunch work', { ours: true }), 'Relaunch work 2');
});

test('continuedName: a number Continue gave is counted up', () => {
  assert.equal(continuedName('Relaunch work 2', { ours: true }), 'Relaunch work 3');
  assert.equal(continuedName('Relaunch work 3', { ours: true }), 'Relaunch work 4');
  assert.equal(continuedName('Relaunch work 9', { ours: true }), 'Relaunch work 10');
  assert.equal(continuedName('Relaunch work 99', { ours: true }), 'Relaunch work 100');
  // Jason's own example, all the way along the chain.
  const first = continuedName('Upgrade Electron 41', { ours: false });
  assert.equal(first, 'Upgrade Electron 41 2');
  assert.equal(continuedName(first, { ours: true }), 'Upgrade Electron 41 3');
});

test('continuedName: a number that is part of the title is left alone', () => {
  for (const title of ['Upgrade Electron 41', 'Relaunch work 2', 'Floor 80', 'Step 0', 'Take 1']) {
    assert.equal(continuedName(title, { ours: false }), title + ' 2', title);
    assert.equal(continuedName(title), title + ' 2', title);
  }
});

test('continuedName: only a number Continue could have written is counted up, even when ours', () => {
  // Continue starts at 2 and writes no sign and no leading zero.
  assert.equal(continuedName('Step 0', { ours: true }), 'Step 0 2');
  assert.equal(continuedName('Take 1', { ours: true }), 'Take 1 2');
  assert.equal(continuedName('Build 007', { ours: true }), 'Build 007 2');
  assert.equal(continuedName('Offset -3', { ours: true }), 'Offset -3 2');
  assert.equal(continuedName('Version 2.5', { ours: true }), 'Version 2.5 2');
  assert.equal(continuedName('Sprint-12', { ours: true }), 'Sprint-12 2');
  assert.equal(continuedName('Rev3', { ours: true }), 'Rev3 2');
  // Too large to add one to.
  assert.equal(continuedName('Ticket 99999999999999999999', { ours: true }), 'Ticket 99999999999999999999 2');
  // `ours` is true or it is not.
  assert.equal(continuedName('Relaunch work 2', { ours: 'yes' }), 'Relaunch work 2 2');
  assert.equal(continuedName('Relaunch work 2', { ours: 1 }), 'Relaunch work 2 2');
});

test('continuedName: a title that is only a number has no stem to count on', () => {
  assert.equal(continuedName('41'), '41 2');
  assert.equal(continuedName('41', { ours: true }), '41 2');
  assert.equal(continuedName('2', { ours: true }), '2 2');
  assert.equal(continuedName('2 2', { ours: true }), '2 3');
});

test('continuedName: nothing worth carrying over is null', () => {
  for (const nothing of ['', '   ', '\n\t', null, undefined, 0, 41, {}, [], true]) {
    assert.equal(continuedName(nothing), null, String(nothing));
    assert.equal(continuedName(nothing, { ours: true, taken: () => true }), null, String(nothing));
  }
  assert.equal(PLACEHOLDER, 'New session');
  assert.equal(continuedName(PLACEHOLDER), null);
  assert.equal(continuedName('  New   session '), null, 'however it is spaced');
  // Only that exact text: a title that merely starts with it is a title.
  assert.equal(continuedName('New session for billing'), 'New session for billing 2');
  assert.equal(continuedName('new session'), 'new session 2');
});

test('continuedName: extra spaces are put right before the number is read', () => {
  assert.equal(continuedName('  Relaunch   work  '), 'Relaunch work 2');
  assert.equal(continuedName('Relaunch work   2  ', { ours: true }), 'Relaunch work 3');
  assert.equal(continuedName('Relaunch\twork\n3', { ours: true }), 'Relaunch work 4');
});

test('continuedName: unicode titles are carried whole', () => {
  assert.equal(continuedName('Résumé façade'), 'Résumé façade 2');
  assert.equal(continuedName('日本語のタイトル 2', { ours: true }), '日本語のタイトル 3');
  assert.equal(continuedName('Ship it \u{1F680}'), 'Ship it \u{1F680} 2');
  assert.equal(continuedName('Ship it \u{1F680} 5', { ours: true }), 'Ship it \u{1F680} 6');
  // Full-width digits are not a number Continue wrote.
  assert.equal(continuedName('Plan \uFF12', { ours: true }), 'Plan \uFF12 2');
});

test('continuedName: a very long title is cut so the number stays in sight', () => {
  const long = 'x'.repeat(500);
  assert.equal(continuedName(long), 'x'.repeat(MAX_STEM) + ' 2');

  // Cut at a space: no double space before the number.
  const spaced = 'a'.repeat(MAX_STEM - 1) + ' ' + 'b'.repeat(50);
  assert.equal(continuedName(spaced), 'a'.repeat(MAX_STEM - 1) + ' 2');

  // Cut by whole characters: never half of an emoji.
  const rockets = '\u{1F680}'.repeat(MAX_STEM + 10);
  const named = continuedName(rockets);
  assert.equal(named, '\u{1F680}'.repeat(MAX_STEM) + ' 2');
  assert.equal(Array.from(named).length, MAX_STEM + 2);

  // The cut name is counted up like any other, and does not grow.
  const next = continuedName(continuedName(long), { ours: true });
  assert.equal(next, 'x'.repeat(MAX_STEM) + ' 3');

  // Exactly at the limit is left whole.
  assert.equal(continuedName('y'.repeat(MAX_STEM)), 'y'.repeat(MAX_STEM) + ' 2');
});

test('continuedName: the stem is short enough for a default-width row, and is cut at a word', () => {
  // A row is one line of 13px text in a 340px sidebar: a stem much past 40
  // characters leaves the number behind the ellipsis, and two siblings then
  // read the same. (From style.css; the real width needs the app.)
  assert.ok(MAX_STEM >= 30 && MAX_STEM <= 48, 'MAX_STEM is ' + MAX_STEM);

  // The summary of a long first prompt, the case that reaches the limit.
  const prompt = 'Look at the invoice double counting in the billing servlet and work out why';
  assert.ok(prompt[MAX_STEM - 1] !== ' ' && prompt[MAX_STEM] !== ' ', 'the limit falls inside a word of this one');
  const named = continuedName(prompt);
  assert.ok(named.endsWith(' 2'));
  const stem = named.slice(0, -2);
  assert.ok(Array.from(stem).length <= MAX_STEM);
  assert.ok(prompt.startsWith(stem + ' '), 'it ends where a word ends: ' + JSON.stringify(stem));
  assert.equal(stem, stem.trim());
  // Its siblings differ from it and from each other within the limit.
  assert.equal(continuedName(named, { ours: true }), stem + ' 3');

  // The limit falls exactly between two words: nothing more is given up.
  const whole = 'v'.repeat(MAX_STEM - 15) + ' ' + 'w'.repeat(14);
  assert.equal(continuedName(whole + ' and more'), whole + ' 2');

  // A space only near the start: cutting there would leave next to nothing,
  // so the long word is cut instead.
  const early = 'Fix ' + 'z'.repeat(200);
  assert.equal(continuedName(early), 'Fix ' + 'z'.repeat(MAX_STEM - 4) + ' 2');
});

test('continuedName: a name that is taken is counted past', () => {
  const inUse = new Set(['Relaunch work 2', 'Relaunch work 3']);
  const taken = (name) => inUse.has(name);
  // Continued a second time from the same session.
  assert.equal(continuedName('Relaunch work', { taken }), 'Relaunch work 4');
  assert.equal(continuedName('Relaunch work 2', { ours: true, taken }), 'Relaunch work 4');
  assert.equal(continuedName('Other work', { taken }), 'Other work 2');
  // The title's own number is still left alone.
  assert.equal(continuedName('Relaunch work 2', { ours: false, taken: (n) => n === 'Relaunch work 2 2' }), 'Relaunch work 2 3');
});

test('continuedName: counting past taken names stops, and a broken check is no check', () => {
  let asked = 0;
  const always = () => { asked++; return true; };
  assert.equal(continuedName('Relaunch work', { taken: always }), 'Relaunch work ' + (2 + MAX_STEPS));
  assert.equal(asked, MAX_STEPS, 'it gives up rather than loop');

  assert.equal(continuedName('Relaunch work', { taken: () => { throw new Error('no session list'); } }), 'Relaunch work 2');
  // Only true means taken.
  for (const taken of [() => 1, () => 'yes', () => undefined, 'not a function', 5, null]) {
    assert.equal(continuedName('Relaunch work', { taken }), 'Relaunch work 2');
  }
});

// --- The list of names Continue has given ---

/** A Storage over a Map. `fail` names the calls that throw: 'get', 'set' or both. */
function fakeStorage({ fail = [] } = {}) {
  const map = new Map();
  const calls = { get: 0, set: 0 };
  return {
    map, calls,
    getItem(key) {
      calls.get++;
      if (fail.includes('get')) throw new Error('storage is off');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      calls.set++;
      if (fail.includes('set')) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
  };
}

const stored = (storage) => JSON.parse(storage.map.get(STORE_KEY));

test('store: a name is ours only for the session it was given to, and only while unchanged', () => {
  const store = createStore(fakeStorage());
  assert.equal(store.isOurs('s1', 'Relaunch work 2'), false, 'nothing remembered yet');
  store.remember('s1', 'Relaunch work 2');
  assert.equal(store.isOurs('s1', 'Relaunch work 2'), true);
  assert.equal(store.isOurs('s2', 'Relaunch work 2'), false, 'another session with the same name');
  // Jason renamed it: the name is his.
  assert.equal(store.isOurs('s1', 'Relaunch work 3'), false);
  assert.equal(store.isOurs('s1', 'relaunch work 2'), false);
  assert.equal(store.isOurs('s1', 'Relaunch work 2 '), false);
  // A session with no typed name at all.
  for (const none of [null, undefined, '', 0, {}]) assert.equal(store.isOurs('s1', none), false, String(none));
  for (const none of [null, undefined, '', 0, {}]) assert.equal(store.isOurs(none, 'Relaunch work 2'), false, String(none));
});

test('store: one JSON list under one key, oldest first', () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  store.remember('s1', 'A 2');
  store.remember('s2', 'B 2');
  assert.deepEqual([...storage.map.keys()], [STORE_KEY]);
  assert.deepEqual(stored(storage), [['s1', 'A 2'], ['s2', 'B 2']]);
  // Remembered again: one entry, moved to the newest end.
  store.remember('s1', 'A 3');
  assert.deepEqual(stored(storage), [['s2', 'B 2'], ['s1', 'A 3']]);
  assert.equal(store.isOurs('s1', 'A 2'), false);
  assert.equal(store.isOurs('s1', 'A 3'), true);
  // What is not an id and a name is not remembered.
  for (const [id, name] of [[null, 'A'], ['', 'A'], ['s3', ''], ['s3', null], [5, 'A'], ['s3', 7]]) store.remember(id, name);
  assert.deepEqual(stored(storage), [['s2', 'B 2'], ['s1', 'A 3']]);
});

test('store: at most MAX_REMEMBERED sessions, the oldest dropped first', () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  for (let i = 0; i < MAX_REMEMBERED + 25; i++) store.remember('s' + i, 'Name ' + i);
  const list = stored(storage);
  assert.equal(list.length, MAX_REMEMBERED);
  assert.deepEqual(list[0], ['s25', 'Name 25']);
  assert.deepEqual(list[list.length - 1], ['s' + (MAX_REMEMBERED + 24), 'Name ' + (MAX_REMEMBERED + 24)]);
  assert.equal(store.isOurs('s24', 'Name 24'), false, 'dropped');
  assert.equal(store.isOurs('s25', 'Name 25'), true);
  // Ids that look like numbers keep their order too (a JSON object would not).
  const numeric = fakeStorage();
  const byNumber = createStore(numeric);
  for (const id of ['30', '4', '100']) byNumber.remember(id, 'n');
  assert.deepEqual(stored(numeric).map((p) => p[0]), ['30', '4', '100']);
});

test('store: storage is shared: another page, or this one after a restart, reads the same list', () => {
  const storage = fakeStorage();
  const before = createStore(storage);
  before.remember('s1', 'Relaunch work 2');
  const after = createStore(storage);        // the app, started again
  assert.equal(after.isOurs('s1', 'Relaunch work 2'), true);
  // Two windows: what one remembers the other sees at once, and neither
  // writes over the other.
  after.remember('s2', 'Other 2');
  assert.equal(before.isOurs('s2', 'Other 2'), true);
  before.remember('s3', 'Third 2');
  assert.deepEqual(stored(storage), [['s1', 'Relaunch work 2'], ['s2', 'Other 2'], ['s3', 'Third 2']]);
});

test('store: two windows past the cap still drop the oldest, not what the other one just gave', () => {
  const storage = fakeStorage();
  const one = createStore(storage);
  const two = createStore(storage);
  const some = MAX_REMEMBERED - 200;
  for (let i = 0; i < some; i++) one.remember('one-' + i, 'One ' + i);
  // The other window fills the list: this window's oldest are dropped.
  for (let i = 0; i < MAX_REMEMBERED - 100; i++) two.remember('two-' + i, 'Two ' + i);
  assert.deepEqual(stored(storage)[0], ['one-200', 'One 200']);
  // One more from the first window. What it still holds in memory of its
  // dropped entries must not come back in place of the other window's.
  one.remember('one-last', 'Last 2');
  const ids = stored(storage).map((p) => p[0]);
  assert.equal(ids.length, MAX_REMEMBERED);
  assert.equal(ids[0], 'one-201', 'only the single oldest went');
  assert.equal(ids[ids.length - 1], 'one-last');
  assert.equal(ids.includes('one-0'), false, 'a dropped entry stays dropped');
  for (let i = 0; i < MAX_REMEMBERED - 100; i++) assert.ok(ids.includes('two-' + i), 'two-' + i);
  assert.equal(two.isOurs('two-0', 'Two 0'), true);
  // The page that gave a dropped name still knows it, for as long as it lives.
  assert.equal(one.isOurs('one-0', 'One 0'), true);
  assert.equal(two.isOurs('one-0', 'One 0'), false);
});

test('store: anything unreadable in storage reads as an empty list and is written over', () => {
  for (const junk of ['{not json', '', 'null', '5', '"text"', '{"s1":"A 2"}', '[1,2,3]', '[["s1"]]', '[["s1",5]]', '[[5,"A 2"]]', '[null,["",""]]']) {
    const storage = fakeStorage();
    storage.map.set(STORE_KEY, junk);
    const store = createStore(storage);
    assert.equal(store.isOurs('s1', 'A 2'), false, junk);
    store.remember('s9', 'Z 2');
    assert.equal(store.isOurs('s9', 'Z 2'), true, junk);
    assert.deepEqual(stored(storage), [['s9', 'Z 2']], junk);
  }
  // A list with one good entry among bad ones keeps the good one.
  const mixed = fakeStorage();
  mixed.map.set(STORE_KEY, JSON.stringify([['s1', 'A 2'], 'x', ['s2'], ['s3', 'C 2', 'extra']]));
  const store = createStore(mixed);
  assert.equal(store.isOurs('s1', 'A 2'), true);
  assert.equal(store.isOurs('s3', 'C 2'), true);
});

test('store: without working storage the page still remembers what it gave', () => {
  const broken = [
    fakeStorage({ fail: ['get', 'set'] }),   // throws on every call
    fakeStorage({ fail: ['set'] }),          // full
    fakeStorage({ fail: ['get'] }),
    null, undefined, {},                     // missing, or not a Storage at all
  ];
  for (const storage of broken) {
    const store = createStore(storage);
    assert.doesNotThrow(() => store.remember('s1', 'Relaunch work 2'));
    assert.equal(store.isOurs('s1', 'Relaunch work 2'), true);
    assert.equal(store.isOurs('s1', 'Relaunch work 3'), false);
    assert.equal(store.isOurs('s2', 'Relaunch work 2'), false);
  }
  // Even then the page's own copy is bounded.
  const store = createStore(null);
  for (let i = 0; i < MAX_REMEMBERED + 10; i++) store.remember('s' + i, 'N ' + i);
  assert.equal(store.isOurs('s9', 'N 9'), false);
  assert.equal(store.isOurs('s10', 'N 10'), true);

  // Storage that was full and then is not: the name it missed is written with the next one.
  const flaky = fakeStorage({ fail: ['set'] });
  const kept = createStore(flaky);
  kept.remember('s1', 'A 2');
  assert.equal(flaky.map.has(STORE_KEY), false);
  flaky.setItem = (key, value) => { flaky.map.set(key, String(value)); };
  kept.remember('s2', 'B 2');
  assert.deepEqual(stored(flaky), [['s1', 'A 2'], ['s2', 'B 2']]);
});

test('the rule and the store together: a chain of three, then a rename by hand', () => {
  const store = createStore(fakeStorage());
  const sessions = new Map([['s1', 'Upgrade Electron 41']]);
  const taken = (name) => [...sessions.values()].includes(name);
  const proceed = (fromId, newId) => {
    const title = sessions.get(fromId);
    const name = continuedName(title, { ours: store.isOurs(fromId, title), taken });
    sessions.set(newId, name);
    store.remember(newId, name);
    return name;
  };
  assert.equal(proceed('s1', 's2'), 'Upgrade Electron 41 2');
  assert.equal(proceed('s2', 's3'), 'Upgrade Electron 41 3');
  assert.equal(proceed('s3', 's4'), 'Upgrade Electron 41 4');
  // Continued again from the middle: the next free number, not a repeat.
  assert.equal(proceed('s2', 's5'), 'Upgrade Electron 41 5');
  // Jason renames s4 to something that ends in a number.
  sessions.set('s4', 'Electron 42');
  assert.equal(proceed('s4', 's6'), 'Electron 42 2');
  assert.equal(proceed('s6', 's7'), 'Electron 42 3');
});

test('index.html loads continue-name.js before ctx-handoff.js', () => {
  // The page's load order cannot be run here, only read. ctx-handoff.js looks
  // window.ContinueName up on each click, so the order is not strictly needed;
  // it is kept so the file is there by the time anything could ask.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const names = html.indexOf('<script src="continue-name.js"></script>');
  const handoff = html.indexOf('<script src="ctx-handoff.js"></script>');
  assert.ok(names > 0, 'continue-name.js has a script tag');
  assert.ok(handoff > names, 'and it comes before ctx-handoff.js');
});

// --- launchNewSession (public/app.js) ---

const LAUNCH = cut(fs.readFileSync(APP, 'utf8'), 'async function launchNewSession(', '// Legacy alias', 'app.js');

/**
 * launchNewSession in a context of its own.
 *   rename   what window.api.renameSession does: a function of (id, name), or
 *            null for a preload that has no such call
 *   open     what window.api.openTerminal resolves to
 */
function bootLaunch({ rename = async () => ({}), open = { ok: true } } = {}) {
  let n = 0;
  const calls = { order: [], renames: [], opens: [], warns: [], shown: [], namesAtRefresh: [], namesAtInject: [] };
  const api = {
    openTerminal: async (...args) => { calls.order.push('open'); calls.opens.push(args); return open; },
  };
  if (rename) api.renameSession = (id, name) => { calls.order.push('rename'); calls.renames.push([id, name]); return rename(id, name); };
  const ctx = {
    crypto: { randomUUID: () => 'new-session-' + (++n) },
    console: { warn: (...a) => calls.warns.push(a), error() {}, log() {} },
    encodeProjectPath: (p) => 'enc:' + p,
    pendingSessions: new Map(),
    sessionMap: new Map(),
    cachedProjects: [],
    cachedAllProjects: [],
    injectPendingIntoTree: (session) => { calls.namesAtInject.push(session.name); },
    refreshSidebar: () => { calls.namesAtRefresh.push([...ctx.sessionMap.values()].map((s) => s.name)); },
    createTerminalEntry: () => ({ terminal: { write() {} }, closed: false }),
    showSession: (id) => { calls.shown.push(id); },
    pollActiveSessions() {},
    window: { api },
  };
  vm.createContext(ctx);
  vm.runInContext(LAUNCH, ctx, { filename: APP });
  return { ctx, calls };
}

const TARGET = { projectPath: 'C:\\work\\alpha' };

test('launchNewSession: a named launch shows the name at once, saves it, and answers with the new id', async () => {
  const app = bootLaunch();
  const id = await app.ctx.launchNewSession(TARGET, { model: 'm' }, { name: 'Relaunch work 2' });
  assert.equal(id, 'new-session-1');
  const session = app.ctx.sessionMap.get(id);
  assert.equal(session.name, 'Relaunch work 2');
  // On the row before the lists were first drawn with it.
  assert.deepEqual(app.calls.namesAtInject, ['Relaunch work 2']);
  assert.deepEqual(app.calls.namesAtRefresh, [['Relaunch work 2']]);
  assert.equal(app.ctx.cachedProjects[0].sessions[0].name, 'Relaunch work 2');
  // Saved the way a rename is, and asked for before the terminal.
  assert.deepEqual(app.calls.renames, [['new-session-1', 'Relaunch work 2']]);
  assert.deepEqual(app.calls.order, ['rename', 'open']);
  assert.deepEqual(app.calls.shown, ['new-session-1']);
  assert.equal(app.calls.warns.length, 0);
  // The options main gets are untouched: a name is not a launch option.
  assert.deepEqual({ ...app.calls.opens[0][3] }, { model: 'm' });
});

test('launchNewSession: without a name nothing is saved and the row is the placeholder, as before', async () => {
  for (const extra of [undefined, {}, { focus: true }, { name: null }, { name: '' }, { name: '   ' }, { name: 41 }, { name: {} }]) {
    const app = bootLaunch();
    const id = await app.ctx.launchNewSession(TARGET, null, extra);
    assert.equal(id, 'new-session-1', JSON.stringify(extra));
    const session = app.ctx.sessionMap.get(id);
    assert.equal(session.name, null, JSON.stringify(extra));
    // The text continue-name.js refuses to carry over is this one.
    assert.equal(session.summary, PLACEHOLDER);
    assert.deepEqual(app.calls.renames, [], JSON.stringify(extra));
    assert.deepEqual(app.calls.order, ['open']);
    assert.equal(app.calls.opens[0][3], null, 'no options is still null');
  }
});

test('launchNewSession: the name is trimmed, and a scheduled launch can carry one without taking the view', async () => {
  const app = bootLaunch();
  const id = await app.ctx.launchNewSession(TARGET, null, { name: '  Nightly  ', focus: false });
  assert.equal(app.ctx.sessionMap.get(id).name, 'Nightly');
  assert.deepEqual(app.calls.renames, [[id, 'Nightly']]);
  assert.deepEqual(app.calls.shown, []);
});

// A limit, because the failure this guards against is a launch that waits
// for the save: without one the file would hang instead of failing.
test('launchNewSession: a save that never answers does not hold up the launch', { timeout: 2000 }, async () => {
  const app = bootLaunch({ rename: () => new Promise(() => {}) });
  const id = await app.ctx.launchNewSession(TARGET, null, { name: 'Relaunch work 2' });
  assert.equal(id, 'new-session-1');
  assert.deepEqual(app.calls.shown, ['new-session-1']);
});

test('launchNewSession: a save that fails is a warning, never a failed launch', async () => {
  // [what renameSession does, how many warnings that is]
  const ways = [
    [() => Promise.reject(new Error('no handler registered')), 1],
    [() => { throw new Error('ipc is gone'); }, 1],
    [null, 1],                               // a preload without renameSession
    [() => undefined, 0],                    // answers nothing, and not a promise: not a failure
  ];
  for (const [rename, warnings] of ways) {
    const app = bootLaunch({ rename });
    const id = await app.ctx.launchNewSession(TARGET, null, { name: 'Relaunch work 2' });
    await settle();
    assert.equal(id, 'new-session-1');
    assert.equal(app.ctx.sessionMap.get(id).name, 'Relaunch work 2', 'the row keeps the name for this page');
    assert.deepEqual(app.calls.order.filter((c) => c === 'open'), ['open']);
    assert.deepEqual(app.calls.shown, ['new-session-1']);
    assert.equal(app.calls.warns.length, warnings);
  }
});

test('launchNewSession: a terminal that cannot be opened answers null', async () => {
  const app = bootLaunch({ open: { ok: false, error: 'folder is gone' } });
  assert.equal(await app.ctx.launchNewSession(TARGET, null, { name: 'Relaunch work 2' }), null);
  assert.deepEqual(app.calls.shown, []);
  const plain = bootLaunch({ open: { ok: false, error: 'folder is gone' } });
  assert.equal(await plain.ctx.launchNewSession(TARGET), null);
});

// --- A session whose id changes (public/app.js, the session-forked listener) ---
//
// Accepting a plan with a cleared context, or a fork, gives the running
// session a new id. Main moves the session but not its saved name, and the
// reload that follows would bring the row back unnamed: the sibling "Relaunch
// work 2" would lose its name, and the next Continue would start over at 2.

const FORKED = cut(fs.readFileSync(APP, 'utf8'), 'window.api.onSessionForked((oldId, newId) => {', 'window.api.onProcessExited(', 'app.js');

/**
 * The listener in a context of its own, with one open session 'old-id'.
 *   session   that session's fields
 *   rename    what window.api.renameSession does, or null for none
 *   names     what handoffNameStore() answers; undefined = ctx-handoff.js is
 *             not loaded
 */
function bootForked({ session = {}, rename = async () => ({}), names } = {}) {
  const calls = { order: [], renames: [], warns: [] };
  let forked = null;
  const api = { onSessionForked: (cb) => { forked = cb; } };
  if (rename) api.renameSession = (id, name) => { calls.order.push('rename'); calls.renames.push([id, name]); return rename(id, name); };
  const row = { sessionId: 'old-id', name: null, ...session };
  const ctx = {
    console: { warn: (...a) => calls.warns.push(a), error() {}, log() {} },
    openSessions: new Map([['old-id', { session: row }]]),
    pendingSessions: new Map(),
    sessionMap: new Map([['old-id', row]]),
    activeSessionId: null,
    setActiveSession() {},
    rekeySessionMaps() {},
    terminalHeaderId: { textContent: '' },
    terminalHeaderName: { textContent: '' },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    loadProjects: async () => { calls.order.push('load'); },
    pollActiveSessions() {},
    window: { api },
  };
  if (names !== undefined) ctx.handoffNameStore = () => names;
  vm.createContext(ctx);
  vm.runInContext(FORKED, ctx, { filename: APP });
  return { ctx, calls, row, fork: (oldId, newId) => forked(oldId, newId) };
}

test('session id change: the name is saved under the new id before the lists are read again', async () => {
  const app = bootForked({ session: { name: 'Relaunch work 2' } });
  app.fork('old-id', 'new-id');
  await settle();
  assert.deepEqual(app.calls.renames, [['new-id', 'Relaunch work 2']]);
  assert.deepEqual(app.calls.order, ['rename', 'load'], 'main has the name before it is asked for the sessions');
  assert.equal(app.ctx.sessionMap.get('new-id').name, 'Relaunch work 2');
  assert.equal(app.ctx.sessionMap.has('old-id'), false);
  assert.equal(app.calls.warns.length, 0);
});

test('session id change: a name Continue gave stays ours under the new id, a typed one stays his', async () => {
  const names = createStore(fakeStorage());
  names.remember('old-id', 'Relaunch work 2');
  const app = bootForked({ session: { name: 'Relaunch work 2' }, names });
  app.fork('old-id', 'new-id');
  await settle();
  assert.equal(names.isOurs('new-id', 'Relaunch work 2'), true);
  // So the next Continue counts up, which is the point.
  assert.equal(continuedName('Relaunch work 2', { ours: names.isOurs('new-id', 'Relaunch work 2') }), 'Relaunch work 3');

  // Renamed by hand since: the name follows the session, but is not ours.
  const typed = createStore(fakeStorage());
  typed.remember('old-id', 'Relaunch work 2');
  const byHand = bootForked({ session: { name: 'Phase 7' }, names: typed });
  byHand.fork('old-id', 'new-id');
  await settle();
  assert.deepEqual(byHand.calls.renames, [['new-id', 'Phase 7']]);
  assert.equal(typed.isOurs('new-id', 'Phase 7'), false);
});

test('session id change: a session with no name saves nothing', async () => {
  for (const name of [null, undefined, '', '   ', 41]) {
    const names = createStore(fakeStorage());
    const app = bootForked({ session: { name, aiTitle: 'Auto title' }, names });
    app.fork('old-id', 'new-id');
    await settle();
    assert.deepEqual(app.calls.renames, [], String(name));
    assert.deepEqual(app.calls.order, ['load']);
    assert.equal(app.ctx.sessionMap.has('new-id'), true);
  }
  // A session this window does not have open is not its to carry.
  const other = bootForked({ session: { name: 'Relaunch work 2' } });
  other.fork('someone-elses', 'new-id');
  await settle();
  assert.deepEqual(other.calls.order, []);
});

test('session id change: nothing in carrying the name can stop the re-key', async () => {
  const brokenStore = { isOurs() { throw new Error('store broke'); }, remember() { throw new Error('store broke'); } };
  // [what the window has, how many warnings that is]
  const ways = [
    [{ rename: () => Promise.reject(new Error('no handler registered')) }, 1],
    [{ rename: () => { throw new Error('ipc is gone'); } }, 1],
    [{ rename: null }, 1],
    [{ rename: () => new Promise(() => {}) }, 0],          // never answers
    [{ names: brokenStore }, 0],
    [{ names: null }, 0],                                   // continue-name.js did not load
    [{}, 0],                                                // nor ctx-handoff.js
  ];
  for (const [has, warnings] of ways) {
    const app = bootForked({ session: { name: 'Relaunch work 2' }, ...has });
    assert.doesNotThrow(() => app.fork('old-id', 'new-id'));
    await settle();
    assert.equal(app.ctx.sessionMap.get('new-id'), app.row);
    assert.equal(app.ctx.openSessions.has('new-id'), true);
    assert.equal(app.ctx.terminalHeaderId.textContent, 'new-id');
    assert.deepEqual(app.calls.order.filter((c) => c === 'load'), ['load']);
    assert.equal(app.calls.warns.length, warnings);
  }
});

// --- The rename box (public/sidebar.js startRename) ---
//
// Two faults reported in review on 2026-10-04, both real:
//   - a click inside the open box bubbled to the session row, whose click
//     opens the session and focuses its terminal: the box lost focus and
//     closed;
//   - leaving the box without typing could save the automatic title as a
//     typed name, when the title had changed while the box was open or the
//     box could not hold it exactly (a text input drops line breaks).

const RENAME = cut(fs.readFileSync(SIDEBAR, 'utf8'), 'function startRename(summaryEl, session) {', null, 'sidebar.js');

/** An element that can stand in a row and be swapped for another. As a text
 *  input does, it drops line breaks from the value it is given. */
function fakeEl(tag, row) {
  const heard = [];
  let value = '';
  const el = {
    tag, row, className: '', textContent: '', type: '', focused: false, selected: false,
    get value() { return value; },
    set value(v) { value = String(v).replace(/[\r\n]/g, ''); },
    addEventListener(type, fn) { heard.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = heard.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) heard.splice(i, 1);
    },
    /** Send an event to this element's listeners; resolves when they have all finished. */
    fire(type, event = {}) { return Promise.all(heard.filter((l) => l.type === type).map((l) => l.fn(event))); },
    listens: (type) => heard.some((l) => l.type === type),
    replaceWith(other) { other.row = el.row; el.row.shows = other; el.row = null; },
    focus() { el.focused = true; },
    select() { el.selected = true; },
    blur() { el.focused = false; return el.fire('blur'); },
  };
  return el;
}

/** startRename on a session row: the box is open when this returns. */
function bootRename(session) {
  const calls = { renames: [] };
  const row = { shows: null };
  const ctx = {
    document: { createElement: (tag) => fakeEl(tag, null) },
    window: { api: { renameSession: async (id, name) => { calls.renames.push([id, name]); return { name }; } } },
  };
  vm.createContext(ctx);
  vm.runInContext(RENAME, ctx, { filename: SIDEBAR });
  const summaryEl = fakeEl('div', row);
  summaryEl.className = 'session-summary';
  row.shows = summaryEl;
  ctx.startRename(summaryEl, session);
  const input = row.shows;
  assert.equal(input.tag, 'input', 'the box took the title\'s place');
  return { ctx, calls, row, summaryEl, input };
}

test('rename box: it opens on the name, or on the automatic title when there is none', () => {
  assert.equal(bootRename({ sessionId: 's1', name: 'Mine', aiTitle: 'Auto', summary: 'first words' }).input.value, 'Mine');
  assert.equal(bootRename({ sessionId: 's1', name: null, aiTitle: 'Auto', summary: 'first words' }).input.value, 'Auto');
  assert.equal(bootRename({ sessionId: 's1', name: null, summary: 'first words' }).input.value, 'first words');
  const empty = bootRename({ sessionId: 's1', name: null });
  assert.equal(empty.input.value, '', 'not the word "undefined"');
  assert.equal(empty.input.focused && empty.input.selected, true);
});

test('rename box: a click inside it does not reach the session row', async () => {
  const box = bootRename({ sessionId: 's1', name: null, aiTitle: 'Auto' });
  let stopped = 0;
  await box.input.fire('click', { stopPropagation() { stopped++; } });
  assert.equal(stopped, 1);
  assert.equal(box.row.shows, box.input, 'and the box stays open');
  assert.deepEqual(box.calls.renames, []);
});

test('rename box: a right-click inside it does not reach the session row either', async () => {
  // The row's own right-click opens "Move to project" (sidebar.js
  // item.oncontextmenu), on top of a name that is half typed.
  const box = bootRename({ sessionId: 's1', name: null, aiTitle: 'Auto' });
  box.input.value = 'Half an idea';
  let stopped = 0;
  let prevented = 0;
  await box.input.fire('contextmenu', { stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
  assert.equal(stopped, 1);
  assert.equal(prevented, 0, 'the box keeps whatever menu a text box has');
  assert.equal(box.row.shows, box.input);
  assert.deepEqual(box.calls.renames, []);
});

test('rename box: left unchanged, nothing is saved and the row goes back as it was', async () => {
  for (const session of [
    { sessionId: 's1', name: null, aiTitle: 'Auto title', summary: 'first words' },
    { sessionId: 's1', name: 'Typed by Jason', aiTitle: 'Auto title' },
    { sessionId: 's1', name: null, summary: '  padded summary ' },
    { sessionId: 's1', name: null },
  ]) {
    const before = session.name;
    const box = bootRename(session);
    await box.input.blur();
    assert.deepEqual(box.calls.renames, [], JSON.stringify(session));
    assert.equal(session.name, before);
    assert.equal(box.row.shows, box.summaryEl, 'the same element, with what it carried');
  }
  // Enter is the same as leaving.
  const enter = bootRename({ sessionId: 's1', name: null, aiTitle: 'Auto title' });
  await enter.input.fire('keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(enter.calls.renames, []);
  assert.equal(enter.row.shows, enter.summaryEl);
});

test('rename box: an automatic title that changed while the box was open is not saved as a typed name', async () => {
  const session = { sessionId: 's1', name: null, aiTitle: null, summary: 'please fix the scheduler' };
  const box = bootRename(session);
  // The AI title arrives while Jason is looking at the box.
  session.aiTitle = 'Fix the scheduler';
  await box.input.blur();
  assert.deepEqual(box.calls.renames, []);
  assert.equal(session.name, null);
  assert.equal(box.row.shows, box.summaryEl);
});

test('rename box: a title the box cannot hold exactly is not saved as a typed name', async () => {
  // A summary with a line break in it: the input shows it on one line.
  const session = { sessionId: 's1', name: null, summary: 'fix the scheduler\nand the tests' };
  const box = bootRename(session);
  assert.equal(box.input.value, 'fix the schedulerand the tests');
  await box.input.blur();
  assert.deepEqual(box.calls.renames, []);
  assert.equal(session.name, null);
});

test('rename box: a changed name is saved, and the automatic title or nothing clears it', async () => {
  const typed = { sessionId: 's1', name: null, aiTitle: 'Auto title' };
  const box = bootRename(typed);
  box.input.value = '  Relaunch work  ';
  await box.input.blur();
  assert.deepEqual(box.calls.renames, [['s1', 'Relaunch work']]);
  assert.equal(typed.name, 'Relaunch work');
  assert.equal(box.row.shows.textContent, 'Relaunch work');
  assert.equal(box.row.shows.className, 'session-summary');
  assert.equal(box.row.shows.listens('dblclick'), true, 'and it can be renamed again');

  // Typing the automatic title back, or emptying the box, is "no typed name".
  for (const text of ['Auto title', ' Auto title ', '', '   ']) {
    const session = { sessionId: 's2', name: 'Typed by Jason', aiTitle: 'Auto title' };
    const again = bootRename(session);
    again.input.value = text;
    await again.input.blur();
    assert.deepEqual(again.calls.renames, [['s2', null]], JSON.stringify(text));
    assert.equal(session.name, null);
    assert.equal(again.row.shows.textContent, 'Auto title');
  }
});

test('rename box: Escape puts the title back and saves nothing, whatever was typed', async () => {
  const session = { sessionId: 's1', name: 'Typed by Jason', aiTitle: 'Auto title' };
  const box = bootRename(session);
  box.input.value = 'Half an idea';
  await box.input.fire('keydown', { key: 'Escape' });
  assert.deepEqual(box.calls.renames, []);
  assert.equal(session.name, 'Typed by Jason');
  assert.equal(box.row.shows.textContent, 'Typed by Jason');
  assert.equal(box.input.listens('blur'), false, 'the box will not save when it goes');
});
