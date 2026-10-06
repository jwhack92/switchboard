'use strict';
// Pin test (relaunch work, Phase 1b): what the window does when a session's
// process ends. It records the behaviour of public/app.js as it is today, so
// that a later fix cannot change it unnoticed.
//
// The listener is cut out of public/app.js by two marker strings and run in a
// vm context against fakes (test-support/source-cut.js). The rule that tells a
// death from an ending the user asked for is the real one,
// public/terminal-manager.js wasIntentionalExit, so the pin covers the listener
// and the rule together. Tearing a terminal down (destroySession) is a fake
// that records the call and takes the entry out of the open set.

const test = require('node:test');
const assert = require('node:assert/strict');

const { cut, load } = require('../test-support/source-cut');
const { wasIntentionalExit } = require('../public/terminal-manager');

const APP = 'public/app.js';

// The start marker is the text test/continue-name.test.js ends its own cut on
// (the session-forked listener stops where this one starts). The helper demands
// that it is in the file exactly once.
const EXIT_BLOCK = cut(APP, 'window.api.onProcessExited(', '// ── Session tear-off');
const FIRST_LINE = 'window.api.onProcessExited((sessionId, exitCode, signal, userStopped) => {';

/** The yellow line a dead session's terminal ends with. */
const exitLine = (reason) => `\r\n\x1b[33m── session exited (${reason}) ──\x1b[0m\r\n`;

// How a process can end. `reason` is what the exit line says.
const DIED = [
  { name: 'a non-zero exit code', exitCode: 1, signal: 0, userStopped: false, reason: 'code 1' },
  { name: 'a command that was not found', exitCode: 127, signal: undefined, userStopped: false, reason: 'code 127' },
  { name: 'a signal nobody here sent', exitCode: 0, signal: 9, userStopped: false, reason: 'signal 9' },
  // Both at once: the line names the signal, not the code.
  { name: 'a non-zero exit code together with a signal', exitCode: 1, signal: 15, userStopped: false, reason: 'signal 15' },
];
const ENDED_BY_THE_USER = [
  { name: 'the Stop button (a kill reported as code 0 with a signal)', exitCode: 0, signal: 1, userStopped: true },
  { name: 'the Stop button, non-zero code', exitCode: 1, signal: undefined, userStopped: true },
  { name: 'a clean exit typed in the session', exitCode: 0, signal: 0, userStopped: false },
];

const CLAUDE = { sessionId: 'c1', name: 'Review Pass' };            // any row that is not a plain terminal
const OTHER = { sessionId: 'c2', name: 'Phase 7' };
const TERMINAL = { sessionId: 't1', type: 'terminal', name: 'Terminal 1' };

/** The session ids of a cached project, as an array of this realm. */
const ids = (project) => Array.from(project.sessions, (s) => s.sessionId);

/**
 * The listener in a context of its own.
 *   rows      the sessions the window knows (sessionMap, and both project caches)
 *   open      ids with a terminal mounted in this window
 *   pending   ids of sessions that have not written a transcript yet
 *   active    the session on screen
 *   grid      grid view is on
 *   writeThrows   the terminal's write throws (a terminal already disposed)
 */
function bootExit({ rows = [], open = [], pending = [], active = null, grid = false, writeThrows = false } = {}) {
  const calls = {
    destroyed: [], activeSet: [], gridCounts: 0, dots: 0, polls: 0, sidebar: 0, loads: 0,
    treesDropped: [], stateForgotten: [],
    order: [],   // 'destroy <id>' and 'show <id>' in the order they happened
  };
  let exited = null;
  const entries = new Map(open.map((id) => {
    const writes = [];
    const write = (data) => { if (writeThrows) throw new Error('terminal disposed'); writes.push(data); };
    return [id, { closed: false, terminal: { write }, writes }];
  }));
  const openSessions = new Map(entries);
  const sessionMap = new Map(rows.map((row) => [row.sessionId, row]));
  const pendingSessions = new Map(pending.map((id) => [id, { session: sessionMap.get(id), projectPath: 'C:\\proj' }]));
  const pendingRecords = new Map(pendingSessions);
  const sessionEventTimes = new Map(rows.map((row) => [row.sessionId, 1000]));
  const terminalHeader = { style: { display: 'flex' } };
  const placeholder = { style: { display: 'none' } };
  const ctx = load(EXIT_BLOCK, {
    file: APP,
    globals: {
      window: { api: { onProcessExited: (cb) => { exited = cb; } } },
      openSessions,
      sessionMap,
      pendingSessions,
      sessionEventTimes,
      cachedProjects: [{ projectPath: 'C:\\proj', sessions: rows.slice() }],
      cachedAllProjects: [
        { projectPath: 'C:\\proj', sessions: rows.slice() },
        { projectPath: 'C:\\archived', sessions: [{ sessionId: 'elsewhere' }] },
      ],
      wasIntentionalExit,
      activeSessionId: active,
      gridViewActive: grid,
      terminalHeader,
      placeholder,
      destroySession: (id) => { calls.destroyed.push(id); calls.order.push(`destroy ${id}`); return openSessions.delete(id); },
      setActiveSession: (id) => { calls.activeSet.push(id); calls.order.push(`show ${id}`); },
      updateGridCount: () => { calls.gridCounts++; },
      updateProjectStatusDots: () => { calls.dots++; },
      pollActiveSessions: () => { calls.polls++; },
      refreshSidebar: () => { calls.sidebar++; },
      loadProjects: () => { calls.loads++; },
      removeSessionFromTrees: (id) => { calls.treesDropped.push(id); },
      forgetProjectSessionState: (id) => { calls.stateForgotten.push(id); },
    },
  });
  assert.equal(typeof exited, 'function', 'the block registers one process-exited listener');
  return {
    ctx, calls, entries, openSessions, sessionMap, pendingSessions, pendingRecords, sessionEventTimes,
    terminalHeader, placeholder,
    exit: (id, how) => exited(id, how.exitCode, how.signal, how.userStopped),
  };
}

/** The pane still shows the terminal: nothing was hidden, nobody was told the screen is empty. */
function assertPaneUntouched(page, label) {
  assert.deepEqual(page.calls.activeSet, [], label + ': the session on screen is not changed');
  assert.equal(page.terminalHeader.style.display, 'flex', label + ': the header stays');
  assert.equal(page.placeholder.style.display, 'none', label + ': the placeholder stays hidden');
}

/** The pane was cleared: no session on screen, header hidden, placeholder back. */
function assertPaneCleared(page, label) {
  assert.deepEqual(page.calls.activeSet, [null], label + ': no session is on screen any more');
  assert.equal(page.terminalHeader.style.display, 'none', label + ': the header is hidden');
  assert.equal(page.placeholder.style.display, '', label + ': the placeholder is shown');
}

/** The row is where it was, in the session list and in both project caches. */
function assertRowKept(page, id, label) {
  assert.equal(page.sessionMap.has(id), true, label + ': the row stays in the session list');
  assert.ok(ids(page.ctx.cachedProjects[0]).includes(id), label + ': the row stays in the project list');
  assert.ok(ids(page.ctx.cachedAllProjects[0]).includes(id), label + ': the row stays in the all-projects list');
  assert.equal(page.sessionEventTimes.has(id), true, label + ': its sort time stays');
  assert.deepEqual(page.calls.treesDropped, [], label);
  assert.deepEqual(page.calls.stateForgotten, [], label);
  assert.equal(page.calls.sidebar, 0, label + ': the sidebar is not redrawn');
  assert.equal(page.calls.loads, 0, label + ': the projects are not read again');
}

test('app exit (pin): a Claude session that died keeps its terminal behind the exit line; a stopped one and every plain terminal are taken down; a plain terminal\'s row is removed', async (t) => {
  await t.test('the listener\'s first line keeps its text: another test ends its cut on it', () => {
    assert.equal(EXIT_BLOCK.split('\n')[0].trimEnd(), FIRST_LINE);
  });

  await t.test('a Claude session that died keeps its terminal, with the exit line as its last output', () => {
    for (const how of DIED) {
      const page = bootExit({ rows: [CLAUDE, OTHER], open: ['c1'], active: 'c1' });
      const entry = page.entries.get('c1');
      page.exit('c1', how);

      assert.equal(entry.closed, true, how.name + ': the terminal is marked closed');
      assert.deepEqual(entry.writes, [exitLine(how.reason)], how.name + ': one exit line, and nothing else, is written');
      assert.deepEqual(page.calls.destroyed, [], how.name + ': the terminal is not taken down');
      assert.equal(page.openSessions.get('c1'), entry, how.name + ': the terminal stays mounted');
      assertPaneUntouched(page, how.name);
      assertRowKept(page, 'c1', how.name);
      assert.equal(page.calls.gridCounts, 0, how.name + ': no grid count outside grid view');
      assert.equal(page.calls.dots, 1, how.name + ': the Projects tab dots are redrawn once');
      assert.equal(page.calls.polls, 1, how.name + ': the running set is asked for once');
    }
  });

  await t.test('a dead Claude session: grid view, a pending session, a session not open here, a terminal that cannot be written', () => {
    // Grid view: the same, plus the grid's count.
    const grid = bootExit({ rows: [CLAUDE], open: ['c1'], active: 'c1', grid: true });
    grid.exit('c1', DIED[0]);
    assert.deepEqual(grid.entries.get('c1').writes, [exitLine('code 1')]);
    assert.deepEqual(grid.calls.destroyed, []);
    assert.equal(grid.calls.gridCounts, 1);
    assert.equal(grid.calls.polls, 1);

    // A session that never wrote a transcript: it is marked dead, and its row
    // and its pending record stay.
    const pending = bootExit({ rows: [CLAUDE], open: ['c1'], pending: ['c1'], active: 'c1' });
    pending.exit('c1', DIED[0]);
    assert.equal(pending.pendingRecords.get('c1').exited, true);
    assert.equal(pending.pendingSessions.get('c1'), pending.pendingRecords.get('c1'), 'the pending record stays');
    assert.deepEqual(pending.entries.get('c1').writes, [exitLine('code 1')]);
    assert.deepEqual(pending.calls.destroyed, []);
    assertRowKept(pending, 'c1', 'pending');

    // Not open in this window: there is no terminal to write to or to take down.
    const elsewhere = bootExit({ rows: [CLAUDE, OTHER], open: ['c2'], active: 'c2' });
    elsewhere.exit('c1', DIED[0]);
    assert.deepEqual(elsewhere.entries.get('c2').writes, [], 'no other terminal gets the line');
    assert.equal(elsewhere.entries.get('c2').closed, false);
    assert.deepEqual(elsewhere.calls.destroyed, []);
    assertPaneUntouched(elsewhere, 'not open here');
    assertRowKept(elsewhere, 'c1', 'not open here');
    assert.equal(elsewhere.calls.polls, 1);
    assert.equal(elsewhere.calls.dots, 1, 'not open here: the Projects tab dots are still redrawn once');
    assert.equal(elsewhere.calls.gridCounts, 0);

    // Not open in this window AND never wrote a transcript: it is still a
    // death, not a take-down. The pending record is marked dead and the row
    // stays, so there is somewhere to relaunch from.
    const pendingElsewhere = bootExit({ rows: [CLAUDE, OTHER], open: ['c2'], pending: ['c1'], active: 'c2' });
    pendingElsewhere.exit('c1', DIED[0]);
    assert.equal(pendingElsewhere.pendingRecords.get('c1').exited, true, 'pending, not open here: marked dead');
    assert.equal(pendingElsewhere.pendingSessions.get('c1'), pendingElsewhere.pendingRecords.get('c1'), 'pending, not open here: the pending record stays');
    assert.deepEqual(pendingElsewhere.entries.get('c2').writes, [], 'pending, not open here: no other terminal gets the line');
    assert.deepEqual(pendingElsewhere.calls.destroyed, []);
    assertPaneUntouched(pendingElsewhere, 'pending, not open here');
    assertRowKept(pendingElsewhere, 'c1', 'pending, not open here');
    assert.equal(pendingElsewhere.calls.dots, 1, 'pending, not open here: the Projects tab dots are redrawn once');
    assert.equal(pendingElsewhere.calls.polls, 1);

    // The exit line cannot be written: the rest still happens, nothing throws.
    const broken = bootExit({ rows: [CLAUDE], open: ['c1'], active: 'c1', writeThrows: true });
    broken.exit('c1', DIED[0]);
    assert.equal(broken.entries.get('c1').closed, true);
    assert.deepEqual(broken.calls.destroyed, []);
    assert.equal(broken.calls.polls, 1);

    // An open terminal the window has no row for is treated as a Claude session.
    const noRow = bootExit({ rows: [OTHER], open: ['c1'], active: 'c1' });
    noRow.exit('c1', DIED[2]);
    assert.deepEqual(noRow.entries.get('c1').writes, [exitLine('signal 9')]);
    assert.deepEqual(noRow.calls.destroyed, []);
  });

  await t.test('a Claude session the user ended is taken down, without an exit line, and keeps its row', () => {
    for (const how of ENDED_BY_THE_USER) {
      const page = bootExit({ rows: [CLAUDE, OTHER], open: ['c1', 'c2'], active: 'c1' });
      const entry = page.entries.get('c1');
      page.exit('c1', how);

      assert.equal(entry.closed, true, how.name);
      assert.deepEqual(entry.writes, [], how.name + ': no exit line');
      assert.deepEqual(page.calls.destroyed, ['c1'], how.name + ': the terminal is taken down, once');
      assert.equal(page.openSessions.has('c1'), false, how.name);
      assert.equal(page.openSessions.has('c2'), true, how.name + ': the other terminal is left alone');
      assert.equal(page.entries.get('c2').closed, false, how.name);
      assertPaneCleared(page, how.name);
      assert.deepEqual(page.calls.order, ['destroy c1', 'show null'], how.name + ': the terminal is taken down first, then the pane is cleared');
      assertRowKept(page, 'c1', how.name);
      assert.equal(page.calls.gridCounts, 0, how.name);
      assert.equal(page.calls.polls, 1, how.name + ': the running set is asked for once');
    }
  });

  await t.test('a stopped Claude session: another session on screen, grid view, not open here, still pending', () => {
    const stop = ENDED_BY_THE_USER[0];

    // Another session is on screen: the pane is that session's and stays.
    const background = bootExit({ rows: [CLAUDE, OTHER], open: ['c1', 'c2'], active: 'c2' });
    background.exit('c1', stop);
    assert.deepEqual(background.calls.destroyed, ['c1']);
    assertPaneUntouched(background, 'in the background');

    // Grid view: the grid's count is redrawn and the pane is not cleared, even
    // for the session that has the focus.
    const grid = bootExit({ rows: [CLAUDE], open: ['c1'], active: 'c1', grid: true });
    grid.exit('c1', stop);
    assert.deepEqual(grid.calls.destroyed, ['c1']);
    assert.equal(grid.calls.gridCounts, 1);
    assertPaneUntouched(grid, 'grid view');

    // Not open in this window: nothing to take down; the row stays.
    const elsewhere = bootExit({ rows: [CLAUDE, OTHER], open: ['c2'], active: 'c2' });
    elsewhere.exit('c1', stop);
    assert.deepEqual(elsewhere.calls.destroyed, []);
    assertRowKept(elsewhere, 'c1', 'not open here');
    assert.equal(elsewhere.calls.polls, 1);

    // Stopped before it wrote a transcript: there is nothing to reopen, so the
    // row goes, and the projects are read again in case a transcript did land.
    const pending = bootExit({ rows: [CLAUDE, OTHER], open: ['c1'], pending: ['c1'], active: 'c1' });
    pending.exit('c1', stop);
    assert.deepEqual(pending.calls.destroyed, ['c1']);
    assert.equal(pending.pendingSessions.has('c1'), false);
    assert.equal(pending.sessionMap.has('c1'), false);
    assert.deepEqual(ids(pending.ctx.cachedProjects[0]), ['c2']);
    assert.deepEqual(ids(pending.ctx.cachedAllProjects[0]), ['c2']);
    assert.deepEqual(pending.calls.treesDropped, ['c1']);
    assert.equal(pending.calls.sidebar, 1);
    assert.equal(pending.calls.loads, 1, 'a pending Claude session: the projects are read again');
    assert.equal(pending.calls.polls, 1);
  });

  await t.test('a plain terminal is taken down however it ended, and its row is removed', () => {
    for (const how of [...DIED, ...ENDED_BY_THE_USER]) {
      const page = bootExit({ rows: [TERMINAL, CLAUDE], open: ['t1', 'c1'], active: 't1' });
      const entry = page.entries.get('t1');
      page.exit('t1', how);

      assert.equal(entry.closed, true, how.name);
      assert.deepEqual(entry.writes, [], how.name + ': a plain terminal gets no exit line');
      assert.deepEqual(page.calls.destroyed, ['t1'], how.name + ': the terminal is taken down, once');
      assert.equal(page.openSessions.has('t1'), false, how.name);
      assertPaneCleared(page, how.name);
      assert.deepEqual(page.calls.order, ['destroy t1', 'show null'], how.name + ': the terminal is taken down first, then the pane is cleared');

      // The row is gone everywhere the window keeps it; the other rows stay.
      assert.equal(page.sessionMap.has('t1'), false, how.name + ': gone from the session list');
      assert.equal(page.sessionMap.has('c1'), true, how.name);
      assert.deepEqual(ids(page.ctx.cachedProjects[0]), ['c1'], how.name + ': gone from the project list');
      assert.deepEqual(ids(page.ctx.cachedAllProjects[0]), ['c1'], how.name + ': gone from the all-projects list');
      assert.deepEqual(ids(page.ctx.cachedAllProjects[1]), ['elsewhere'], how.name + ': other projects are untouched');
      assert.equal(page.sessionEventTimes.has('t1'), false, how.name + ': its sort time is dropped');
      assert.equal(page.sessionEventTimes.has('c1'), true, how.name);
      assert.deepEqual(page.calls.treesDropped, ['t1'], how.name + ': gone from the project trees');
      assert.deepEqual(page.calls.stateForgotten, ['t1'], how.name + ': the Projects tab forgets it');
      assert.equal(page.calls.sidebar, 1, how.name + ': the sidebar is redrawn once');
      assert.equal(page.calls.loads, 0, how.name + ': a plain terminal needs no re-read of the projects');
      assert.equal(page.openSessions.has('c1'), true, how.name + ': the other terminal is left alone');
      assert.equal(page.calls.polls, 1, how.name + ': the running set is asked for once');
    }

    // In the background and in grid view the pane is not cleared; the row still goes.
    const background = bootExit({ rows: [TERMINAL, CLAUDE], open: ['t1', 'c1'], active: 'c1' });
    background.exit('t1', DIED[0]);
    assert.deepEqual(background.calls.destroyed, ['t1']);
    assertPaneUntouched(background, 'in the background');
    assert.equal(background.sessionMap.has('t1'), false);

    const grid = bootExit({ rows: [TERMINAL, CLAUDE], open: ['t1', 'c1'], active: 't1', grid: true });
    grid.exit('t1', DIED[0]);
    assert.deepEqual(grid.calls.destroyed, ['t1']);
    assert.equal(grid.calls.gridCounts, 1);
    assertPaneUntouched(grid, 'grid view');
    assert.equal(grid.sessionMap.has('t1'), false);
    assert.equal(grid.calls.sidebar, 1);
  });
});
