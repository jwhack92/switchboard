const test = require('node:test');
const assert = require('node:assert/strict');
const { cut, load } = require('../test-support/source-cut');
const fs = require('node:fs');
const path = require('node:path');

// What the window does with the answer of a Stop.
//
// Since the crash guard's page commit seven places in the window go through
// stopSessionPlain and stopSessionForArchive of public/app.js, the only code
// that makes the stop call:
//   public/app.js            confirmAndStopSession (the Stop button and its box)
//   public/sidebar.js        four Archive handlers, bound by rebindSidebarEvents
//   public/projects-view.js  toggleArchiveSession, and stopRunningWork ("stop
//                            all work in a project")
// Each block is cut out of the file that ships (test-support/source-cut.js)
// and run against fakes. No line numbers: the markers are a function's first
// line or a comment line.
//
// The first test is a pin that held on both sides of that commit. The second
// and third were pins of the behaviour before it and were rewritten by it. The
// tests after them were written with it.

/** What a promise rejected with, or null when it resolved. */
async function rejection(promise) {
  try { await promise; } catch (e) { return e; }
  return null;
}

// --- Pin 15: the Stop button, after its box ---------------------------------
//
// The same two markers as STOP_FLOW in test/in-page-dialogs.test.js, so the
// two files cut the same text. The design puts the two stop helpers of the fix
// between these markers.
const STOP_FLOW = cut('public/app.js', 'async function confirmAndStopSession(sessionId) {', '// --- Terminal header controls ---');

const ANSWERS_THAT_MEAN_STOPPED = [
  ['ok', () => ({ ok: true })],
  ["'not running'", () => ({ ok: false, error: 'not running' })],
];

/**
 * The Stop flow in a page of its own.
 *   yes        what the box answers
 *   answer     what main answers the stop call
 *   grid       the grid view is on
 *   onScreen   the session in the single pane
 * openSessions and sessionMap are not read by today's code. They are here for
 * the fix, which is designed to hold the open session's record across the box
 * (its shape is the one the re-key listener in public/app.js rewrites:
 * entry.session.sessionId).
 *
 * Main answers a turn later, as over IPC. Just before it answers, the fake
 * records what the page had done by then (seen.atAnswer); every redraw of the
 * sidebar records what it could see (seen.atRedraw). The sidebar draws the
 * running rows from the running set and the selected row from the session on
 * screen (public/sidebar.js), so a redraw that comes too early paints a
 * stopped session as running.
 */
function bootStop({ yes = true, answer = { ok: true }, grid = false, onScreen = 'sess1' } = {}) {
  const seen = { asked: [], stops: [], shown: [], redraws: 0, inSetAtAsk: null, inSetAtStop: null, atAnswer: null, atRedraw: [] };
  const activePtyIds = new Set(['sess1', 'other']);
  const terminalHeader = { style: { display: '' } };
  const placeholder = { style: { display: 'none' } };
  const entry = { session: { sessionId: 'sess1' } };
  const ctx = load(STOP_FLOW, {
    file: 'public/app.js',
    globals: {
      confirmDialog: async (message) => {
        seen.asked.push(message);
        seen.inSetAtAsk = activePtyIds.has('sess1');
        return yes;
      },
      window: {
        api: {
          stopSession: (...args) => new Promise((resolve) => {
            seen.stops.push(args);
            seen.inSetAtStop = activePtyIds.has('sess1');
            setImmediate(() => {
              seen.atAnswer = { inSet: activePtyIds.has('sess1'), shown: seen.shown.slice(), redraws: seen.redraws };
              resolve(answer);
            });
          }),
        },
      },
      activePtyIds,
      gridViewActive: grid,
      activeSessionId: onScreen,
      setActiveSession: (value) => { seen.shown.push(value); },
      terminalHeader,
      placeholder,
      refreshSidebar: () => { seen.redraws++; seen.atRedraw.push({ inSet: activePtyIds.has('sess1'), shown: seen.shown.slice() }); },
      openSessions: new Map([['sess1', entry]]),
      sessionMap: new Map([['sess1', entry.session]]),
    },
  });
  return { ctx, seen, activePtyIds, terminalHeader, placeholder };
}

/** The single pane was emptied: no session shown, header hidden, placeholder back. */
function paneState(page) {
  return { shown: page.seen.shown, header: page.terminalHeader.style.display, placeholder: page.placeholder.style.display };
}
const PANE_CLEARED = { shown: [null], header: 'none', placeholder: '' };
const PANE_UNTOUCHED = { shown: [], header: '', placeholder: 'none' };

/**
 * The two stop helpers alone. replies: what main answers, one function per call,
 * in order (a function that throws rejects the call); a call with no reply left is
 * answered with nothing. calls: every stop call as its arguments.
 *   api   window.api, when the test wants one without the stop call
 */
function bootHelpers(replies, api) {
  const calls = [];
  const stopSession = async (...args) => {
    calls.push(args.map((arg) => (arg && typeof arg === 'object' ? { ...arg } : arg)));
    return replies.length ? replies.shift()() : undefined;
  };
  const ctx = load(STOP_FLOW, { file: 'public/app.js', globals: { window: { api: api || { stopSession } } } });
  return { ctx, calls };
}

/**
 * The order of a Stop that main answered, whichever session is on screen:
 * the stop went out for the session that was asked for; the page changed
 * nothing before main answered; the one redraw of the sidebar came last, after
 * the id had left the running set and after the pane was dealt with.
 *   pane   PANE_CLEARED or PANE_UNTOUCHED, what this case does to the pane
 */
function assertStopOrder(page, pane) {
  // The first argument only: the fix lets stopSession take a second one.
  assert.deepEqual(page.seen.stops.map((args) => args[0]), ['sess1'], 'one stop call, for the session asked for and not for the one on screen');
  assert.deepEqual(page.seen.atAnswer, { inSet: true, shown: [], redraws: 0 }, 'before main answered the id was still in the running set, the pane was as it was and nothing was redrawn');
  assert.deepEqual(page.seen.atRedraw, [{ inSet: false, shown: pane.shown }], 'the one redraw comes last: the id has left the running set and the pane is already dealt with');
}

test("stop answer (pin): after a yes the id leaves the running set, the pane clears when it is the one on screen and the grid is off, and the sidebar redraws; 'not running' is treated like ok", async (t) => {
  for (const [said, answer] of ANSWERS_THAT_MEAN_STOPPED) {
    await t.test(`main answers ${said}: the id leaves the running set after the answer, and the sidebar redraws once`, async () => {
      const page = bootStop({ answer: answer() });
      await page.ctx.confirmAndStopSession('sess1');
      assert.equal(page.seen.asked.length, 1, 'one box');
      assert.equal(page.seen.inSetAtAsk, true, 'nothing has changed while the box is open');
      // The first argument only: the fix lets stopSession take a second one.
      assert.deepEqual(page.seen.stops.map((args) => args[0]), ['sess1'], 'one stop call, for this id');
      assert.equal(page.seen.inSetAtStop, true, 'the id is still in the running set while the stop call is out');
      assert.equal(page.activePtyIds.has('sess1'), false, 'the id left the running set');
      assert.equal(page.activePtyIds.has('other'), true, 'no other id left it');
      assert.equal(page.seen.redraws, 1, 'the sidebar is redrawn once');
      assertStopOrder(page, PANE_CLEARED);
    });

    await t.test(`main answers ${said}: the pane clears when the session is the one on screen and the grid is off`, async () => {
      const page = bootStop({ answer: answer(), grid: false, onScreen: 'sess1' });
      await page.ctx.confirmAndStopSession('sess1');
      assert.deepEqual(paneState(page), PANE_CLEARED);
      assertStopOrder(page, PANE_CLEARED);
    });

    await t.test(`main answers ${said}: the pane is left alone while the grid is on`, async () => {
      const page = bootStop({ answer: answer(), grid: true, onScreen: 'sess1' });
      await page.ctx.confirmAndStopSession('sess1');
      assert.deepEqual(paneState(page), PANE_UNTOUCHED);
      assert.equal(page.activePtyIds.has('sess1'), false);
      assert.equal(page.seen.redraws, 1);
      assertStopOrder(page, PANE_UNTOUCHED);
    });

    await t.test(`main answers ${said}: the pane is left alone when another session is on screen`, async () => {
      const page = bootStop({ answer: answer(), grid: false, onScreen: 'other' });
      await page.ctx.confirmAndStopSession('sess1');
      assert.deepEqual(paneState(page), PANE_UNTOUCHED);
      assert.equal(page.activePtyIds.has('sess1'), false);
      assert.equal(page.activePtyIds.has('other'), true, 'the session on screen stays in the running set');
      assert.equal(page.seen.redraws, 1);
      assertStopOrder(page, PANE_UNTOUCHED);
    });

    await t.test(`main answers ${said}: with the grid on and another session on screen, the stop is for the card asked for and the pane is left alone`, async () => {
      // In the grid every card has a Stop button (public/grid-view.js), whichever card has the focus.
      const page = bootStop({ answer: answer(), grid: true, onScreen: 'other' });
      await page.ctx.confirmAndStopSession('sess1');
      assert.deepEqual(paneState(page), PANE_UNTOUCHED);
      assert.equal(page.activePtyIds.has('sess1'), false, 'the card that was asked for left the running set');
      assert.equal(page.activePtyIds.has('other'), true, 'the session with the focus stays in it');
      assert.equal(page.seen.redraws, 1);
      assertStopOrder(page, PANE_UNTOUCHED);
    });
  }

  await t.test('without a yes nothing is stopped, cleared or redrawn', async () => {
    const page = bootStop({ yes: false });
    await page.ctx.confirmAndStopSession('sess1');
    assert.equal(page.seen.asked.length, 1);
    assert.deepEqual(page.seen.stops, []);
    assert.equal(page.activePtyIds.has('sess1'), true);
    assert.deepEqual(paneState(page), PANE_UNTOUCHED);
    assert.equal(page.seen.redraws, 0);
    assert.equal(page.seen.atAnswer, null, 'main was never asked');
    assert.deepEqual(page.seen.atRedraw, []);
  });
});

// --- Pin 16: the five Archive paths -----------------------------------------
//
// Four of them are click handlers that rebindSidebarEvents puts on buttons of
// the sidebar, so the whole function is cut (with archiveQuestion above it,
// which two of the handlers call) and run against a page that answers only the
// selectors this test put in it. The fifth is a function of the Projects tab.
const SIDEBAR_ARCHIVE = cut('public/sidebar.js', 'function archiveQuestion(sessions, lead) {', 'function buildSessionItem(session) {');
const PROJECTS_ARCHIVE = cut('public/projects-view.js', 'async function toggleArchiveSession(session) {', '/** The J row:');

/**
 * What main can answer a stop, and what the two stop helpers of public/app.js make of it:
 *   stopped      stopSessionPlain: the session counts as stopped
 *   mayArchive   stopSessionForArchive: the session may be archived
 * 'ok' alone is a main process that does not wait for the end (today's).
 */
const STOP_ANSWERS = [
  ['ok', () => ({ ok: true }), { stopped: true, mayArchive: true }],
  ['ok and ended', () => ({ ok: true, ended: true }), { stopped: true, mayArchive: true }],
  ['ok and not ended', () => ({ ok: true, ended: false }), { stopped: true, mayArchive: false }],
  ["'not running'", () => ({ ok: false, error: 'not running' }), { stopped: true, mayArchive: true }],
  ["'stop failed'", () => ({ ok: false, error: 'stop failed' }), { stopped: false, mayArchive: false }],
  ['an error the page does not know', () => ({ ok: false, error: 'busy' }), { stopped: false, mayArchive: false }],
  ['nothing', () => undefined, { stopped: false, mayArchive: false }],
  ['null', () => null, { stopped: false, mayArchive: false }],
];

/** Five sessions in list order: two running, two not, one archived already. */
function fiveSessions() {
  return ['run1', 'idle1', 'done1', 'run2', 'idle2'].map((sessionId) => ({ sessionId, archived: sessionId === 'done1' ? 1 : 0 }));
}

/**
 * What every Archive path reaches, and one log of what it did, in order:
 *   'ask'                 the box
 *   'stop <id>'           window.api.stopSession
 *   'archive <id> <0|1>'  window.api.archiveSession, with ' (still in the
 *                         running set)' when the id had not left activePtyIds
 *   'poll', 'reload'      pollActiveSessions, loadProjects
 *   'forget <id>'         forgetTerminalHistory (Projects tab only)
 * stop(id) is what main answers; it may throw, which rejects the call.
 * archive(id, value) is what main answers the archive call; it may throw too.
 */
function archiveWorld({ running = ['run1', 'run2'], stop = () => ({ ok: true }), archive = () => undefined, yes = true } = {}) {
  const log = [];
  const stopCalls = [];
  const activePtyIds = new Set(running);
  const globals = {
    activePtyIds,
    confirmDialog: async () => { log.push('ask'); return yes; },
    window: {
      api: {
        stopSession: async (...args) => {
          stopCalls.push(args);
          log.push(`stop ${args[0]}`);
          return stop(args[0]);
        },
        archiveSession: async (id, value) => {
          log.push(`archive ${id} ${value}${activePtyIds.has(id) ? ' (still in the running set)' : ''}`);
          return archive(id, value);
        },
      },
    },
    pollActiveSessions: () => { log.push('poll'); },
    loadProjects: () => { log.push('reload'); },
    console: { calls: [], error(...args) { this.calls.push(args); } },
  };
  // The real helper, cut out of public/app.js, on this world's window; undefined until the helper exists.
  globals.stopSessionForArchive = load(STOP_FLOW, { file: 'public/app.js', globals: { window: globals.window } }).stopSessionForArchive;
  return { log, stopCalls, activePtyIds, globals };
}

/** An element that answers only the selectors a test put in it. */
function element(one = {}, all = {}, extra = {}) {
  return {
    querySelector: (selector) => (Object.hasOwn(one, selector) ? one[selector] : null),
    querySelectorAll: (selector) => (Object.hasOwn(all, selector) ? all[selector] : []),
    ...extra,
  };
}

/** The sessions of the two lists a click does not go to: one running and one idle in each. */
const OUTSIDE = ['x-run', 'x-idle', 'y-run', 'y-idle'];
const LISTS = ['folder', 'group', 'older'];

/**
 * The sidebar with three lists that hold DIFFERENT sessions: one folder
 * ("tools", whose sessions come from the project), one slug group and one
 * "older" list (theirs come from the rows inside them).
 *   list   the one that holds the five sessions: 'folder' (default), 'group'
 *          or 'older'
 * The two other lists hold x-run and x-idle, and y-run and y-idle. The page
 * knows all four, none is archived, and the two -run ones are running, so a
 * handler that reaches past its own list shows in the log as a stop or an
 * archive of one of them. The group and the older list also hold a row
 * ("ghost-...") whose session the page does not know. Every row is in the
 * sidebar and has an archive button of its own.
 */
function bootSidebar({ list = 'folder', ...options } = {}) {
  const world = archiveWorld(options);
  world.activePtyIds.add('x-run').add('y-run');
  const sessions = fiveSessions();
  const outside = OUTSIDE.map((sessionId) => ({ sessionId, archived: 0 }));
  const sessionMap = new Map([...sessions, ...outside].map((session) => [session.sessionId, session]));
  const [second, third] = LISTS.filter((name) => name !== list);
  const held = { [list]: sessions, [second]: outside.slice(0, 2), [third]: outside.slice(2) };

  const rowButtons = {};
  const row = (sessionId) => {
    rowButtons[sessionId] = {};
    return element({ '.session-archive-btn': rowButtons[sessionId] }, {}, { dataset: { sessionId } });
  };
  // The rows of a list in list order, with the unknown row second.
  const rowsOf = (name) => {
    const ids = held[name].map((session) => session.sessionId);
    ids.splice(1, 0, `ghost-${name}`);
    return ids.map(row);
  };
  const folderRows = held.folder.map((session) => row(session.sessionId));
  const groupRows = rowsOf('group');
  const olderRows = rowsOf('older');
  const buttons = { folder: {}, group: {}, older: {} };

  const folderHeader = element({ '.project-archive-btn': buttons.folder });
  const groupHeader = element({ '.slug-group-archive-btn': buttons.group }, {}, {
    parentElement: element({}, { '.session-item': groupRows }),
  });
  const olderList = element({}, { '.session-item': olderRows, '.session-item:not(.archived-item)': olderRows }, {
    classList: { contains: (name) => name === 'sessions-older' },
    style: {},
  });
  const moreToggle = element({ '.sessions-older-archive-btn': buttons.older }, {}, { nextElementSibling: olderList });
  const sidebarContent = element({}, {
    '.slug-group-header': [groupHeader],
    '.sessions-more-toggle': [moreToggle],
    '.session-item': [...folderRows, ...groupRows, ...olderRows],
  });

  const ctx = load(SIDEBAR_ARCHIVE, {
    file: 'public/sidebar.js',
    globals: {
      ...world.globals,
      sessionMap,
      sidebarContent,
      activeSessionId: null,
      document: { getElementById: (id) => (id === 'ph-tools' ? folderHeader : null) },
      folderId: () => 'tools',
      shortProjectPath: () => 'tools',
    },
  });
  ctx.rebindSidebarEvents([{ projectPath: 'C:/work/tools', sessions: held.folder }]);

  const click = (button, what) => {
    assert.equal(typeof button.onclick, 'function', `${what} got no click handler`);
    return button.onclick({ stopPropagation() {} });
  };
  return { ...world, session: (id) => sessionMap.get(id), buttons, rowButtons, click };
}

/** The Projects tab's archive function with the five sessions. */
function bootProjectsArchive(options) {
  const world = archiveWorld(options);
  const sessions = new Map(fiveSessions().map((session) => [session.sessionId, session]));
  const ctx = load(PROJECTS_ARCHIVE, {
    file: 'public/projects-view.js',
    globals: { ...world.globals, forgetTerminalHistory: (id) => { world.log.push(`forget ${id}`); } },
  });
  return { ...world, session: (id) => sessions.get(id), toggle: (id) => ctx.toggleArchiveSession(sessions.get(id)) };
}

/**
 * The three paths that archive a list. asks: the path opens a box first.
 * list: which of the three lists holds the five sessions, the one clicked.
 */
const LIST_PATHS = [
  { name: "the folder's 'Archive all'", asks: true, list: 'folder', run: (page) => page.click(page.buttons.folder, 'the folder archive button') },
  { name: "a group's archive button", asks: false, list: 'group', run: (page) => page.click(page.buttons.group, 'the group archive button') },
  { name: "'Archive all older'", asks: true, list: 'older', run: (page) => page.click(page.buttons.older, 'the older-sessions archive button') },
];

/**
 * The two paths that archive one session. They poll right after the stop, not
 * at the end. after: what the path does between the archive call and the reload.
 */
const ONE_PATHS = [
  { name: "a row's archive button", boot: bootSidebar, run: (page, id) => page.click(page.rowButtons[id], `the archive button of ${id}`), after: () => [] },
  { name: 'archive on the Projects tab', boot: bootProjectsArchive, run: (page, id) => page.toggle(id), after: (id) => [`forget ${id}`] },
];

const archivedMarks = (page) => ['run1', 'idle1', 'done1', 'run2', 'idle2'].map((id) => `${id}=${page.session(id).archived}`).join(' ');

/**
 * The sessions of the two lists that were not clicked are as they were: not
 * archived, and the running ones still running. (That none of them was stopped
 * or sent to main for archiving is in the log, which is compared whole.)
 */
function assertOtherListsUntouched(page) {
  assert.equal(OUTSIDE.map((id) => `${id}=${page.session(id).archived}`).join(' '), 'x-run=0 x-idle=0 y-run=0 y-idle=0', 'no session of another list is archived');
  assert.deepEqual(OUTSIDE.filter((id) => page.activePtyIds.has(id)), ['x-run', 'y-run'], 'the running sessions of the other lists are still in the running set');
}

// PIN 16, changed on purpose by the crash guard's page commit. Formerly: "stop answer (pin, changed on purpose by the crash guard's page commit): each of the five Archive paths stops a running session and then archives it at once; a stop call that rejects leaves it unarchived". A running session is archived only when stopSessionForArchive allows it; before, it was archived the moment its stop was sent.
test('stop answer: each of the five Archive paths archives a running session only once it has ended or was not running, and skips it when it has not ended, the stop failed or the stop call rejected', async (t) => {
  for (const path of LIST_PATHS) {
    for (const [said, answer, { mayArchive }] of STOP_ANSWERS) {
      await t.test(`${path.name}, stop answers ${said}: each running session is ${mayArchive ? 'archived after its stop' : 'left unarchived'}, the others are archived without a stop`, async () => {
        const page = bootSidebar({ list: path.list, stop: answer });
        await path.run(page);
        assert.deepEqual(page.log, [
          ...(path.asks ? ['ask'] : []),
          'stop run1', ...(mayArchive ? ['archive run1 1 (still in the running set)'] : []),
          'archive idle1 1',
          'stop run2', ...(mayArchive ? ['archive run2 1 (still in the running set)'] : []),
          'archive idle2 1',
          'poll', 'reload',
        ]);
        // Each stop asks main to wait for the end; the options object is made inside the cut block, so it is spread.
        assert.deepEqual(page.stopCalls.map(([id, options]) => [id, { ...options }]), [['run1', { wait: true }], ['run2', { wait: true }]]);
        assert.equal(archivedMarks(page), mayArchive ? 'run1=1 idle1=1 done1=1 run2=1 idle2=1' : 'run1=0 idle1=1 done1=1 run2=0 idle2=1');
        assertOtherListsUntouched(page);
      });
    }

    await t.test(`${path.name}: a stop call that rejects leaves that session unarchived; the rest of the list is archived and the list is refreshed`, async () => {
      const refused = new Error('the kill threw');
      const page = bootSidebar({ list: path.list, stop: (id) => { if (id === 'run2') throw refused; return { ok: true }; } });
      assert.equal(await rejection(path.run(page)), null, 'the click handler does not reject');
      assert.deepEqual(page.log, [
        ...(path.asks ? ['ask'] : []),
        'stop run1', 'archive run1 1 (still in the running set)',
        'archive idle1 1',
        'stop run2',
        'archive idle2 1',
        'poll', 'reload',
      ]);
      assert.equal(archivedMarks(page), 'run1=1 idle1=1 done1=1 run2=0 idle2=1');
      assertOtherListsUntouched(page);
    });

    await t.test(`${path.name}: a running session that main says moved to a new id is archived, and no stop goes to the new id`, async () => {
      const page = bootSidebar({ list: path.list, stop: (id) => (id === 'run1' ? { ok: false, error: 'not running', rekeyedTo: 'run1-new' } : { ok: true, ended: true }) });
      await path.run(page);
      assert.deepEqual(page.log, [
        ...(path.asks ? ['ask'] : []),
        'stop run1', 'archive run1 1 (still in the running set)',
        'archive idle1 1',
        'stop run2', 'archive run2 1 (still in the running set)',
        'archive idle2 1',
        'poll', 'reload',
      ]);
      assert.deepEqual(page.stopCalls.map((args) => args[0]), ['run1', 'run2']);
      assert.equal(archivedMarks(page), 'run1=1 idle1=1 done1=1 run2=1 idle2=1');
    });

    if (path.asks) {
      await t.test(`${path.name}: without a yes nothing is stopped or archived`, async () => {
        const page = bootSidebar({ list: path.list, yes: false });
        await path.run(page);
        assert.deepEqual(page.log, ['ask']);
        assert.equal(archivedMarks(page), 'run1=0 idle1=0 done1=1 run2=0 idle2=0');
        assertOtherListsUntouched(page);
      });
    }
  }

  for (const path of ONE_PATHS) {
    for (const [said, answer, { mayArchive }] of STOP_ANSWERS) {
      await t.test(`${path.name}, stop answers ${said}: a running session is ${mayArchive ? 'archived after its stop' : 'left unarchived, and the list is not reloaded'}`, async () => {
        const page = path.boot({ stop: answer });
        await path.run(page, 'run1');
        assert.deepEqual(page.log, mayArchive
          ? ['stop run1', 'poll', 'archive run1 1 (still in the running set)', ...path.after('run1'), 'reload']
          : ['stop run1', 'poll']);
        assert.deepEqual(page.stopCalls.map(([id, options]) => [id, { ...options }]), [['run1', { wait: true }]]);
        assert.equal(archivedMarks(page), mayArchive ? 'run1=1 idle1=0 done1=1 run2=0 idle2=0' : 'run1=0 idle1=0 done1=1 run2=0 idle2=0');
      });
    }

    await t.test(`${path.name}: a session that is not running is archived without a stop`, async () => {
      const page = path.boot();
      await path.run(page, 'idle1');
      assert.deepEqual(page.log, ['archive idle1 1', ...path.after('idle1'), 'reload']);
      assert.equal(archivedMarks(page), 'run1=0 idle1=1 done1=1 run2=0 idle2=0');
    });

    await t.test(`${path.name}: taking the archive mark off stops nothing, a running session included`, async () => {
      const page = path.boot({ running: ['done1'] });
      await path.run(page, 'done1');
      assert.deepEqual(page.log, ['archive done1 0 (still in the running set)', 'reload']);
      assert.equal(archivedMarks(page), 'run1=0 idle1=0 done1=0 run2=0 idle2=0');
    });

    await t.test(`${path.name}: a stop call that rejects leaves the session unarchived, and the click does not fail`, async () => {
      const refused = new Error('the kill threw');
      const page = path.boot({ stop: () => { throw refused; } });
      assert.equal(await rejection(path.run(page, 'run1')), null);
      assert.deepEqual(page.log, ['stop run1', 'poll']);
      assert.equal(archivedMarks(page), 'run1=0 idle1=0 done1=1 run2=0 idle2=0');
    });

    await t.test(`${path.name}: a running session that main says moved to a new id is archived, and no stop goes to the new id`, async () => {
      const page = path.boot({ stop: () => ({ ok: false, error: 'not running', rekeyedTo: 'run1-new' }) });
      await path.run(page, 'run1');
      assert.deepEqual(page.log, ['stop run1', 'poll', 'archive run1 1 (still in the running set)', ...path.after('run1'), 'reload']);
      assert.deepEqual(page.stopCalls.map((args) => args[0]), ['run1']);
    });

    await t.test(`${path.name}: an archive call that rejects leaves the session's own mark as it was, and the list is not reloaded`, async () => {
      const refused = new Error('the database is locked');
      const page = path.boot({ archive: () => { throw refused; } });
      assert.equal(await rejection(path.run(page, 'idle1')), refused);
      assert.deepEqual(page.log, ['archive idle1 1']);
      assert.equal(archivedMarks(page), 'run1=0 idle1=0 done1=1 run2=0 idle2=0', 'the mark is set only after main answered');
    });
  }
});

// --- Pin 17: "stop all work" in a project ------------------------------------
//
// Two cuts of public/projects-view.js run as one text: what counts as running
// work and the loop that stops it, then the "Stop all" entry that calls both.
// The box between them (confirmStopWork) builds its own dialog and is a fake.
const STOP_WORK = cut('public/projects-view.js', 'function runningWorkInProject(project) {', 'function confirmStopWork(');
const STOP_ALL = cut('public/projects-view.js', 'async function stopAllInProject(project) {', '// --- Snooze ---');

/**
 * stop(id) and stopTask(label) are what main answers; either may throw, which
 * rejects the call. The log holds 'stop <id>', 'task <path> <label>', 'ask',
 * 'poll' and 'reload' in order; inSetAtStop holds, per id, whether the id was
 * still in the running set while its stop call was out, and inSetAtAnswer
 * whether it still was at the moment main answered.
 *
 * Main answers every call a turn later, as over IPC. calls counts the calls
 * main has not answered yet: out (now), most (the most at any one time) and
 * atPoll (when the running set was asked for). One call at a time, each
 * answered before the next goes out, reads { out: 0, most: 1, atPoll: 0 }.
 *   busy   ids of sessions in the middle of a turn
 * asked holds what the box was given: the ids and labels of the running work.
 */
function bootStopWork({ running = [], busy = [], stop = () => ({ ok: true }), stopTask = () => ({ ok: true }), yes = true } = {}) {
  const log = [];
  const asked = [];
  const inSetAtStop = {};
  const inSetAtAnswer = {};
  const calls = { out: 0, most: 0, atPoll: null };
  const activePtyIds = new Set(running);
  const later = (atCall, answer, atAnswer = () => {}) => new Promise((resolve, reject) => {
    atCall();
    calls.out++;
    calls.most = Math.max(calls.most, calls.out);
    setImmediate(() => {
      calls.out--;
      atAnswer();
      try { resolve(answer()); } catch (e) { reject(e); }
    });
  });
  const ctx = load(`${STOP_WORK}\n${STOP_ALL}`, {
    file: 'public/projects-view.js',
    globals: {
      activePtyIds,
      window: {
        api: {
          stopSession: (...args) => later(
            () => { log.push(`stop ${args[0]}`); inSetAtStop[args[0]] = activePtyIds.has(args[0]); },
            () => stop(args[0]),
            () => { inSetAtAnswer[args[0]] = activePtyIds.has(args[0]); },
          ),
          stopTask: (projectPath, label) => later(
            () => { log.push(`task ${projectPath} ${label}`); },
            () => stopTask(label),
          ),
        },
      },
      pollActiveSessions: () => { log.push('poll'); calls.atPoll = calls.out; },
      loadProjects: () => { log.push('reload'); },
      confirmStopWork: async (project, work) => {
        log.push('ask');
        asked.push({
          sessions: Array.from(work.sessions, (session) => session.sessionId),
          tasks: Array.from(work.tasks, (task) => task.label),
          busy: Array.from(work.busy, (session) => session.sessionId),
        });
        return yes;
      },
      projectSessionsAll: (project) => project.sessions,
      isSessionRunning: (id) => activePtyIds.has(id),
      taskPseudoProject: (project) => ({ tasks: project.tasks }),
      sessionBusyState: new Map(busy.map((id) => [id, true])),
    },
  });
  // The real helper, cut out of public/app.js, on this context's window; undefined until the helper exists.
  ctx.stopSessionPlain = load(STOP_FLOW, { file: 'public/app.js', globals: { window: ctx.window } }).stopSessionPlain;
  return { ctx, log, asked, inSetAtStop, inSetAtAnswer, calls, activePtyIds };
}

/** Every stop call was answered before the next went out, and before the running set was asked for. */
const ONE_CALL_AT_A_TIME = { out: 0, most: 1, atPoll: 0 };

const WORK_PROJECT = () => ({
  id: 'p1',
  name: 'Build',
  sessions: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }],
  tasks: [
    { projectPath: 'C:\\work\\api', label: 'build', run: { running: true } },
    { projectPath: 'C:\\work\\api', label: 'lint', run: { running: false } },
    { projectPath: 'C:\\work\\web', label: 'serve', run: { running: true } },
  ],
});

// PIN 17, changed on purpose by the crash guard's page commit. Formerly: "stop answer (pin, changed on purpose by the crash guard's page commit): 'stop all work' stops every session and task of a project and takes each session off the running set whatever the answer". A session leaves the running set only when stopSessionPlain says it was stopped; before, it left the set whatever the answer.
test("stop answer: 'stop all work' stops every session and task of a project and takes a session off the running set only when it was stopped", async (t) => {
  await t.test("'Stop all' stops every running session of the project, then every running task, and nothing else", async () => {
    // s2 and the lint task are not running; 'elsewhere' runs in another project.
    // s3 is in the middle of a turn; so is s2, which does not count because it is not running.
    const page = bootStopWork({ running: ['s1', 's3', 'elsewhere'], busy: ['s2', 's3'] });
    await page.ctx.stopAllInProject(WORK_PROJECT());
    assert.deepEqual(page.log, ['ask', 'stop s1', 'stop s3', 'task C:\\work\\api build', 'task C:\\work\\web serve', 'poll', 'reload']);
    assert.deepEqual([...page.activePtyIds], ['elsewhere']);
    assert.deepEqual(page.asked, [{ sessions: ['s1', 's3'], tasks: ['build', 'serve'], busy: ['s3'] }], 'the box is told what runs, and which of it is in the middle of a turn');
    assert.deepEqual(page.inSetAtAnswer, { s1: true, s3: true }, 'each session is still in the running set when main answers its stop');
    assert.deepEqual(page.calls, ONE_CALL_AT_A_TIME, 'one call at a time, each answered before the next; the running set is asked for after the last answer');
  });

  await t.test("'Stop all' on a project with running tasks and no running session asks, then stops the tasks", async () => {
    const page = bootStopWork({ running: ['elsewhere'] });
    await page.ctx.stopAllInProject(WORK_PROJECT());
    assert.deepEqual(page.log, ['ask', 'task C:\\work\\api build', 'task C:\\work\\web serve', 'poll', 'reload']);
    assert.deepEqual(page.asked, [{ sessions: [], tasks: ['build', 'serve'], busy: [] }]);
    assert.deepEqual([...page.activePtyIds], ['elsewhere']);
    assert.deepEqual(page.calls, ONE_CALL_AT_A_TIME);
  });

  await t.test("'Stop all' on a project with running sessions and no running task asks, then stops the sessions", async () => {
    const page = bootStopWork({ running: ['s2', 'elsewhere'] });
    const project = WORK_PROJECT();
    for (const task of project.tasks) task.run.running = false;
    await page.ctx.stopAllInProject(project);
    assert.deepEqual(page.log, ['ask', 'stop s2', 'poll', 'reload']);
    assert.deepEqual(page.asked, [{ sessions: ['s2'], tasks: [], busy: [] }]);
    assert.deepEqual([...page.activePtyIds], ['elsewhere']);
  });

  await t.test("'Stop all' on a project where nothing runs opens no box, stops nothing and reloads nothing", async () => {
    const page = bootStopWork({ running: ['elsewhere'] });
    const project = WORK_PROJECT();
    for (const task of project.tasks) task.run.running = false;
    await page.ctx.stopAllInProject(project);
    assert.deepEqual(page.log, []);
    assert.deepEqual(page.asked, []);
    assert.deepEqual([...page.activePtyIds], ['elsewhere']);
  });

  await t.test("'Stop all' without a yes stops nothing", async () => {
    const page = bootStopWork({ running: ['s1', 's3'], yes: false });
    await page.ctx.stopAllInProject(WORK_PROJECT());
    assert.deepEqual(page.log, ['ask']);
    assert.deepEqual([...page.activePtyIds], ['s1', 's3']);
  });

  for (const [said, answer, { stopped }] of STOP_ANSWERS) {
    await t.test(`a stop that answers ${said} ${stopped ? 'takes the session off the running set, after the answer' : 'leaves the session in the running set'}`, async () => {
      const page = bootStopWork({ running: ['s1', 'elsewhere'], stop: answer });
      await page.ctx.stopRunningWork({ sessions: [{ sessionId: 's1' }], tasks: [] });
      assert.deepEqual(page.log, ['stop s1', 'poll']);
      assert.equal(page.inSetAtStop.s1, true, 'still in the running set while the stop call is out');
      assert.equal(page.inSetAtAnswer.s1, true, 'and still in it at the moment main answers');
      assert.deepEqual(page.calls, ONE_CALL_AT_A_TIME, 'the running set is asked for after main answered');
      assert.deepEqual([...page.activePtyIds], stopped ? ['elsewhere'] : ['s1', 'elsewhere']);
    });
  }

  await t.test('a stop call that rejects leaves that session in the running set, and the rest is still stopped', async () => {
    const page = bootStopWork({
      running: ['s1', 's2', 's3'],
      stop: (id) => { if (id === 's1') throw new Error('the kill threw'); return { ok: true }; },
    });
    const work = WORK_PROJECT();
    assert.equal(await rejection(page.ctx.stopRunningWork({ sessions: work.sessions, tasks: work.tasks })), null, 'the rejection is swallowed');
    assert.deepEqual(page.log, ['stop s1', 'stop s2', 'stop s3', 'task C:\\work\\api build', 'task C:\\work\\api lint', 'task C:\\work\\web serve', 'poll']);
    assert.deepEqual([...page.activePtyIds], ['s1']);
    assert.deepEqual(page.inSetAtAnswer, { s1: true, s2: true, s3: true }, 'each id leaves the running set only after its own call came back, the rejected one included');
    assert.deepEqual(page.calls, ONE_CALL_AT_A_TIME, 'each call is waited for, the rejected one included');
  });

  await t.test('a session that main says moved to a new id is stopped once under the new id, and its old id leaves the running set', async () => {
    const page = bootStopWork({
      running: ['s1', 's1-new', 'elsewhere'],
      stop: (id) => (id === 's1' ? { ok: false, error: 'not running', rekeyedTo: 's1-new' } : { ok: true }),
    });
    await page.ctx.stopRunningWork({ sessions: [{ sessionId: 's1' }], tasks: [] });
    assert.deepEqual(page.log, ['stop s1', 'stop s1-new', 'poll']);
    assert.deepEqual([...page.activePtyIds], ['s1-new', 'elsewhere'], 'the old id left; the new one is the running check\'s to drop');
    assert.deepEqual(page.calls, ONE_CALL_AT_A_TIME);
  });

  await t.test('a task stop that rejects does not keep the next task from being stopped', async () => {
    const page = bootStopWork({ stopTask: (label) => { if (label === 'build') throw new Error('no such task'); return { ok: true }; } });
    const work = WORK_PROJECT();
    assert.equal(await rejection(page.ctx.stopRunningWork({ sessions: [], tasks: work.tasks })), null, 'the rejection is swallowed');
    assert.deepEqual(page.log, ['task C:\\work\\api build', 'task C:\\work\\api lint', 'task C:\\work\\web serve', 'poll']);
    assert.deepEqual(page.calls, ONE_CALL_AT_A_TIME, 'each task stop is waited for, the rejected one included');
  });
});

// Jason's answer D-E (a), 2026-10-06: written before the fix and shown to fail on the code before it.
test("stop answer: after 'stop failed', no answer or a rejected stop call the Stop button leaves the running set and the pane as they are and redraws the sidebar once", async (t) => {
  const NOT_STOPPED = [
    ["'stop failed'", () => ({ ok: false, error: 'stop failed' })],
    // bootStop resolves its promise with the answer, and its parameter default turns a plain
    // undefined into { ok: true }. So 'nothing' is a thenable that resolves with undefined, and
    // a thenable that rejects makes the stop call reject, as it does when the kill throws in
    // today's main process.
    ['nothing', () => ({ then(resolve) { resolve(undefined); } })],
    ['a rejected call', () => ({ then(resolve, reject) { reject(new Error('the kill threw')); } })],
  ];
  for (const [said, answer] of NOT_STOPPED) {
    await t.test(`main answers ${said}`, async () => {
      const page = bootStop({ answer: answer() });
      assert.equal(await rejection(page.ctx.confirmAndStopSession('sess1')), null, 'the click does not fail');
      assert.deepEqual(page.seen.stops.map((args) => args[0]), ['sess1'], 'one stop call, and no second try');
      assert.deepEqual(page.seen.atAnswer, { inSet: true, shown: [], redraws: 0 }, 'nothing changed before main answered');
      assert.equal(page.activePtyIds.has('sess1'), true, 'the id stays in the running set');
      assert.deepEqual(paneState(page), PANE_UNTOUCHED, 'the terminal stays on screen');
      assert.equal(page.seen.redraws, 1, 'the sidebar is redrawn once');
      assert.deepEqual(page.seen.atRedraw, [{ inSet: true, shown: [] }], 'that redraw sees the session still running and still on screen');
    });
  }
});

// Jason's answer D-E (b), 2026-10-06: written before the fix and shown to fail on the code before it.
test('stop answer: a list Archive loop whose archive call rejects leaves that session unarchived, goes on to the next session and still refreshes the list', async (t) => {
  for (const path of LIST_PATHS) {
    await t.test(`${path.name}: the archive call of one session rejects`, async () => {
      const refused = new Error('the database is locked');
      const page = bootSidebar({ list: path.list, archive: (id) => { if (id === 'idle1') throw refused; } });
      assert.equal(await rejection(path.run(page)), null, 'the click handler does not reject');
      assert.deepEqual(page.log, [
        ...(path.asks ? ['ask'] : []),
        'stop run1', 'archive run1 1 (still in the running set)',
        'archive idle1 1',
        'stop run2', 'archive run2 1 (still in the running set)',
        'archive idle2 1',
        'poll', 'reload',
      ]);
      assert.equal(archivedMarks(page), 'run1=1 idle1=0 done1=1 run2=1 idle2=1');
      assert.deepEqual(page.globals.console.calls, [['[archive] not archived:', 'idle1', refused]], 'the rejection is written to the console, once, with the full id');
      assertOtherListsUntouched(page);
    });

    await t.test(`${path.name}: the archive call of a stopped session rejects and a later session has not ended: neither is archived, the rest is`, async () => {
      const refused = new Error('the database is locked');
      const page = bootSidebar({
        list: path.list,
        stop: (id) => ({ ok: true, ended: id === 'run1' }),
        archive: (id) => { if (id === 'run1') throw refused; },
      });
      assert.equal(await rejection(path.run(page)), null, 'the click handler does not reject');
      assert.deepEqual(page.log, [
        ...(path.asks ? ['ask'] : []),
        'stop run1', 'archive run1 1 (still in the running set)',
        'archive idle1 1',
        'stop run2',
        'archive idle2 1',
        'poll', 'reload',
      ]);
      assert.equal(archivedMarks(page), 'run1=0 idle1=1 done1=1 run2=0 idle2=1', 'no session is marked archived while it still runs or after its archive call failed');
      assertOtherListsUntouched(page);
    });
  }
});

test('stop answer: the two stop helpers read every answer of a stop, and a rejected call counts as not stopped', async (t) => {
  for (const [said, answer, { stopped, mayArchive }] of STOP_ANSWERS) {
    await t.test(`main answers ${said}`, async () => {
      const plain = bootHelpers([answer]);
      assert.equal(await plain.ctx.stopSessionPlain('sess1'), stopped);
      assert.deepEqual(plain.calls, [['sess1']], 'the plain helper sends the id alone, once');
      const waiting = bootHelpers([answer]);
      assert.equal(await waiting.ctx.stopSessionForArchive('sess1'), mayArchive);
      assert.deepEqual(waiting.calls, [['sess1', { wait: true }]], 'the waiting helper asks main to wait, once');
    });
  }

  const thrown = () => { throw new Error('the kill threw'); };
  await t.test('the stop call rejects: not stopped, not to be archived, and neither helper rejects', async () => {
    const plain = bootHelpers([thrown]);
    assert.equal(await plain.ctx.stopSessionPlain('sess1'), false);
    assert.deepEqual(plain.calls, [['sess1']], 'no second try after a rejection');
    const waiting = bootHelpers([thrown]);
    assert.equal(await waiting.ctx.stopSessionForArchive('sess1'), false);
    assert.deepEqual(waiting.calls, [['sess1', { wait: true }]]);
  });

  await t.test('window.api has no stop call: both helpers answer false and neither rejects', async () => {
    assert.equal(await bootHelpers([], {}).ctx.stopSessionPlain('sess1'), false);
    assert.equal(await bootHelpers([], {}).ctx.stopSessionForArchive('sess1'), false);
  });

  const moved = (to) => () => ({ ok: false, error: 'not running', rekeyedTo: to });
  const SECOND_TRIES = [
    ['ok', () => ({ ok: true }), true],
    ["'not running'", () => ({ ok: false, error: 'not running' }), true],
    ["'stop failed'", () => ({ ok: false, error: 'stop failed' }), false],
    ['that it moved again', moved('sess1-newer'), false],
    ['nothing', () => undefined, false],
    ['a rejection', thrown, false],
  ];
  for (const [said, second, stopped] of SECOND_TRIES) {
    await t.test(`main says the id moved and answers the second try with ${said}: the plain helper tries once under the new id and never a third time`, async () => {
      const h = bootHelpers([moved('sess1-new'), second]);
      assert.equal(await h.ctx.stopSessionPlain('sess1'), stopped);
      assert.deepEqual(h.calls, [['sess1'], ['sess1-new']]);
    });
  }

  await t.test('main says the id moved: the waiting helper says it may be archived and sends no second stop', async () => {
    const h = bootHelpers([moved('sess1-new')]);
    assert.equal(await h.ctx.stopSessionForArchive('sess1'), true);
    assert.deepEqual(h.calls, [['sess1', { wait: true }]]);
  });
});

test('stop answer: no file under public/ names stopSession outside the two stop helpers, and a call of a helper from another file is guarded', () => {
  const PUBLIC = path.join(__dirname, '..', 'public');
  const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const count = (text, re) => (text.match(re) || []).length;
  // The word alone: stopSessionPlain and stopSessionForArchive do not match.
  const WORD = /(?<![\w$])stopSession(?![\w$])/g;

  // The helpers stand inside the cut, plain first, and nothing but them names the word.
  const helpers = cut('public/app.js', 'async function stopSessionPlain(sessionId) {', '// --- Terminal header controls ---');
  assert.ok(STOP_FLOW.endsWith(helpers), 'both helpers stand between confirmAndStopSession and the header-controls comment');
  assert.ok(helpers.includes('async function stopSessionForArchive(sessionId) {'), 'the waiting helper comes after the plain one');
  assert.ok(count(helpers, WORD) >= 2, 'the scan sees the two calls at all');
  const named = {};
  for (const file of fs.readdirSync(PUBLIC).filter((f) => /\.(js|html)$/.test(f))) {
    const n = count(read(file), WORD);
    if (n) named[file] = n;
  }
  assert.deepEqual(named, { 'app.js': count(helpers, WORD) }, 'comments count too: outside the helpers write "the stop call"');

  // Another file reaches a helper only behind a typeof guard, where a missing helper counts as not stopped.
  const CALLS = [
    ['sidebar.js', 'stopSessionForArchive', 2],
    ['projects-view.js', 'stopSessionForArchive', 1],
    ['projects-view.js', 'stopSessionPlain', 1],
  ];
  for (const [file, name, calls] of CALLS) {
    const src = read(file);
    assert.equal(count(src, new RegExp(`(?<![\\w$])${name}\\(`, 'g')), calls, `${file}: calls of ${name}`);
    assert.equal(count(src, new RegExp(`typeof ${name} === 'function' && await ${name}\\(`, 'g')), calls, `${file}: each call of ${name} is guarded, spelled just so`);
  }
});

test('stop answer: the Stop button stops the id its session has when the box is answered, tries once more under the id main says it moved to, and closes the view of the id the session has after the answer', async (t) => {
  /** What the re-key listener of public/app.js does to the page: the same record under the new id. */
  const rekeyPage = (page, oldId, newId) => {
    const entry = page.ctx.openSessions.get(oldId);
    entry.session.sessionId = newId;
    page.ctx.openSessions.delete(oldId);
    page.ctx.openSessions.set(newId, entry);
    if (page.ctx.activeSessionId === oldId) page.ctx.activeSessionId = newId;
    page.activePtyIds.add(newId);
  };
  const MOVED = () => ({ ok: false, error: 'not running', rekeyedTo: 'sess1-new' });
  /** Main answers the stop calls in order; the returned list holds the ids they were sent under. */
  const answerInOrder = (page, replies) => {
    const sent = [];
    page.ctx.window.api.stopSession = async (...args) => { sent.push(args[0]); return replies.shift()(); };
    return sent;
  };

  await t.test('the session moved to a new id while the box was open: the stop goes to the new id, and that id leaves the running set and the pane', async () => {
    const page = bootStop();
    page.ctx.confirmDialog = async () => { rekeyPage(page, 'sess1', 'sess1-new'); return true; };
    await page.ctx.confirmAndStopSession('sess1');
    assert.deepEqual(page.seen.stops.map((args) => args[0]), ['sess1-new']);
    assert.equal(page.activePtyIds.has('sess1-new'), false, 'the id the session has now left the running set');
    assert.equal(page.activePtyIds.has('sess1'), true, 'the old id is left to the running check');
    assert.deepEqual(paneState(page), PANE_CLEARED);
    assert.equal(page.seen.redraws, 1);
  });

  await t.test('main says the id moved: one more stop under the new id, and the view closes', async () => {
    const page = bootStop();
    const sent = answerInOrder(page, [MOVED, () => ({ ok: true })]);
    await page.ctx.confirmAndStopSession('sess1');
    assert.deepEqual(sent, ['sess1', 'sess1-new']);
    assert.equal(page.activePtyIds.has('sess1'), false, 'the id the session has on this page left the running set');
    assert.deepEqual(paneState(page), PANE_CLEARED);
    assert.equal(page.seen.redraws, 1);
  });

  await t.test('the move reaches the page while the stop call is out: the id the session has after the answer leaves the running set and the pane', async () => {
    const page = bootStop();
    const sent = answerInOrder(page, [() => { rekeyPage(page, 'sess1', 'sess1-new'); return MOVED(); }, () => ({ ok: true })]);
    await page.ctx.confirmAndStopSession('sess1');
    assert.deepEqual(sent, ['sess1', 'sess1-new']);
    assert.equal(page.activePtyIds.has('sess1-new'), false);
    assert.deepEqual(paneState(page), PANE_CLEARED);
    assert.equal(page.seen.redraws, 1);
  });

  await t.test('main says the id moved and the second try fails: nothing changes but one redraw', async () => {
    const page = bootStop();
    const sent = answerInOrder(page, [MOVED, () => ({ ok: false, error: 'stop failed' })]);
    await page.ctx.confirmAndStopSession('sess1');
    assert.deepEqual(sent, ['sess1', 'sess1-new']);
    assert.equal(page.activePtyIds.has('sess1'), true);
    assert.deepEqual(paneState(page), PANE_UNTOUCHED);
    assert.equal(page.seen.redraws, 1);
  });

  await t.test('the page holds no open record for the id: the id that was asked for is used throughout', async () => {
    const page = bootStop();
    page.ctx.openSessions.clear();
    await page.ctx.confirmAndStopSession('sess1');
    assert.deepEqual(page.seen.stops.map((args) => args[0]), ['sess1']);
    assert.equal(page.activePtyIds.has('sess1'), false);
    assert.deepEqual(paneState(page), PANE_CLEARED);
    assert.equal(page.seen.redraws, 1);
  });
});

// An empty list: every row of the group is archived already or unknown to the page.
test("stop answer: a group's archive button on a group whose sessions are all archived or unknown to the page stops nothing, archives nothing, and still polls and reloads once", async () => {
  const page = bootSidebar({ list: 'group' });
  // run1 and run2 stay in the running set: an archived session is skipped before any stop.
  for (const id of ['run1', 'idle1', 'run2', 'idle2']) page.session(id).archived = 1;
  assert.equal(await rejection(page.click(page.buttons.group, 'the group archive button')), null, 'the click does not fail');
  assert.deepEqual(page.log, ['poll', 'reload'], 'no stop call and no archive call; one poll and one reload');
  assert.deepEqual(page.stopCalls, []);
  assert.equal(archivedMarks(page), 'run1=1 idle1=1 done1=1 run2=1 idle2=1');
  assertOtherListsUntouched(page);
});

test("stop answer: with the stop helper missing, 'stop all work' stops no session, takes none off the running set and still stops the tasks", async () => {
  const page = bootStopWork({ running: ['s1', 'elsewhere'] });
  page.ctx.stopSessionPlain = undefined;
  const work = WORK_PROJECT();
  assert.equal(await rejection(page.ctx.stopRunningWork({ sessions: [{ sessionId: 's1' }], tasks: work.tasks })), null);
  assert.deepEqual(page.log, ['task C:\\work\\api build', 'task C:\\work\\api lint', 'task C:\\work\\web serve', 'poll']);
  assert.deepEqual([...page.activePtyIds], ['s1', 'elsewhere']);
});
