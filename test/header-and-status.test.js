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
});

// --- Pin 24 -----------------------------------------------------------------
//
// What is recorded here (2026-10-06, public/app.js at 7480022):
//   - First draw: the header title is the typed name (trimmed, and cleaned the
//     way every title is). It is never 'New session'.
//   - After the next reload of the list: still the typed name, while the
//     session is pending and after its real row has arrived with the name main
//     saved. loadProjects does not write the header title at all today; the
//     title is written by showTerminalHeader, which only showSession calls.
//   - So the fault "a session started with a typed name flips to New session"
//     does NOT show on this path today.
// One more case is recorded but its header text is only printed, not asserted:
// a reload whose row carries NO name (the save never reached main). Today the
// header keeps the typed name because nothing redraws it, while the session's
// own record loses the name; a header that follows the row would show the row's
// title there. The assertions of that case hold on both sides of such a fix.

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

    // Recorded, not asserted: a fix that makes the title follow the row
    // changes this text on purpose. Today nothing redraws it.
    t.diagnostic(`recorded, reload with an unnamed row: header title ${JSON.stringify(page.headerName.textContent)} (today the reload does not redraw it); every write ${JSON.stringify(page.titles)}`);

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
