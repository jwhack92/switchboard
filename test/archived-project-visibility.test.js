const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

// buildProjectsFromCache walks PROJECTS_DIR to pick up project directories that
// have no sessions yet. That walk used to re-add projects the archive filter had
// just removed: archiving the last session in a project left an empty phantom
// entry in the sidebar, because the session's .jsonl (and so its directory)
// outlives the archive flag.

function setup({ sessions, dirs }) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-archive-'));
  for (const d of dirs) fs.mkdirSync(path.join(projectsDir, d.folder), { recursive: true });

  const folderMeta = new Map(dirs.map(d => [d.folder, { folder: d.folder, projectPath: d.projectPath, indexMtimeMs: 1 }]));
  const meta = new Map(sessions.map(s => [s.sessionId, { sessionId: s.sessionId, archived: s.archived ? 1 : 0, starred: 0, name: null }]));
  const cached = sessions.map(s => ({
    sessionId: s.sessionId, folder: s.folder, projectPath: s.projectPath,
    summary: '', firstPrompt: '', created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z', messageCount: 1, slug: null, aiTitle: null,
  }));

  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    broadcast: () => {},
    log: console,
    db: {
      deleteCachedFolder() {}, getCachedByFolder() { return []; },
      getCachedSession() { return null; },
      upsertCachedSessions() {}, deleteCachedSession() {},
      deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
      setFolderMeta() {}, getAllFolderMeta() { return folderMeta; },
      getAllMeta() { return meta; }, getAllCached() { return cached; },
      getSetting() { return {}; }, getMeta() { return null; }, setName() {},
    },
  });
  return projectsDir;
}

const P_ARCHIVED = 'C:\repo\archived-only';
const P_LIVE = 'C:\repo\live';
const P_FRESH = 'C:\repo\never-used';

test('archiving the only session in a project removes the project from the sidebar', () => {
  const dir = setup({
    sessions: [{ sessionId: 's1', folder: 'f-archived', projectPath: P_ARCHIVED, archived: true }],
    dirs: [{ folder: 'f-archived', projectPath: P_ARCHIVED }],
  });
  try {
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.equal(projects.find(p => p.projectPath === P_ARCHIVED), undefined,
      'project whose only session is archived must not appear');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the same project is still listed when showing archived sessions', () => {
  const dir = setup({
    sessions: [{ sessionId: 's1', folder: 'f-archived', projectPath: P_ARCHIVED, archived: true }],
    dirs: [{ folder: 'f-archived', projectPath: P_ARCHIVED }],
  });
  try {
    const projects = sessionCache.buildProjectsFromCache(true);
    const p = projects.find(x => x.projectPath === P_ARCHIVED);
    assert.ok(p, 'archived view must still show the project');
    assert.equal(p.sessions.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a project directory with no sessions at all is still shown', () => {
  // This is the case the directory walk exists for — it must not regress.
  const dir = setup({
    sessions: [],
    dirs: [{ folder: 'f-fresh', projectPath: P_FRESH }],
  });
  try {
    const projects = sessionCache.buildProjectsFromCache(false);
    const p = projects.find(x => x.projectPath === P_FRESH);
    assert.ok(p, 'a project with no sessions yet must still be listed');
    assert.equal(p.sessions.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('archiving one of several sessions leaves the project visible', () => {
  const dir = setup({
    sessions: [
      { sessionId: 's1', folder: 'f-live', projectPath: P_LIVE, archived: true },
      { sessionId: 's2', folder: 'f-live', projectPath: P_LIVE, archived: false },
    ],
    dirs: [{ folder: 'f-live', projectPath: P_LIVE }],
  });
  try {
    const projects = sessionCache.buildProjectsFromCache(false);
    const p = projects.find(x => x.projectPath === P_LIVE);
    assert.ok(p, 'project with a surviving session must remain');
    assert.deepEqual(p.sessions.map(s => s.sessionId), ['s2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
