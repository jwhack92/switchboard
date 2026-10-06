'use strict';
// PIN (Phase 1b of the relaunch work, written before any fix).
//
// The row session-cache.js builds for a plain terminal: the loop at the
// comment "Inject active plain terminal sessions" in buildProjectsFromCache.
// A plain terminal has no transcript, so it has no cached row; this loop is
// the only thing that puts it in the sidebar and the Projects tab.
//
// The small fix "a plain terminal keeps its name and its pin" changes two
// fields of that row, name and starred, and nothing else. So this file fixes
// every OTHER field, the cases that give no row, and "never twice". It never
// reads the VALUE of name or starred, and the saved name and star it hands the
// module are there to prove the rest does not move when they exist.
//
// Plain node. The real session-cache.js against a fake db and an empty temp
// folder standing in for ~/.claude/projects. No transcript is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

const P_BUSY = 'C:\\repo\\with-sessions';
const P_ONLY = 'C:\\repo\\terminal-only';
const P_HIDDEN = 'C:\\repo\\hidden';
const P_OTHER = 'C:\\repo\\other';

// A fixed instant given as UTC, so the expected text below does not depend on
// the time zone or the day the test runs.
const OPENED_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const OPENED_ISO = '2026-01-02T03:04:05.678Z';

/** The fields a plain terminal's row has today, in no order. */
const ROW_KEYS = ['archived', 'created', 'firstPrompt', 'messageCount', 'modified', 'name',
  'projectPath', 'sessionId', 'starred', 'summary', 'type'];

/** A live plain terminal as main.js keeps it in activeSessions (only the fields the row is built from). */
const terminal = (projectPath, more = {}) => ({ isPlainTerminal: true, exited: false, projectPath, _openedAt: OPENED_MS, ...more });

/**
 * Points session-cache at a fresh empty projects folder and the given state.
 *   active    [[sessionId, session], ...]   the live sessions
 *   cached    rows of the session cache (Claude sessions)
 *   dirs      [{ folder, projectPath }]     project folders on disk, already indexed
 *   meta      [[sessionId, { name, starred, archived }], ...]
 *   hidden    project paths the user hid
 */
function boot(t, { active = [], cached = [], dirs = [], meta = [], hidden = [] } = {}) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-terminal-row-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  for (const d of dirs) fs.mkdirSync(path.join(projectsDir, d.folder), { recursive: true });

  const folderMeta = new Map(dirs.map(d => [d.folder, { folder: d.folder, projectPath: d.projectPath, indexMtimeMs: 1 }]));
  const metaMap = new Map(meta.map(([sessionId, m]) => [sessionId, { sessionId, name: null, starred: 0, archived: 0, ...m }]));
  const settingsAsked = [];

  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(active),
    broadcast: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    db: {
      deleteCachedFolder() {}, getCachedByFolder() { return []; },
      getCachedSession() { return null; },
      upsertCachedSessions() {}, deleteCachedSession() {},
      deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
      setFolderMeta() {}, getAllFolderMeta() { return folderMeta; },
      getAllMeta() { return metaMap; }, getAllCached() { return cached; },
      getSetting(key) { settingsAsked.push(key); return key === 'global' ? { hiddenProjects: hidden } : null; },
      // A fix may read one terminal's saved name and star this way instead of
      // from the map above; both hold the same thing.
      getMeta(sessionId) { return metaMap.get(sessionId) || null; },
      setName() {},
    },
  });
  return { settingsAsked };
}

/** A cached Claude session row, as db.getAllCached hands it over. */
const claudeRow = (sessionId, projectPath, modified, more = {}) => ({
  sessionId, folder: encodeProjectPath(projectPath), projectPath,
  summary: 'a Claude session', firstPrompt: 'hello', created: modified, modified,
  messageCount: 3, slug: null, aiTitle: null, ...more,
});

/** Every row with this id, in every project of the answer. */
const rowsOf = (projects, sessionId) => projects.flatMap(p => p.sessions).filter(s => s.sessionId === sessionId);

/** Every field of a plain terminal's row except the VALUES of name and starred. */
function assertTerminalRow(row, { sessionId, projectPath, iso = OPENED_ISO }, where) {
  assert.ok(row, `${where}: the row is there`);
  assert.equal(row.sessionId, sessionId, `${where}: sessionId`);
  assert.equal(row.summary, 'Terminal', `${where}: summary`);
  assert.equal(row.firstPrompt, '', `${where}: firstPrompt`);
  assert.equal(row.projectPath, projectPath, `${where}: projectPath`);
  assert.equal(row.archived, 0, `${where}: archived`);
  assert.equal(row.messageCount, 0, `${where}: messageCount`);
  assert.equal(row.modified, iso, `${where}: modified is the moment it was opened`);
  assert.equal(row.created, iso, `${where}: created is the moment it was opened`);
  assert.equal(row.type, 'terminal', `${where}: type`);
  // name and starred are fields of the row; what they hold is not this pin's.
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `${where}: the row's fields`);
}

test('terminal-row-name (pin): a live plain terminal\'s row has every field as today except name and starred; none for an ended terminal, a hidden folder or a missing folder; never twice', async (t) => {
  await t.test('a live plain terminal in a folder that has Claude sessions: the row, sorted with them by when it was opened', (t) => {
    boot(t, {
      dirs: [{ folder: 'f-busy', projectPath: P_BUSY }],
      cached: [claudeRow('s-claude', P_BUSY, '2026-01-01T00:00:00.000Z')],
      active: [
        ['t-old', terminal(P_BUSY, { _openedAt: Date.UTC(2025, 11, 31, 0, 0, 0, 0) })],
        ['t-new', terminal(P_BUSY)],
      ],
    });
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.equal(projects.length, 1);
    const project = projects[0];
    assert.equal(project.projectPath, P_BUSY);
    assert.equal(project.folder, encodeProjectPath(P_BUSY));
    // Newest first: the terminal opened on Jan 2, the session of Jan 1, the terminal opened on Dec 31.
    assert.deepEqual(project.sessions.map(s => s.sessionId), ['t-new', 's-claude', 't-old']);

    assertTerminalRow(project.sessions[0], { sessionId: 't-new', projectPath: P_BUSY }, 't-new');
    assertTerminalRow(project.sessions[2], { sessionId: 't-old', projectPath: P_BUSY, iso: '2025-12-31T00:00:00.000Z' }, 't-old');

    // The Claude session's own row is not turned into a terminal row.
    const claude = project.sessions[1];
    assert.equal(claude.type, undefined);
    assert.equal(claude.summary, 'a Claude session');
    assert.equal(claude.messageCount, 3);
  });

  await t.test('a live plain terminal in a folder nothing else lists: the folder is listed for it, with the one row', (t) => {
    const { settingsAsked } = boot(t, { active: [['t-1', terminal(P_ONLY)]] });
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].projectPath, P_ONLY);
    assert.equal(projects[0].folder, encodeProjectPath(P_ONLY));
    assert.equal(projects[0].sessions.length, 1);
    assertTerminalRow(projects[0].sessions[0], { sessionId: 't-1', projectPath: P_ONLY }, 't-1');
    assert.ok(settingsAsked.includes('global'), 'the hidden folders are read from the "global" setting');

    // The same with archived sessions shown.
    const withArchived = sessionCache.buildProjectsFromCache(true);
    assert.equal(withArchived.length, 1);
    assertTerminalRow(withArchived[0].sessions[0], { sessionId: 't-1', projectPath: P_ONLY }, 't-1, archived shown');
  });

  await t.test('a saved name and star for the terminal move no other field', (t) => {
    boot(t, {
      active: [['t-1', terminal(P_ONLY)]],
      meta: [['t-1', { name: 'My build shell', starred: 1 }]],
    });
    for (const showArchived of [false, true]) {
      const projects = sessionCache.buildProjectsFromCache(showArchived);
      assert.equal(projects.length, 1, `showArchived ${showArchived}`);
      assert.equal(rowsOf(projects, 't-1').length, 1, `showArchived ${showArchived}`);
      assertTerminalRow(projects[0].sessions[0], { sessionId: 't-1', projectPath: P_ONLY }, `named and starred, showArchived ${showArchived}`);
    }
  });

  await t.test('an archived mark saved under the terminal\'s id is not read: the row stays, with archived 0', (t) => {
    boot(t, {
      active: [['t-1', terminal(P_ONLY)]],
      meta: [['t-1', { archived: 1 }]],
    });
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.equal(rowsOf(projects, 't-1').length, 1, 'still listed although archived sessions are not shown');
    assertTerminalRow(projects[0].sessions[0], { sessionId: 't-1', projectPath: P_ONLY }, 'archived in the saved marks');
  });

  await t.test('no row for an ended terminal, and none is made for a live Claude session', (t) => {
    boot(t, {
      dirs: [{ folder: 'f-busy', projectPath: P_BUSY }],
      active: [
        ['t-ended', terminal(P_BUSY, { exited: true })],
        ['t-ended-elsewhere', terminal(P_ONLY, { exited: true })],
        ['s-live-claude', { isPlainTerminal: false, exited: false, projectPath: P_BUSY, _openedAt: OPENED_MS }],
        ['s-no-flag', { exited: false, projectPath: P_OTHER, _openedAt: OPENED_MS }],
      ],
    });
    const projects = sessionCache.buildProjectsFromCache(false);
    // The folder on disk is listed, empty. The ended terminal's folder and the
    // Claude session's folder, which nothing else lists, are not added.
    assert.deepEqual(projects.map(p => p.projectPath), [P_BUSY]);
    assert.equal(projects[0].sessions.length, 0);
    for (const id of ['t-ended', 't-ended-elsewhere', 's-live-claude', 's-no-flag']) {
      assert.equal(rowsOf(projects, id).length, 0, id);
    }
  });

  await t.test('no row, and no folder, for a terminal in a hidden folder', (t) => {
    boot(t, {
      dirs: [{ folder: 'f-hidden', projectPath: P_HIDDEN }, { folder: 'f-busy', projectPath: P_BUSY }],
      cached: [claudeRow('s-claude', P_BUSY, '2026-01-01T00:00:00.000Z')],
      active: [['t-hidden', terminal(P_HIDDEN)], ['t-shown', terminal(P_BUSY)]],
      hidden: [P_HIDDEN],
    });
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.deepEqual(projects.map(p => p.projectPath), [P_BUSY], 'the hidden folder is not listed');
    assert.equal(rowsOf(projects, 't-hidden').length, 0);
    // The terminal in the folder that is not hidden is untouched by it.
    assertTerminalRow(rowsOf(projects, 't-shown')[0], { sessionId: 't-shown', projectPath: P_BUSY }, 't-shown');
  });

  await t.test('no row, and no folder, for a terminal without a folder', (t) => {
    boot(t, {
      active: [
        ['t-undefined', terminal(undefined)],
        ['t-null', terminal(null)],
        ['t-empty', terminal('')],
      ],
    });
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.equal(projects.length, 0);
    for (const id of ['t-undefined', 't-null', 't-empty']) assert.equal(rowsOf(projects, id).length, 0, id);
  });

  await t.test('never twice: a row with the terminal\'s id that the folder already has is kept, and no second one is added', (t) => {
    boot(t, {
      dirs: [{ folder: 'f-busy', projectPath: P_BUSY }],
      cached: [claudeRow('t-1', P_BUSY, '2026-01-01T00:00:00.000Z', { summary: 'from the cache' })],
      active: [['t-1', terminal(P_BUSY)], ['t-2', terminal(P_BUSY)]],
    });
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.equal(projects.length, 1);
    const mine = rowsOf(projects, 't-1');
    assert.equal(mine.length, 1, 'one row for t-1');
    assert.equal(mine[0].summary, 'from the cache', 'the row that was there first');
    assert.equal(mine[0].type, undefined);
    // A second terminal in the same folder gets its own one row.
    assert.equal(rowsOf(projects, 't-2').length, 1);
    assertTerminalRow(rowsOf(projects, 't-2')[0], { sessionId: 't-2', projectPath: P_BUSY }, 't-2');
    assert.equal(projects[0].sessions.length, 2);
  });

  await t.test('never twice: asking again builds the same single row, not one more', (t) => {
    boot(t, { active: [['t-1', terminal(P_ONLY)]] });
    for (const round of [1, 2, 3]) {
      const projects = sessionCache.buildProjectsFromCache(false);
      assert.equal(projects.length, 1, `round ${round}`);
      assert.equal(projects[0].sessions.length, 1, `round ${round}`);
      assert.equal(rowsOf(projects, 't-1').length, 1, `round ${round}`);
    }
  });
});
