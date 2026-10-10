'use strict';
// Pin tests (relaunch work, Phase 1b): the terminal header, the status bar
// text and the running check of public/app.js, as they are today, so that a
// later fix cannot change them unnoticed.
//
//   21  the header's Running or Stopped and its Stop button
//   22  the wording of the status bar's left text
//   23  the running check: a new Set, the dots, the header, the re-arm
//   24  the header TITLE of a session started with a typed name
//
// Each block is cut out of the file that ships by two marker strings and run
// in a vm context against fakes (test-support/source-cut.js). No line numbers:
// a marker is a function's first line or a comment line, and the helper demands
// that each is in its file exactly once.
//
// Objects made inside a block belong to the block's context: a Set made there
// is not `instanceof Set` here. The tests compare fields and spread first.

const test = require('node:test');
const assert = require('node:assert/strict');

const { cut, load, peek } = require('../test-support/source-cut');

const APP = 'public/app.js';

// The running check, the dots and the header status: from the two cadence
// constants through updateTerminalHeader. The line after the end marker's line
// arms the first timer when the page loads; it is outside the cut, so loading
// the block arms nothing.
const RUNNING_CHECK = cut(APP, 'const POLL_FAST_MS = 3000;',
  "const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');");

// The header status alone (the last function of the block above).
const HEADER_STATUS = cut(APP, 'function updateTerminalHeader() {',
  "const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');");

// The status bar's left text.
const STATUS_TEXT = cut(APP, 'function renderDefaultStatus() {', 'window.api.onStatusUpdate((text, type) => {');

// The session map, dedup, loadProjects, launchNewSession and showTerminalHeader.
const LIST_AND_HEADER_TITLE = cut(APP, '// Shared session map so all caches reference the same objects',
  '// Every call into the task runner from this file and from sidebar.js is');

// What a click on a session does: public/terminal-manager.js showSession, the
// only caller of showTerminalHeader.
const SHOW_SESSION = cut('public/terminal-manager.js', 'function showSession(sessionId) {',
  'function setupDragAndDrop(container, getSessionId) {');

// encodeProjectPath and cleanDisplayName, the real ones.
const NAME_HELPERS = cut('public/utils.js', 'function encodeProjectPath(projectPath) {', 'function formatDate(date) {');

// --- Fakes ------------------------------------------------------------------

/** An element's classList. */
function classes(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => { for (const n of names) set.add(n); },
    remove: (...names) => { for (const n of names) set.delete(n); },
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : !!force;
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains: (name) => set.has(name),
  };
}

/** The header's status text and its Stop button, as the page has them before any draw. */
function fakeHeader() {
  return {
    status: { className: '', textContent: '' },
    stop: { style: { display: '' } },
  };
}
const headerState = (header) => ({ cls: header.status.className, text: header.status.textContent, stop: header.stop.style.display });
const HEADER_RUNNING = { cls: 'running', text: 'Running', stop: '' };
const HEADER_STOPPED = { cls: 'stopped', text: 'Stopped', stop: 'none' };
const HEADER_UNDRAWN = { cls: '', text: '', stop: '' };

/** One turn of the event loop: every promise the block left running has settled. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Hand-made timers: every setTimeout is kept, nothing ever fires by itself. */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  };
}

// --- Pin 21 -----------------------------------------------------------------

/** updateTerminalHeader in a page of its own. */
function bootHeaderStatus({ active = 'sess1', running = [] } = {}) {
  const header = fakeHeader();
  const seen = { ptyTitles: 0 };
  const ctx = load(HEADER_STATUS, {
    file: APP,
    globals: {
      activeSessionId: active,
      activePtyIds: new Set(running),
      terminalHeaderStatus: header.status,
      terminalStopBtn: header.stop,
      updatePtyTitle: () => { seen.ptyTitles++; },
    },
  });
  return { ctx, header, seen };
}

test('header-and-status (pin): the header shows Running or Stopped and the Stop button from the running set', async (t) => {
  await t.test('the session on screen is in the running set: Running, class running, the Stop button shown', () => {
    const page = bootHeaderStatus({ active: 'sess1', running: ['sess1', 'other'] });
    page.header.stop.style.display = 'none'; // as a stopped session left it
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);

    // Wherever it is in the set: last of two, and in the middle of three.
    for (const running of [['other', 'sess1'], ['other', 'sess1', 'third']]) {
      const later = bootHeaderStatus({ active: 'sess1', running });
      later.header.stop.style.display = 'none';
      later.ctx.updateTerminalHeader();
      assert.deepEqual(headerState(later.header), HEADER_RUNNING, JSON.stringify(running));
    }
  });

  await t.test('the session on screen is not in the running set: Stopped, class stopped, the Stop button hidden', () => {
    const page = bootHeaderStatus({ active: 'sess1', running: ['other'] });
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_STOPPED);

    const none = bootHeaderStatus({ active: 'sess1', running: [] });
    none.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(none.header), HEADER_STOPPED);
  });

  await t.test('it is the running set that decides, read at every draw: the set as it is now, and a set that replaced it', () => {
    const page = bootHeaderStatus({ active: 'sess1', running: [] });
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_STOPPED);

    page.ctx.activePtyIds.add('sess1');
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);

    page.ctx.activePtyIds.delete('sess1');
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_STOPPED);

    // The running check replaces the set with a new one (pin 23).
    page.ctx.activePtyIds = new Set(['sess1']);
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);
  });

  await t.test('it is about the session on screen: another session running does not make it Running, and a change of session changes the answer', () => {
    const page = bootHeaderStatus({ active: 'sess1', running: ['other'] });
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_STOPPED);
    page.ctx.activeSessionId = 'other';
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);
  });

  await t.test('with no session on screen nothing in the header is touched', () => {
    for (const nobody of [null, undefined, '']) {
      const page = bootHeaderStatus({ running: ['sess1'] });
      page.ctx.activeSessionId = nobody;
      page.ctx.updateTerminalHeader();
      assert.deepEqual(headerState(page.header), HEADER_UNDRAWN, String(nobody));
      assert.equal(page.seen.ptyTitles, 0, 'the terminal\'s own title is not redrawn either');
    }
    // What a session left behind stays as it was.
    const page = bootHeaderStatus({ active: 'sess1', running: ['sess1'] });
    page.ctx.updateTerminalHeader();
    page.ctx.activeSessionId = null;
    page.ctx.activePtyIds = new Set();
    page.ctx.updateTerminalHeader();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);
  });

  await t.test('every draw for a session also redraws the terminal\'s own title, once', () => {
    const page = bootHeaderStatus({ active: 'sess1', running: ['sess1'] });
    page.ctx.updateTerminalHeader();
    assert.equal(page.seen.ptyTitles, 1);
    page.ctx.activePtyIds = new Set();
    page.ctx.updateTerminalHeader();
    assert.equal(page.seen.ptyTitles, 2);
  });

  // From the recheck round (second reader's n21b, n21d): the first subtest
  // tries the session on screen first of two, last of two and second of
  // three; never third or later, never last of three.
  await t.test('the session on screen is in the running set as the last of three and as the third of four: Running', () => {
    for (const running of [['other', 'third', 'sess1'], ['other', 'third', 'sess1', 'fourth']]) {
      const page = bootHeaderStatus({ active: 'sess1', running });
      page.header.stop.style.display = 'none';
      page.ctx.updateTerminalHeader();
      assert.deepEqual(headerState(page.header), HEADER_RUNNING, JSON.stringify(running));
    }
  });
});

// --- Pin 22 -----------------------------------------------------------------

const DOT = ' \u00b7 ';

/** Folders with this many sessions each: [3, 2] is two folders holding five sessions. */
const folders = (...counts) => counts.map((n, f) => ({
  projectPath: 'C:\\work\\f' + f,
  sessions: Array.from({ length: n }, (_, i) => ({ sessionId: `f${f}-s${i}` })),
}));

/** A project tree with one project per status given. */
const tree = (...statuses) => ({ projects: statuses.map((status, i) => ({ id: 'p' + i, status })) });

/**
 * renderDefaultStatus in a page of its own. Answers the text it wrote, and
 * every property it set on the status bar's info element.
 */
function statusText({ running = [], all = [], projectTree = { projects: [] } } = {}) {
  const written = [];
  const statusBarInfo = new Proxy({ textContent: '(never written)' }, {
    set(target, key, value) { written.push(key); target[key] = value; return true; },
  });
  const ctx = load(STATUS_TEXT, {
    file: APP,
    globals: {
      cachedAllProjects: all,
      cachedProjectTreeAll: projectTree,
      activePtyIds: new Set(running),
      statusBarInfo,
    },
  });
  ctx.renderDefaultStatus();
  return { text: statusBarInfo.textContent, written };
}

test('header-and-status (pin): the status bar wording for 0 and 2 running and for 0, 1 and 3 projects', async (t) => {
  await t.test('0 running: the running part is left out', () => {
    assert.equal(statusText({ running: [], all: folders(3, 2) }).text, '5 sessions' + DOT + '2 folders');
  });

  await t.test('2 running: it comes first', () => {
    assert.equal(statusText({ running: ['f0-s0', 'f1-s1'], all: folders(3, 2) }).text,
      '2 running' + DOT + '5 sessions' + DOT + '2 folders');
    assert.equal(statusText({ running: ['f0-s0'], all: folders(3, 2) }).text,
      '1 running' + DOT + '5 sessions' + DOT + '2 folders', 'one is "1 running": the word has no plural');
  });

  await t.test('0 projects: the projects part is left out', () => {
    assert.equal(statusText({ all: folders(3, 2), projectTree: tree() }).text, '5 sessions' + DOT + '2 folders');
  });

  await t.test('1 project: "1 project", last', () => {
    assert.equal(statusText({ all: folders(3, 2), projectTree: tree('active') }).text,
      '5 sessions' + DOT + '2 folders' + DOT + '1 project');
  });

  await t.test('3 projects: "3 projects", last', () => {
    assert.equal(statusText({ all: folders(3, 2), projectTree: tree('active', 'active', 'active') }).text,
      '5 sessions' + DOT + '2 folders' + DOT + '3 projects');
  });

  await t.test('all four parts, in the order running, sessions, folders, projects, joined by a middle dot between spaces', () => {
    const { text } = statusText({ running: ['f0-s0', 'f1-s1'], all: folders(3, 2), projectTree: tree('active', 'active', 'active') });
    assert.equal(text, '2 running \u00b7 5 sessions \u00b7 2 folders \u00b7 3 projects');
  });

  await t.test('only a project whose status is active is counted', () => {
    assert.equal(statusText({ all: folders(1), projectTree: tree('active', 'archived', 'active', 'done', 'active', undefined) }).text,
      '1 sessions' + DOT + '1 folders' + DOT + '3 projects');
    assert.equal(statusText({ all: folders(1), projectTree: tree('archived', 'archived') }).text,
      '1 sessions' + DOT + '1 folders', 'no active project: no projects part');
  });

  await t.test('sessions and folders are always there, and their words never change with the number', () => {
    assert.equal(statusText({ all: [] }).text, '0 sessions' + DOT + '0 folders');
    assert.equal(statusText({ all: folders(1) }).text, '1 sessions' + DOT + '1 folders');
    assert.equal(statusText({ all: folders(0, 0, 4) }).text, '4 sessions' + DOT + '3 folders', 'an empty folder is still a folder');
  });

  await t.test('the running number is the size of the running set, whatever the lists hold', () => {
    assert.equal(statusText({ running: ['not-in-any-folder', 'nor-this-one'], all: [] }).text,
      '2 running' + DOT + '0 sessions' + DOT + '0 folders');
  });

  await t.test('a page with no project tree still gets its text', () => {
    for (const noTree of [null, undefined, {}, { projects: null }]) {
      assert.equal(statusText({ all: folders(2), projectTree: noTree }).text, '2 sessions' + DOT + '1 folders', JSON.stringify(noTree));
    }
  });

  await t.test('it writes the text of the info element and nothing else of it', () => {
    assert.deepEqual(statusText({ running: ['a'], all: folders(2), projectTree: tree('active') }).written, ['textContent']);
  });
});

// --- Pin 23 -----------------------------------------------------------------

/**
 * The running check in a page of its own, with the real updateRunningIndicators
 * and the real updateTerminalHeader behind it.
 *   running   the running set before the check
 *   active    the session on screen
 * The page has three sidebar rows (row-a, row-b, row-c), row-a and row-b inside
 * one slug group, and one grid card for row-a. `page.answer` is what the next
 * call of window.api.getActiveSessions does.
 */
function bootRunningCheck({ running = [], active = 'row-a', api = true } = {}) {
  const clock = fakeTimers();
  const header = fakeHeader();
  const seen = { asks: 0, projectDots: 0, ptyTitles: 0 };

  const rows = ['row-a', 'row-b', 'row-c'].map((id) => {
    const dot = { classList: classes() };
    return {
      id, dot,
      dataset: { sessionId: id },
      classList: classes(),
      querySelector: (selector) => (selector === '.session-status-dot' ? dot : null),
    };
  });
  const groupDot = { classList: classes() };
  const group = {
    querySelector: (selector) => {
      if (selector === '.session-item.has-running-pty') return rows.slice(0, 2).find((r) => r.classList.contains('has-running-pty')) || null;
      return selector === '.slug-group-dot' ? groupDot : null;
    },
  };
  const card = {
    dot: { className: 'grid-card-dot' },
    footer: { children: [{ textContent: '' }] },
    stop: { style: { display: '' } },
  };
  card.querySelector = (selector) => ({
    '.grid-card-dot': card.dot, '.grid-card-footer': card.footer, '.grid-card-stop-btn': card.stop,
  })[selector] || null;

  const page = { clock, header, seen, rows, groupDot, card, answer: async () => [] };
  const windowApi = api ? { getActiveSessions: () => { seen.asks++; return page.answer(); } } : {};
  page.ctx = load(RUNNING_CHECK, {
    file: APP,
    globals: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      window: { api: windowApi },
      activePtyIds: new Set(running),
      activeSessionId: active,
      document: {
        querySelectorAll: (selector) => (selector === '.session-item' ? rows : selector === '.slug-group' ? [group] : []),
      },
      attentionSessions: new Set(),
      responseReadySessions: new Set(),
      sessionBusyState: new Map(),
      gridCards: new Map([['row-a', card]]),
      updateProjectStatusDots: () => { seen.projectDots++; },
      terminalHeaderStatus: header.status,
      terminalStopBtn: header.stop,
      updatePtyTitle: () => { seen.ptyTitles++; },
      // Not called by today's check. The approved "N running keeps up" fix
      // redraws the status bar from here; pin 22 covers that text.
      renderDefaultStatus: () => {},
    },
  });
  return page;
}

/** What the rows, the group and the grid card show. */
function dots(page) {
  return {
    rows: Object.fromEntries(page.rows.map((r) => [r.id, r.classList.contains('has-running-pty')])),
    rowDots: Object.fromEntries(page.rows.map((r) => [r.id, r.dot.classList.contains('running')])),
    group: page.groupDot.classList.contains('running'),
    card: { dot: page.card.dot.className, text: page.card.footer.children[0].textContent, stop: page.card.stop.style.display },
  };
}
const NOTHING_DRAWN = {
  rows: { 'row-a': false, 'row-b': false, 'row-c': false },
  rowDots: { 'row-a': false, 'row-b': false, 'row-c': false },
  group: false,
  card: { dot: 'grid-card-dot', text: '', stop: '' },
};

/** The timers that are still to fire. */
const armed = (page) => page.clock.timers.filter((timer) => !timer.cleared && !timer.fired);
/** Fires a timer the way the browser would. */
async function fire(timer) { timer.fired = true; await timer.fn(); }

const isASet = (value) => Object.prototype.toString.call(value) === '[object Set]';

test('header-and-status (pin): the running check replaces the set with a new Set, updates dots and header, and re-arms itself at 3 s or 30 s, also when the call rejects', async (t) => {
  await t.test('an answer with ids: a new Set holding them, the old one left as it was', async () => {
    const page = bootRunningCheck({ running: [] });
    const before = page.ctx.activePtyIds;
    page.answer = async () => ['row-a', 'row-c'];
    await page.ctx.pollActiveSessions();

    const after = page.ctx.activePtyIds;
    assert.notEqual(after, before, 'the set is another object, not the old one refilled');
    assert.ok(isASet(after), 'and it is a Set');
    assert.deepEqual([...after], ['row-a', 'row-c']);
    assert.equal(before.size, 0, 'the old set was not written to');
    assert.equal(page.seen.asks, 1, 'main is asked once');
  });

  await t.test('an empty answer: a new empty Set, and the old one keeps its ids', async () => {
    const page = bootRunningCheck({ running: ['row-a', 'row-b'] });
    const before = page.ctx.activePtyIds;
    page.answer = async () => [];
    await page.ctx.pollActiveSessions();

    assert.notEqual(page.ctx.activePtyIds, before);
    assert.ok(isASet(page.ctx.activePtyIds));
    assert.equal(page.ctx.activePtyIds.size, 0);
    assert.deepEqual([...before], ['row-a', 'row-b'], 'the old set was not emptied in place');
  });

  await t.test('the dots follow the answer: rows, the group\'s dot, the grid card and the project rows', async () => {
    const page = bootRunningCheck({ running: [] });
    page.answer = async () => ['row-a', 'row-c'];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(dots(page), {
      rows: { 'row-a': true, 'row-b': false, 'row-c': true },
      rowDots: { 'row-a': true, 'row-b': false, 'row-c': true },
      group: true,
      card: { dot: 'grid-card-dot running', text: 'Running', stop: '' },
    });
    assert.equal(page.seen.projectDots, 1, 'the project rows are rolled up once');

    // And back: nothing runs any more.
    page.answer = async () => [];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(dots(page), {
      rows: { 'row-a': false, 'row-b': false, 'row-c': false },
      rowDots: { 'row-a': false, 'row-b': false, 'row-c': false },
      group: false,
      card: { dot: 'grid-card-dot stopped', text: 'Stopped', stop: 'none' },
    });
    assert.equal(page.seen.projectDots, 2);
  });

  // The three classes below are what colours a row's dot beyond "running"
  // (busy, ready, needs attention); the page keeps the same three facts in
  // attentionSessions, responseReadySessions and sessionBusyState.
  await t.test('the dots of a row that stopped: its busy, ready and attention marks are cleared; a row that still runs keeps them', async () => {
    const MARKS = ['needs-attention', 'response-ready', 'cli-busy'];
    const page = bootRunningCheck({ running: ['row-a', 'row-b'] });
    for (const row of page.rows.slice(0, 2)) row.classList.add(...MARKS);
    for (const id of ['row-a', 'row-b']) {
      page.ctx.attentionSessions.add(id);
      page.ctx.responseReadySessions.add(id);
      page.ctx.sessionBusyState.set(id, true);
    }
    const marks = (row) => MARKS.filter((name) => row.classList.contains(name));
    const kept = () => [[...page.ctx.attentionSessions], [...page.ctx.responseReadySessions], [...page.ctx.sessionBusyState.keys()]];

    // row-b stopped, row-a still runs.
    page.answer = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(marks(page.rows[0]), MARKS, 'still running: its marks are untouched');
    assert.deepEqual(marks(page.rows[1]), [], 'stopped: all three marks are gone');
    assert.deepEqual(kept(), [['row-a'], ['row-a'], ['row-a']], 'and the page forgot the stopped row in all three collections');
    assert.equal(page.ctx.sessionBusyState.get('row-a'), true, 'the running row\'s busy state has its value still');
    assert.equal(page.card.dot.className, 'grid-card-dot busy', 'a running card that is busy shows busy, not running');
    assert.equal(page.card.footer.children[0].textContent, 'Running', 'its text still says Running');

    // Now row-a stops too: its marks go, and its card shows stopped, not busy.
    page.answer = async () => [];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(marks(page.rows[0]), []);
    assert.deepEqual(kept(), [[], [], []]);
    assert.equal(page.card.dot.className, 'grid-card-dot stopped', 'a card whose session stopped is not left busy');
  });

  await t.test('the header follows the answer', async () => {
    const page = bootRunningCheck({ running: [], active: 'row-a' });
    page.answer = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);

    page.answer = async () => ['row-b'];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(headerState(page.header), HEADER_STOPPED, 'the session on screen is not in the answer');
  });

  await t.test('it re-arms itself: 3 s while something runs, 30 s when nothing does, by the answer it just got', async () => {
    const page = bootRunningCheck({ running: [] });
    assert.equal(page.clock.timers.length, 0, 'nothing is armed before the first check');

    page.answer = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.equal(page.clock.timers.length, 1);
    assert.equal(page.clock.timers[0].ms, 3000, 'the set was empty before; the answer decides');
    assert.equal(page.clock.timers[0].fn, page.ctx.pollActiveSessions, 'what the timer runs is the check itself');
    assert.equal(peek(page.ctx, 'pollTimer'), page.clock.timers[0], 'the armed timer is the one the page remembers');

    page.answer = async () => [];
    await fire(page.clock.timers[0]);
    assert.equal(page.seen.asks, 2, 'the timer asked main again');
    assert.equal(page.clock.timers.length, 2);
    assert.equal(page.clock.timers[1].ms, 30000);

    page.answer = async () => ['row-b', 'row-c'];
    await fire(page.clock.timers[1]);
    assert.equal(page.seen.asks, 3);
    assert.equal(page.clock.timers[2].ms, 3000);
    assert.deepEqual(armed(page), [page.clock.timers[2]], 'one timer is armed, the last');
    assert.deepEqual([peek(page.ctx, 'POLL_FAST_MS'), peek(page.ctx, 'POLL_IDLE_MS')], [3000, 30000]);
  });

  await t.test('a check made while a timer is armed drops that timer: never two', async () => {
    const page = bootRunningCheck({ running: [] });
    page.answer = async () => ['row-a'];
    await page.ctx.pollActiveSessions(); // as a launch or a click calls it
    await page.ctx.pollActiveSessions();
    await page.ctx.pollActiveSessions();
    assert.equal(page.clock.timers.length, 3);
    assert.deepEqual(page.clock.timers.map((timer) => timer.cleared), [true, true, false]);
    assert.deepEqual(armed(page), [page.clock.timers[2]]);
  });

  await t.test('the call rejects: the set, the dots and the header are left alone, the check still ends and still re-arms', async () => {
    // Something was running: 3 s.
    const page = bootRunningCheck({ running: ['row-b'], active: 'row-a' });
    const before = page.ctx.activePtyIds;
    page.answer = () => Promise.reject(new Error('main did not answer'));
    assert.equal(await page.ctx.pollActiveSessions(), undefined, 'the check does not reject');
    assert.equal(page.ctx.activePtyIds, before, 'the same set object');
    assert.deepEqual([...before], ['row-b']);
    assert.deepEqual(dots(page), NOTHING_DRAWN);
    assert.equal(page.seen.projectDots, 0);
    assert.deepEqual(headerState(page.header), HEADER_UNDRAWN);
    assert.deepEqual(armed(page).map((timer) => timer.ms), [3000], 'by the set it still has');
    assert.equal(armed(page)[0].fn, page.ctx.pollActiveSessions);

    // Nothing was running: 30 s.
    const idle = bootRunningCheck({ running: [] });
    idle.answer = () => Promise.reject(new Error('main did not answer'));
    await idle.ctx.pollActiveSessions();
    assert.equal(idle.ctx.activePtyIds.size, 0);
    assert.deepEqual(armed(idle).map((timer) => timer.ms), [30000]);

    // And the next check, when main answers again, works as ever.
    page.answer = async () => ['row-a'];
    await fire(armed(page)[0]);
    assert.deepEqual([...page.ctx.activePtyIds], ['row-a']);
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);
    assert.deepEqual(armed(page).map((timer) => timer.ms), [3000]);
  });

  await t.test('the call throws at once (a page without that call): the same', async () => {
    const page = bootRunningCheck({ running: ['row-a'], api: false });
    const before = page.ctx.activePtyIds;
    assert.equal(await page.ctx.pollActiveSessions(), undefined);
    assert.equal(page.ctx.activePtyIds, before);
    assert.deepEqual(dots(page), NOTHING_DRAWN);
    assert.deepEqual(armed(page).map((timer) => timer.ms), [3000]);
  });

  // From the recheck round (second reader's n23h): the subtests above only
  // ever store true as a busy state, or nothing. The page stores false too
  // (a session that went idle), and that card is running, not busy.
  await t.test('a running card whose session has a busy entry that says false shows running, not busy', async () => {
    const page = bootRunningCheck({ running: ['row-a'] });
    page.ctx.sessionBusyState.set('row-a', false);
    page.answer = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.equal(page.card.dot.className, 'grid-card-dot running');
    assert.deepEqual([...page.ctx.sessionBusyState], [['row-a', false]], 'a running row keeps its entry as it is');
  });
});

// --- Pin 24 -----------------------------------------------------------------
//
// What is recorded here (2026-10-06, public/app.js at 7480022):
//   - First draw: the header title is the typed name (trimmed, and cleaned the
//     way every title is). It is never 'New session'.
//   - After the next reload of the list: still the typed name, while the
//     session is pending and after its real row has arrived with the name main
//     saved. When this was recorded loadProjects did not write the header
//     title at all: showTerminalHeader wrote it, which only showSession calls.
//     Since the small fix "the header title follows the row" loadProjects ends
//     with syncTerminalHeaderName, which writes the row's title.
//   - So the fault "a session started with a typed name flips to New session"
//     does NOT show on this path today.
// One more case is recorded but its header text is only printed, not asserted:
// a reload whose row carries NO name (the save never reached main). When this
// was recorded the header kept the typed name because nothing redrew it, while
// the session's own record lost the name. Since that fix the header follows the
// row and shows the row's title there. The assertions of that case hold on both
// sides of the fix.

const TYPED = '  Fix the login  ';
const TYPED_SHOWN = 'Fix the login';
const FOLDER_PATH = 'C:\\work\\demo';

/**
 * The list, the launch and the header title in one page: loadProjects,
 * launchNewSession and showTerminalHeader (public/app.js) with the real running
 * check behind them, and the real showSession (public/terminal-manager.js) in
 * between, in the single-terminal view.
 *   page.rows       what main's get-projects answers: () => [folder, ...]
 *   page.running    the ids main reports as running
 *   page.titles     every text written to the header title, in order
 */
function bootTypedName() {
  const helpers = load(NAME_HELPERS, { file: 'public/utils.js' });
  const clock = fakeTimers();
  const header = fakeHeader();
  const openSessions = new Map();
  const page = {
    rows: () => [], running: [], titles: [], order: [], renames: [], warns: [], redraws: 0,
    header,
    headerId: { textContent: '' },
    headerBox: { style: { display: 'none' } },
    headerShell: { textContent: '', style: { display: '' } },
  };
  page.headerName = {
    text: '',
    get textContent() { return this.text; },
    set textContent(value) { page.titles.push(value); this.text = value; },
  };
  let app = null;
  let pane = null;

  app = load(RUNNING_CHECK + '\n' + LIST_AND_HEADER_TITLE, {
    file: APP,
    globals: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      console: { warn: (...args) => page.warns.push(args), error() {}, log() {} },
      crypto: { randomUUID: () => 'typed-' + (page.order.length + 1) },
      window: {
        api: {
          // Each call answers objects of its own, as two IPC replies do.
          getProjects: async () => JSON.parse(JSON.stringify(page.rows())),
          getProjectTree: async () => ({ projects: [] }),
          getActiveTerminals: async () => [],
          getActiveSessions: async () => [...page.running],
          renameSession: async (id, name) => { page.order.push('rename'); page.renames.push([id, name]); return { name }; },
          openTerminal: async (id) => { page.order.push('open'); page.running.push(id); return { ok: true }; },
          getEffectiveSettings: async () => ({ shellProfile: 'auto' }),
          getShellProfiles: async () => [],
        },
      },
      // The page's own state (declared above these blocks in public/app.js).
      cachedProjects: [],
      cachedAllProjects: [],
      cachedProjectTree: { projects: [] },
      cachedProjectTreeAll: { projects: [] },
      pendingSessions: new Map(),
      activePtyIds: new Set(),
      activeSessionId: null,
      gridViewActive: false,
      openSessions,
      attentionSessions: new Set(),
      responseReadySessions: new Set(),
      sessionBusyState: new Map(),
      gridCards: new Map(),
      // The page's elements.
      document: { querySelectorAll: () => [], querySelector: () => null },
      loadingStatus: { textContent: '', className: '', style: { display: 'none' } },
      terminalHeaderName: page.headerName,
      terminalHeaderId: page.headerId,
      terminalHeader: page.headerBox,
      terminalHeaderShell: page.headerShell,
      terminalHeaderStatus: header.status,
      terminalStopBtn: header.stop,
      // The rest of the page.
      encodeProjectPath: helpers.encodeProjectPath,
      cleanDisplayName: helpers.cleanDisplayName,
      updatePtyTitle: () => {},
      refreshSidebar: () => { page.redraws++; },
      renderDefaultStatus: () => {},
      createTerminalEntry: (session) => {
        const entry = { session, closed: false, terminal: { write() {}, focus() {} }, element: { classList: classes() } };
        openSessions.set(session.sessionId, entry);
        return entry;
      },
      showSession: (id) => pane.showSession(id),
    },
  });

  pane = load(SHOW_SESSION, {
    file: 'public/terminal-manager.js',
    globals: {
      window: { speech: null },
      openSessions,
      sessionMap: peek(app, 'sessionMap'),
      document: { querySelectorAll: () => [], querySelector: () => null },
      setActiveSession: (id) => { app.activeSessionId = id; },
      clearNotifications: () => {},
      gridViewActive: false,
      gridCards: new Map(),
      placeholder: { style: { display: '' } },
      hidePlanViewer: () => {},
      fitAndScroll: () => {},
      showTerminalHeader: (session) => app.showTerminalHeader(session),
    },
  });

  page.app = app;
  page.pane = pane;
  page.session = (id) => peek(app, 'sessionMap').get(id);
  /** Starts a session with the typed name and waits until the page is quiet. */
  page.launch = async (name = TYPED) => {
    const id = await app.launchNewSession({ projectPath: FOLDER_PATH }, null, { name });
    await settled();
    return id;
  };
  /** The next reload of the list. */
  page.reload = async () => { await app.loadProjects(); await settled(); };
  return page;
}

/** The row main answers once the session has a transcript. */
const realRow = (id, fields) => [{
  folder: 'C--work-demo',
  projectPath: FOLDER_PATH,
  sessions: [{
    sessionId: id, summary: 'please fix the login page', firstPrompt: 'please fix the login page',
    created: '2026-01-02T03:04:05.000Z', modified: '2026-01-02T03:05:05.000Z', messageCount: 2,
    projectPath: FOLDER_PATH, slug: null, aiTitle: null, name: null, starred: 0, archived: 0,
    ...fields,
  }],
}];

test('header-and-status (pin): what the header title shows for a session started with a typed name, at the first draw and after the next reload of the list', async (t) => {
  await t.test('at the first draw: the typed name, trimmed, with the session\'s id beside it', async () => {
    const page = bootTypedName();
    const id = await page.launch();
    assert.equal(id, 'typed-1');
    assert.equal(page.headerName.textContent, TYPED_SHOWN);
    assert.notEqual(page.headerName.textContent, 'New session');
    assert.equal(page.headerId.textContent, id);
    assert.equal(page.headerBox.style.display, '', 'the header is shown');
    assert.equal(page.app.activeSessionId, id, 'the new session is the one on screen');
    assert.ok(!page.titles.includes('New session'), 'the title was never New session on the way: ' + JSON.stringify(page.titles));
    // The record the title is drawn from, and what main was told.
    assert.equal(page.session(id).name, TYPED_SHOWN);
    assert.equal(page.session(id).summary, 'New session', 'the placeholder is the summary, behind the name');
    assert.deepEqual(page.renames, [[id, TYPED_SHOWN]]);
    assert.deepEqual(page.order, ['rename', 'open'], 'the name is sent before the terminal is asked for');
    assert.equal(page.warns.length, 0);
    t.diagnostic(`recorded, first draw: header title ${JSON.stringify(page.headerName.textContent)}; every write so far ${JSON.stringify(page.titles)}`);
  });

  await t.test('at the first draw the name is cleaned the way every title is (tags out, spaces collapsed)', async () => {
    const page = bootTypedName();
    await page.launch('Fix <b>the</b>   login');
    assert.equal(page.headerName.textContent, 'Fix the login');
  });

  await t.test('after the next reload, the session still without a transcript: the typed name', async () => {
    const page = bootTypedName();
    const id = await page.launch();
    page.rows = () => []; // main has no row for it yet
    await page.reload();

    assert.equal(page.headerName.textContent, TYPED_SHOWN);
    assert.ok(!page.titles.includes('New session'), JSON.stringify(page.titles));
    assert.equal(page.app.pendingSessions.has(id), true, 'still pending');
    assert.equal(page.session(id).name, TYPED_SHOWN);
    assert.equal(page.app.cachedAllProjects[0].sessions[0], page.session(id), 'the list holds the same record again');
    assert.ok(page.redraws >= 2, 'the sidebar was redrawn by the launch and by the reload');
    t.diagnostic(`recorded, reload while pending: header title ${JSON.stringify(page.headerName.textContent)}; every write ${JSON.stringify(page.titles)}`);
    // Selecting it again draws the same title.
    page.pane.showSession(id);
    assert.equal(page.headerName.textContent, TYPED_SHOWN);
  });

  await t.test('after the reload that brings its real row, with the name main saved: the typed name', async () => {
    const page = bootTypedName();
    const id = await page.launch();
    page.rows = () => realRow(id, { name: TYPED_SHOWN });
    await page.reload();

    assert.equal(page.headerName.textContent, TYPED_SHOWN);
    assert.ok(!page.titles.includes('New session'), JSON.stringify(page.titles));
    assert.equal(page.app.pendingSessions.has(id), false, 'no longer pending: main has the row');
    // The record took the row's fields and kept its name.
    assert.equal(page.session(id).summary, 'please fix the login page');
    assert.equal(page.session(id).messageCount, 2);
    assert.equal(page.session(id).name, TYPED_SHOWN);
    assert.deepEqual(headerState(page.header), HEADER_RUNNING, 'and the header status came from the running check of the reload');
    t.diagnostic(`recorded, reload with the real row: header title ${JSON.stringify(page.headerName.textContent)}; every write ${JSON.stringify(page.titles)}`);
    // A second reload, and selecting it again: the same title.
    await page.reload();
    assert.equal(page.headerName.textContent, TYPED_SHOWN);
    page.pane.showSession(id);
    assert.equal(page.headerName.textContent, TYPED_SHOWN);
    assert.ok(!page.titles.includes('New session'), JSON.stringify(page.titles));
  });

  // The ordinary state of a named session after its first turns: the row has
  // the name main saved AND the title Claude gave the conversation.
  await t.test('after a reload whose row carries the saved name AND an automatic title: still the typed name, the name comes first', async () => {
    const page = bootTypedName();
    const id = await page.launch();
    page.rows = () => realRow(id, { name: TYPED_SHOWN, aiTitle: 'Login page fix' });
    await page.reload();

    assert.equal(page.session(id).aiTitle, 'Login page fix', 'the record has the automatic title');
    assert.equal(page.session(id).name, TYPED_SHOWN, 'and the typed name');
    assert.equal(page.headerName.textContent, TYPED_SHOWN, 'the reload did not put the automatic title in the header');
    page.pane.showSession(id);
    assert.equal(page.headerName.textContent, TYPED_SHOWN, 'the next draw: the name comes before the automatic title');
    // A second reload and another draw: the same.
    await page.reload();
    page.pane.showSession(id);
    assert.equal(page.headerName.textContent, TYPED_SHOWN);
    assert.ok(!page.titles.includes('Login page fix'), 'the automatic title was never written: ' + JSON.stringify(page.titles));
    assert.ok(!page.titles.includes('New session'), JSON.stringify(page.titles));
    assert.ok(page.titles.every((title) => title === TYPED_SHOWN), 'every write of the title was the typed name: ' + JSON.stringify(page.titles));
    t.diagnostic(`recorded, reload with a named row that has an automatic title: header title ${JSON.stringify(page.headerName.textContent)}; every write ${JSON.stringify(page.titles)}`);
  });

  await t.test('a reload whose row carries no name: the record loses the name, and the next draw of the header shows the row\'s title', async () => {
    const page = bootTypedName();
    const id = await page.launch();
    page.rows = () => realRow(id, { name: null, aiTitle: 'Login page fix' });
    await page.reload();

    // Recorded, not asserted. Since the small fix "the header title follows
    // the row" the reload redraws it from the row: syncTerminalHeaderName.
    t.diagnostic(`recorded, reload with an unnamed row: header title ${JSON.stringify(page.headerName.textContent)} (the reload redraws it from the row: syncTerminalHeaderName); every write ${JSON.stringify(page.titles)}`);

    assert.equal(page.session(id).name, null, 'the record now says what the row says');
    assert.ok(!page.titles.includes('New session'), JSON.stringify(page.titles));
    page.pane.showSession(id);
    assert.equal(page.headerName.textContent, 'Login page fix', 'name, then the automatic title, then the summary');

    const plain = bootTypedName();
    const other = await plain.launch();
    plain.rows = () => realRow(other, { name: null, aiTitle: null });
    await plain.reload();
    plain.pane.showSession(other);
    assert.equal(plain.headerName.textContent, 'please fix the login page');
  });
});

test('header-and-status: the header reads "Did not stop" for a live session whose stop stalled or failed, and Running or Stopped otherwise', () => {
  const HEADER_DID_NOT_STOP = { cls: 'did-not-stop', text: 'Did not stop', stop: '' };
  const draw = (running, didNotStop) => {
    const header = fakeHeader();
    const ctx = load(HEADER_STATUS, { file: APP, globals: {
      activeSessionId: 'sess1', activePtyIds: new Set(running), didNotStopIds: new Set(didNotStop),
      terminalHeaderStatus: header.status, terminalStopBtn: header.stop, updatePtyTitle: () => {},
    } });
    header.stop.style.display = 'none';
    ctx.updateTerminalHeader();
    return headerState(header);
  };
  assert.deepEqual(draw(['sess1', 'other'], ['sess1']), HEADER_DID_NOT_STOP, 'the Stop button stays: Stop still works');
  assert.deepEqual(draw(['sess1', 'other'], ['other']), HEADER_RUNNING, 'another session did not stop');
  assert.deepEqual(draw(['sess1'], []), HEADER_RUNNING);
  assert.deepEqual(draw(['other'], ['sess1']), HEADER_STOPPED, 'it has ended: the status goes with the session');
  assert.deepEqual(draw([], []), HEADER_STOPPED);
});

test('header-and-status: the running check asks which sessions did not stop, replaces the set and redraws the header; a page or a main process without that call changes nothing', async (t) => {
  const withStops = (opts) => {
    const page = bootRunningCheck(opts);
    page.stops = async () => [];
    page.seen.stopAsks = 0;
    page.ctx.window.api.getStopStates = () => { page.seen.stopAsks++; return page.stops(); };
    page.ctx.didNotStopIds = new Set();
    return page;
  };

  await t.test('a stalled session on screen: Did not stop within one check, the rows unchanged; it goes when main no longer lists it and when the session ends', async () => {
    const page = withStops({ running: [], active: 'row-a' });
    const before = page.ctx.didNotStopIds;
    page.answer = async () => ['row-a', 'row-b'];
    page.stops = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.equal(page.seen.stopAsks, 1);
    assert.notEqual(page.ctx.didNotStopIds, before, 'a new Set, not the old one changed');
    assert.ok(isASet(page.ctx.didNotStopIds));
    assert.deepEqual([...page.ctx.didNotStopIds], ['row-a']);
    assert.deepEqual(headerState(page.header), { cls: 'did-not-stop', text: 'Did not stop', stop: '' });
    assert.equal(page.seen.ptyTitles, 2, 'the header is drawn by the running answer and once more by this one');
    assert.equal(dots(page).rows['row-a'], true, 'the row shows as running and keeps its Stop');
    page.stops = async () => [];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);
    page.stops = async () => ['row-a'];
    page.answer = async () => [];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(headerState(page.header), HEADER_STOPPED);
  });

  await t.test('the order: the running ids first, the stop states after the header was drawn, the re-arm last', async () => {
    const page = withStops({ running: [], active: 'row-a' });
    const order = [];
    page.answer = async () => { order.push('running'); return ['row-a']; };
    page.stops = async () => { order.push(`stops after "${page.header.status.textContent}", timers ${page.clock.timers.length}`); return []; };
    await page.ctx.pollActiveSessions();
    assert.deepEqual(order, ['running', 'stops after "Running", timers 0']);
    assert.deepEqual(armed(page).map((timer) => timer.ms), [3000]);
    assert.equal(armed(page)[0].fn, page.ctx.pollActiveSessions, 'what the timer runs is still the check itself');
  });

  await t.test('the stop-state call rejects, throws at once or answers no list: the set stays as it was and the check still re-arms', async () => {
    for (const stops of [() => Promise.reject(new Error("No handler registered for 'get-stop-states'")), () => { throw new Error('boom'); }, async () => 5]) {
      const page = withStops({ running: [], active: 'row-a' });
      const before = page.ctx.didNotStopIds;
      page.answer = async () => ['row-a'];
      page.stops = stops;
      assert.equal(await page.ctx.pollActiveSessions(), undefined, 'the check does not reject');
      assert.equal(page.ctx.didNotStopIds, before);
      assert.deepEqual(headerState(page.header), HEADER_RUNNING);
      assert.deepEqual(armed(page).map((timer) => timer.ms), [3000]);
      assert.equal(armed(page)[0].fn, page.ctx.pollActiveSessions);
    }
  });

  await t.test('the stop-state call answers nothing (undefined or null): the set becomes a new, empty one, the header reads Running and the check still re-arms', async () => {
    for (const nothing of [undefined, null]) {
      const page = withStops({ running: [], active: 'row-a' });
      page.answer = async () => ['row-a'];
      page.stops = async () => ['row-a'];
      await page.ctx.pollActiveSessions();
      const before = page.ctx.didNotStopIds;
      page.stops = async () => nothing;
      assert.equal(await page.ctx.pollActiveSessions(), undefined, 'the check does not reject');
      assert.notEqual(page.ctx.didNotStopIds, before, 'no answer is an answer: the set is replaced');
      assert.ok(isASet(page.ctx.didNotStopIds));
      assert.deepEqual([...page.ctx.didNotStopIds], []);
      assert.deepEqual(headerState(page.header), HEADER_RUNNING);
      assert.deepEqual(armed(page).map((timer) => timer.ms), [3000]);
    }
  });

  await t.test('a session whose stop stalled is re-keyed while it is on screen: Did not stop again under the new id after one check', async () => {
    const page = withStops({ running: [], active: 'row-a' });
    page.answer = async () => ['row-a'];
    page.stops = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(headerState(page.header), { cls: 'did-not-stop', text: 'Did not stop', stop: '' });
    // The re-key (a fork, a plan-accept, later a /clear): the page shows the session under its new id, and main lists it under that id.
    page.ctx.activeSessionId = 'row-new';
    page.answer = async () => ['row-new'];
    page.stops = async () => ['row-new'];
    await page.ctx.pollActiveSessions();
    assert.deepEqual(headerState(page.header), { cls: 'did-not-stop', text: 'Did not stop', stop: '' });
    assert.deepEqual([...page.ctx.didNotStopIds], ['row-new'], 'the old id went with the answer: the set is replaced, never added to');
  });

  await t.test('the running call rejects: the stop states are still asked', async () => {
    const page = withStops({ running: ['row-a'], active: 'row-a' });
    page.answer = () => Promise.reject(new Error('main did not answer'));
    page.stops = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.equal(page.seen.stopAsks, 1);
    assert.deepEqual(headerState(page.header), { cls: 'did-not-stop', text: 'Did not stop', stop: '' });
  });

  await t.test('a page without that call (an older preload): nothing is asked, the header is drawn once, no set is made', async () => {
    const page = bootRunningCheck({ running: [], active: 'row-a' });
    page.answer = async () => ['row-a'];
    await page.ctx.pollActiveSessions();
    assert.equal(page.seen.ptyTitles, 1);
    assert.equal(peek(page.ctx, 'typeof didNotStopIds'), 'undefined');
    assert.deepEqual(headerState(page.header), HEADER_RUNNING);
  });
});

test('header-and-status: style.css gives the "Did not stop" status two rules, its amber colour and an amber dot', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.equal(css.split('did-not-stop').length - 1, 2, 'two rules and nothing else: the text and the dot');
  assert.match(css, /#terminal-header-status\.did-not-stop\s*\{\s*color:\s*#ffd166;\s*\}/);
  assert.match(css, /#terminal-header-status\.did-not-stop::before\s*\{\s*background:\s*#ffd166;\s*\}/);
});

test('header-and-status: a reload of the list redraws the corner notice once, after the rows are in the session map; a page without the notice reloads as before', async () => {
  const page = bootTypedName();
  const seen = [];
  page.app.MainFaultNotice = { redraw: () => { seen.push(!!page.session('s1')); } };
  page.rows = () => realRow('s1', {});
  await page.reload();
  assert.deepEqual(seen, [true], 'one redraw for the load, with the row already in the session map');
  await page.reload();
  assert.deepEqual(seen, [true, true], 'and one for every later load');
  // Without the notice script, with one that has no redraw, or with a name that is no object: the load ends as before.
  for (const notice of [undefined, null, {}, { redraw: 'no function' }, 5]) {
    const plain = bootTypedName();
    if (notice !== undefined) plain.app.MainFaultNotice = notice;
    plain.rows = () => realRow('s1', {});
    await plain.reload();
    assert.equal(plain.session('s1').summary, 'please fix the login page', String(notice));
    assert.equal(plain.redraws, 1, 'the sidebar was drawn');
  }
  // The call stands once in the file, among the last statements of loadProjects.
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const CALL = "if (typeof MainFaultNotice !== 'undefined' && MainFaultNotice && typeof MainFaultNotice.redraw === 'function') MainFaultNotice.redraw();";
  assert.equal(app.split(CALL).length - 1, 1);
  assert.match(app, /refreshSidebar\(\{ resort, reason \}\);[^{}]*MainFaultNotice\.redraw\(\);[^{}]*\r?\n\}/, 'after the sidebar was drawn, before loadProjects ends');
});

// --- Small fixes, commit c (entries D2 and D3) -----------------------------------
//
// From this commit on loadProjects DOES write the header title, through
// syncTerminalHeaderName; the comment above pin 24 and its last printed line
// say so (corrected with this commit). No assertion of pin 24 changed and it
// still passes: with a typed name the row's title IS the typed name, so the
// sync has nothing to write.

/**
 * The running check with the REAL status bar text behind it.
 *   loaded    has the sidebar loaded once (the flag the check asks)
 *   running   the running set before the check
 *   all       the folders the status bar counts
 *   info      the status bar's info element, when the test wants its own
 */
function bootStatusCheck({ loaded = true, running = [], all = [], info } = {}) {
  const clock = fakeTimers();
  const header = fakeHeader();
  const bar = info || { textContent: '(not drawn yet)' };
  const page = { clock, header, bar, answer: async () => [] };
  page.ctx = load(RUNNING_CHECK + '\n' + STATUS_TEXT, {
    file: APP,
    globals: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      window: { api: { getActiveSessions: () => page.answer() } },
      activePtyIds: new Set(running),
      activeSessionId: 'row-a',
      document: { querySelectorAll: () => [] },
      attentionSessions: new Set(),
      responseReadySessions: new Set(),
      sessionBusyState: new Map(),
      gridCards: new Map(),
      terminalHeaderStatus: header.status,
      terminalStopBtn: header.stop,
      updatePtyTitle: () => {},
      cachedAllProjects: all,
      cachedProjectTreeAll: { projects: [] },
      statusBarInfo: bar,
    },
  });
  if (loaded) peek(page.ctx, 'projectsLoadedOnce = true');
  return page;
}

test('header-and-status: the status bar loses \'running\' after the check sees no sessions', async () => {
  const page = bootStatusCheck({ running: ['f0-s0'], all: folders(2) });
  page.bar.textContent = '1 running' + DOT + '2 sessions' + DOT + '1 folders';
  page.answer = async () => [];
  await page.ctx.pollActiveSessions();
  assert.equal(page.bar.textContent, '2 sessions' + DOT + '1 folders');

  // And it comes back with the next check that sees sessions.
  page.answer = async () => ['f0-s0', 'f0-s1'];
  await page.ctx.pollActiveSessions();
  assert.equal(page.bar.textContent, '2 running' + DOT + '2 sessions' + DOT + '1 folders');
});

test('header-and-status: a check before the first sidebar load leaves the status bar alone', async () => {
  const written = [];
  const info = new Proxy({ textContent: '(not drawn yet)' }, {
    set(target, key, value) { written.push(key); target[key] = value; return true; },
  });
  const page = bootStatusCheck({ loaded: false, running: [], all: [], info });
  page.answer = async () => ['row-a'];
  await page.ctx.pollActiveSessions();
  assert.deepEqual(written, [], 'nothing of the bar was written');
  assert.equal(info.textContent, '(not drawn yet)');
  assert.deepEqual(headerState(page.header), HEADER_RUNNING, 'the rest of the check ran');

  // The same page once the sidebar has loaded: the next check draws.
  peek(page.ctx, 'projectsLoadedOnce = true');
  await page.ctx.pollActiveSessions();
  assert.equal(info.textContent, '1 running' + DOT + '0 sessions' + DOT + '0 folders');
});

test('header-and-status: the first sidebar load switches the redraw on, and from then on every check redraws', async () => {
  const page = bootTypedName();
  let redraws = 0;
  page.app.renderDefaultStatus = () => { redraws++; };
  await page.app.pollActiveSessions();
  assert.equal(redraws, 0, 'a check before the first load does not draw');
  await page.reload();
  assert.equal(redraws, 1, 'the load draws once itself; the check inside that first load does not');
  await page.app.pollActiveSessions();
  assert.equal(redraws, 2, 'a check after the first load draws');
  await page.reload();
  assert.equal(redraws, 4, 'a later load: once from its check, once itself');
});

test('header-and-status: the check is re-armed even if the status bar throws', async () => {
  let tries = 0;
  const info = { get textContent() { return ''; }, set textContent(value) { tries++; throw new Error('the status bar broke'); } };
  const page = bootStatusCheck({ running: [], all: folders(1), info });
  page.answer = async () => ['row-a'];
  await assert.doesNotReject(page.ctx.pollActiveSessions());
  assert.equal(tries, 1, 'the bar was tried once');
  assert.deepEqual(headerState(page.header), HEADER_RUNNING, 'the header was drawn before the bar was tried');
  const timers = armed(page);
  assert.equal(timers.length, 1, 'the check is armed again');
  assert.equal(timers[0].fn, page.ctx.pollActiveSessions);
  assert.equal(timers[0].ms, 3000);
});

test('header-and-status: the header takes the row\'s automatic title after a sidebar reload', async () => {
  const page = bootTypedName();
  const id = await page.launch(null); // no typed name
  assert.equal(page.headerName.textContent, 'New session');
  page.rows = () => realRow(id, { aiTitle: 'Reply with ok' });
  await page.reload();
  assert.equal(page.headerName.textContent, 'Reply with ok');
  assert.deepEqual(page.titles, ['New session', 'Reply with ok']);
  await page.reload();
  assert.deepEqual(page.titles, ['New session', 'Reply with ok'], 'a title that did not change is not written again');

  // A row with no automatic title yet: its summary.
  const plain = bootTypedName();
  const other = await plain.launch(null);
  plain.rows = () => realRow(other, {});
  await plain.reload();
  assert.equal(plain.headerName.textContent, 'please fix the login page');
});

test('header-and-status: the header is left alone when no session is active', async () => {
  const page = bootTypedName();
  const id = await page.launch(null);
  // A task log takes the pane: it clears the active session and writes its own label.
  page.app.activeSessionId = null;
  page.headerName.textContent = 'npm test';
  page.titles.length = 0;

  page.app.syncTerminalHeaderName();
  page.rows = () => realRow(id, { aiTitle: 'Reply with ok' });
  await page.reload();
  for (const none of ['', undefined]) {
    page.app.activeSessionId = none;
    page.app.syncTerminalHeaderName();
  }
  assert.deepEqual(page.titles, [], 'nothing wrote the title');
  assert.equal(page.headerName.textContent, 'npm test', 'the task log keeps its label');
});

test('header-and-status: the header sync does nothing in grid view', async () => {
  const page = bootTypedName();
  const id = await page.launch(null);
  page.rows = () => realRow(id, { aiTitle: 'Reply with ok' });
  page.app.gridViewActive = true;
  page.titles.length = 0;
  await page.reload();
  page.app.syncTerminalHeaderName();
  assert.deepEqual(page.titles, [], 'in grid view the header belongs to the grid');
  assert.equal(page.headerName.textContent, 'New session');

  // Back in the single view the next sync writes it.
  page.app.gridViewActive = false;
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'Reply with ok');
});

test('header-and-status: the header sync reads the session on screen: its name first, the open terminal\'s own record when the list has none, and never an empty title', async () => {
  const page = bootTypedName();
  const first = await page.launch('First');
  const second = await page.launch('Second'); // the one on screen now
  assert.equal(page.app.activeSessionId, second);
  assert.equal(page.headerName.textContent, 'Second');
  page.titles.length = 0;

  // A rename of a row that is NOT on screen leaves the header alone.
  page.session(first).name = 'First, renamed';
  page.app.syncTerminalHeaderName();
  assert.deepEqual(page.titles, []);

  // A rename of the one on screen.
  page.session(second).name = 'Second, renamed';
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'Second, renamed');

  // The name taken off again: the automatic title (cleaned the way every title is), then the summary.
  Object.assign(page.session(second), { name: null, aiTitle: 'Auto <b>title</b>' });
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'Auto title');
  page.session(second).aiTitle = null;
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'New session', 'the summary of a session without a transcript');

  // Nothing to show: the header keeps what it has.
  page.titles.length = 0;
  for (const summary of ['', '<b></b>', undefined, null]) {
    page.session(second).summary = summary;
    page.app.syncTerminalHeaderName();
  }
  assert.deepEqual(page.titles, [], 'an empty title is never written');
  assert.equal(page.headerName.textContent, 'New session');

  // The list has no record under the id on screen: the open terminal's own record is read.
  const record = page.session(second);
  peek(page.app, 'sessionMap').delete(second);
  record.name = 'From the open terminal';
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'From the open terminal');

  // Neither has one: nothing is written and nothing throws.
  page.app.openSessions.delete(second);
  page.titles.length = 0;
  assert.doesNotThrow(() => page.app.syncTerminalHeaderName());
  assert.deepEqual(page.titles, []);
});

// The rename box (public/sidebar.js startRename, to the end of the file).
const RENAME_BOX = cut('public/sidebar.js', 'function startRename(summaryEl, session) {');

/**
 * startRename on a row, with a text box that can be typed into and left.
 *   sync   what the page has as syncTerminalHeaderName; leave it out for a page without one
 * Answers the box (`input.value = ...; await input.leave()`) and `order`: every
 * save and every sync, with the name the record had at that moment.
 */
function bootRenameBox(session, sync) {
  const order = [];
  const row = { shows: null };
  const element = () => {
    const heard = [];
    return {
      value: '', className: '', textContent: '', type: '',
      addEventListener: (type, fn) => { heard.push({ type, fn }); },
      removeEventListener: () => {},
      replaceWith: (other) => { row.shows = other; },
      focus() {}, select() {},
      leave: () => Promise.all(heard.filter((l) => l.type === 'blur').map((l) => l.fn({}))),
    };
  };
  const globals = {
    document: { createElement: element },
    window: { api: { renameSession: async (id, name) => { order.push(['saved', id, name]); return { name }; } } },
  };
  if (sync) globals.syncTerminalHeaderName = () => { order.push(['sync', session.name]); sync(); };
  const ctx = load(RENAME_BOX, { file: 'public/sidebar.js', globals });
  const summaryEl = element();
  row.shows = summaryEl;
  ctx.startRename(summaryEl, session);
  return { order, input: row.shows };
}

test('header-and-status: a rename updates the header', async () => {
  const session = { sessionId: 's1', name: null, aiTitle: 'Auto title', summary: 'first words' };
  let synced = 0;
  const box = bootRenameBox(session, () => { synced++; });
  box.input.value = 'My name';
  await box.input.leave();
  assert.deepEqual(box.order, [['saved', 's1', 'My name'], ['sync', 'My name']],
    'saved first, and the record already has the new name when the header is synced');
  assert.equal(synced, 1);

  // A box left as it was opened saves nothing and syncs nothing.
  const untouched = bootRenameBox({ ...session }, () => {});
  await untouched.input.leave();
  assert.deepEqual(untouched.order, []);

  // A name that is taken off: the header is synced too (it falls back to the automatic title).
  const named = { sessionId: 's2', name: 'Mine', aiTitle: 'Auto title', summary: 'first words' };
  const cleared = bootRenameBox(named, () => {});
  cleared.input.value = '   ';
  await cleared.input.leave();
  assert.deepEqual(cleared.order, [['saved', 's2', null], ['sync', null]]);

  // A page without the function (app.js not loaded): the rename is saved all the same.
  const alone = bootRenameBox({ sessionId: 's3', name: null, summary: 'x' });
  alone.input.value = 'Still saved';
  await assert.doesNotReject(alone.input.leave());
  assert.deepEqual(alone.order, [['saved', 's3', 'Still saved']]);
});

// The session-forked listener, cut by a prefix of its first line so the cut
// still works when the /clear work gives the listener more arguments.
const FORK_LISTENER = cut(APP, 'window.api.onSessionForked(', 'window.api.onProcessExited(');

test('header-and-status: the session-forked listener writes no header title itself; it moves the session and starts the reload', async () => {
  const titles = [];
  const order = [];
  let forked = null;
  const record = { sessionId: 'old-id', name: null, aiTitle: 'Auto title' };
  const rowEl = {
    classList: classes(),
    querySelector: (selector) => (selector === '.session-summary' ? { textContent: 'the text of the sidebar row' } : null),
  };
  const ctx = load(FORK_LISTENER, {
    file: APP,
    globals: {
      console: { warn() {}, error() {}, log() {} },
      window: { api: { onSessionForked: (cb) => { forked = cb; }, renameSession: async () => ({}) } },
      openSessions: new Map([['old-id', { session: record }]]),
      pendingSessions: new Map(),
      sessionMap: new Map([['old-id', record]]),
      activeSessionId: 'old-id',
      setActiveSession: (id) => { order.push('active ' + id); },
      rekeySessionMaps: () => {},
      terminalHeaderId: { textContent: '' },
      terminalHeaderName: { get textContent() { return ''; }, set textContent(value) { titles.push(value); } },
      document: { querySelector: () => rowEl, querySelectorAll: () => [] },
      loadProjects: async () => { order.push('reload'); },
      pollActiveSessions: () => {},
    },
  });
  forked('old-id', 'new-id');
  await settled();
  assert.deepEqual(order, ['active new-id', 'reload']);
  assert.equal(ctx.terminalHeaderId.textContent, 'new-id', 'the id in the header is still the listener\'s to write');
  assert.equal(rowEl.classList.contains('active'), true, 'the row is still marked as the one on screen');
  assert.deepEqual(titles, [], 'the title comes from syncTerminalHeaderName at the end of the reload, not from here');
});

test('header-and-status: the header title is written only by showTerminalHeader, the task log and syncTerminalHeaderName; the write in the session-detected listener is the one allowed by name', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('../test-support/source-cut');
  const WRITE = /terminalHeaderName\s*\.\s*textContent\s*=(?!=)/g;
  const writesIn = (text) => (text.match(WRITE) || []).length;

  // Every script under public/, folders included.
  const publicDir = path.join(ROOT, 'public');
  const writers = {};
  let lookups = 0;
  for (const name of fs.readdirSync(publicDir, { recursive: true })) {
    if (!String(name).endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(publicDir, String(name)), 'utf8');
    if (writesIn(text)) writers[String(name).split(path.sep).join('/')] = writesIn(text);
    lookups += text.split('terminal-header-name').length - 1;
  }
  assert.deepEqual(writers, { 'app.js': 3, 'task-runner.js': 1 });
  assert.equal(lookups, 1, 'one script looks the element up (app.js), so it is written under no other name');

  // app.js: the first draw, the sync, and the listener nothing sends to.
  assert.equal(writesIn(cut(APP, 'async function showTerminalHeader(session) {', 'function syncTerminalHeaderName() {')), 1, 'showTerminalHeader');
  assert.equal(writesIn(cut(APP, 'function syncTerminalHeaderName() {', '// Every call into the task runner from this file and from sidebar.js is')), 1, 'syncTerminalHeaderName');
  const detected = cut(APP, 'window.api.onSessionDetected(', 'window.api.onSessionForked(');
  assert.equal(writesIn(detected), 1, 'the session-detected listener');
  assert.ok(detected.includes("terminalHeaderName.textContent = 'New session';"), 'its line is as it was: nothing sends to this listener');
  assert.equal(writesIn(FORK_LISTENER), 0, 'the session-forked listener');

  // The task log: its own label, in showTaskLog.
  const taskLog = cut('public/task-runner.js', 'async function showTaskLog(projectPath, label) {');
  assert.equal(writesIn(taskLog), 1, 'showTaskLog');
  // And it clears the active session BEFORE it writes its label. The sync knows
  // "a task log has the pane" only as "no session is active": this is that link.
  const cleared = taskLog.indexOf('setActiveSession(null);');
  const labelled = taskLog.indexOf('terminalHeaderName.textContent = label;');
  assert.ok(cleared !== -1, 'showTaskLog clears the active session');
  assert.ok(labelled !== -1, 'showTaskLog writes its label');
  assert.ok(cleared < labelled, 'the active session is cleared before the label is written');
});

// --- Whole-page cases: the real listener, the real reload and the real sync together ---

/**
 * The real session-forked listener on a page of bootTypedName. It gets the
 * page's own maps and header elements, and its reload and its running check are
 * the page's. Its globals are the ones the listener test above gives, and no more.
 *   rowEl   what the listener's own lookup of the sidebar row finds
 * Answers what main's event calls: fork(oldId, newId).
 */
function bootForkOn(page, rowEl) {
  let forked = null;
  const ctx = load(FORK_LISTENER, {
    file: APP,
    globals: {
      console: { warn() {}, error() {}, log() {} },
      window: { api: {
        onSessionForked: (cb) => { forked = cb; },
        renameSession: async (id, name) => { page.renames.push([id, name]); return { name }; },
      } },
      openSessions: page.app.openSessions,
      pendingSessions: page.app.pendingSessions,
      sessionMap: peek(page.app, 'sessionMap'),
      activeSessionId: null, // set from the page at the moment of the event, below
      setActiveSession: (id) => { page.app.activeSessionId = id; },
      rekeySessionMaps: () => {},
      terminalHeaderId: page.headerId,
      terminalHeaderName: page.headerName,
      document: { querySelector: () => rowEl, querySelectorAll: () => [] },
      loadProjects: () => page.app.loadProjects(),
      pollActiveSessions: () => page.app.pollActiveSessions(),
    },
  });
  return (oldId, newId) => {
    ctx.activeSessionId = page.app.activeSessionId;
    forked(oldId, newId);
  };
}

test('header-and-status: a fork or a plan-accept of the session on screen, through the real listener and the real reload: the title is the record\'s own under the new id, never the text of the sidebar row', async () => {
  const rowEl = {
    classList: classes(),
    querySelector: (selector) => (selector === '.session-summary' ? { textContent: 'the text of the sidebar row' } : null),
  };

  // A named session. Main's list has no row yet for the new id.
  const page = bootTypedName();
  const oldId = await page.launch();
  const fork = bootForkOn(page, rowEl);
  page.titles.length = 0;
  page.rows = () => [];
  fork(oldId, 'forked-1');
  await settled();
  assert.equal(page.app.activeSessionId, 'forked-1');
  assert.equal(page.headerId.textContent, 'forked-1', 'the id line shows the new id');
  assert.equal(page.session(oldId), undefined, 'the record left the old id');
  assert.equal(page.session('forked-1').name, TYPED_SHOWN, 'and is listed under the new one, with its name');
  assert.deepEqual(page.renames[page.renames.length - 1], ['forked-1', TYPED_SHOWN], 'the name was saved under the new id');
  assert.deepEqual(page.titles, [], 'the header already shows the record\'s own title: nothing is written, the row\'s text least of all');
  assert.equal(page.headerName.textContent, TYPED_SHOWN);

  // The real row arrives, with the saved name and an automatic title: the name comes first.
  page.rows = () => realRow('forked-1', { name: TYPED_SHOWN, aiTitle: 'Login page fix' });
  await page.reload();
  assert.deepEqual(page.titles, []);
  assert.equal(page.headerName.textContent, TYPED_SHOWN);

  // A session without a name (a plan-accept sends the same two arguments).
  const plain = bootTypedName();
  const first = await plain.launch(null);
  const accept = bootForkOn(plain, rowEl);
  plain.titles.length = 0;
  plain.rows = () => [];
  accept(first, 'accepted-1');
  await settled();
  assert.equal(plain.headerId.textContent, 'accepted-1');
  assert.deepEqual(plain.titles, [], 'no row yet: the header keeps the record\'s summary');
  assert.equal(plain.headerName.textContent, 'New session');
  // Its row arrives with the automatic title: written once, by the reload.
  plain.rows = () => realRow('accepted-1', { aiTitle: 'Reply with ok' });
  await plain.reload();
  await plain.reload();
  assert.deepEqual(plain.titles, ['Reply with ok']);
});

test('header-and-status: a window reload with a restored session: nothing is drawn before the first load, and that load writes the row\'s title', async () => {
  const page = bootTypedName();
  let bar = 0;
  page.app.renderDefaultStatus = () => { bar++; };
  // The script starts with the id the window kept (sessionStorage). No terminal is open yet and no list is loaded.
  page.app.activeSessionId = 'restored-1';
  await page.app.pollActiveSessions();
  assert.equal(bar, 0, 'a check before the first load leaves the status bar alone');
  assert.doesNotThrow(() => page.app.syncTerminalHeaderName(), 'neither the list nor an open terminal has the id yet');
  assert.deepEqual(page.titles, [], 'and nothing is written');

  page.rows = () => realRow('restored-1', { aiTitle: 'Restored title' });
  await page.reload();
  assert.equal(bar, 1, 'the first load draws the status bar, once');
  assert.deepEqual(page.titles, ['Restored title'], 'the row\'s title, written once');
  assert.equal(page.headerBox.style.display, 'none', 'the sync shows nothing: showing the header is the first draw\'s');

  // An id the list never brings (its transcript is gone): nothing is written and nothing throws.
  const gone = bootTypedName();
  gone.app.activeSessionId = 'gone-1';
  await gone.reload();
  assert.deepEqual(gone.titles, []);
});

test('header-and-status: a plain terminal on screen: the header follows its rename and the next reload, and reads Terminal without a name', async () => {
  const page = bootTypedName();
  // The row main builds for a live plain terminal (session-cache.js): summary 'Terminal', type 'terminal'.
  const terminalRow = (fields) => realRow('term-1', { summary: 'Terminal', firstPrompt: '', messageCount: 0, type: 'terminal', ...fields });
  page.rows = () => terminalRow({});
  await page.reload();
  const record = page.session('term-1');
  page.app.createTerminalEntry(record);
  page.pane.showSession('term-1');
  await settled();
  assert.equal(page.headerName.textContent, 'Terminal');

  // Renamed in the sidebar: the rename box sets the record's name and calls the sync.
  record.name = 'Build shell';
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'Build shell');

  // The reload after it: main's row carries the saved name (small fixes, commit a).
  page.rows = () => terminalRow({ name: 'Build shell' });
  await page.reload();
  assert.equal(page.session('term-1'), record, 'the list holds the same record');
  assert.equal(record.name, 'Build shell');
  assert.equal(page.headerName.textContent, 'Build shell');

  // The name taken off again: the header reads what the row reads.
  page.rows = () => terminalRow({});
  await page.reload();
  assert.equal(page.headerName.textContent, 'Terminal');
  assert.deepEqual(page.titles, ['Terminal', 'Build shell', 'Terminal']);
});

test('header-and-status: a rename saved while a reload is on its way: header and row agree when that reload ends, and the next reload brings the name', async () => {
  const page = bootTypedName();
  const id = await page.launch(null);
  page.rows = () => realRow(id, { aiTitle: 'Old title' });
  await page.reload();
  assert.equal(page.headerName.textContent, 'Old title');

  // A reload starts: its rows are read now, before the rename is saved.
  const onItsWay = page.app.loadProjects();
  page.rows = () => realRow(id, { aiTitle: 'Old title', name: 'New name' }); // what main answers from now on
  page.session(id).name = 'New name';
  page.app.syncTerminalHeaderName();
  assert.equal(page.headerName.textContent, 'New name');

  await onItsWay;
  await settled();
  assert.equal(page.session(id).name, null, 'the record took the fields of the rows that were read before the save');
  assert.equal(page.headerName.textContent, 'Old title', 'and the header says what the row says, never a title the row does not show');

  await page.reload();
  assert.equal(page.session(id).name, 'New name');
  assert.equal(page.headerName.textContent, 'New name');
});
