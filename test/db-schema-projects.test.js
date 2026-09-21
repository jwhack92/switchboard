const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
// better-sqlite3 is compiled for Electron's ABI, so plain `node` cannot load
// it (or db.js). Run every DB-touching snippet under Electron-as-Node instead.
// Under plain node, require('electron') returns the path to the binary.
const electronBin = require('electron');

function runInElectronNode(code, dataDir) {
  return spawnSync(electronBin, ['-e', code], {
    cwd: APP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

// db.js builds its schema at require() time, so each scenario loads it in a
// fresh child process pointed at an isolated data dir.
function loadDbModule(dataDir) {
  return runInElectronNode(`require(${JSON.stringify(path.join(APP_DIR, 'db.js'))})`, dataDir);
}

/** Open the scenario's DB read-only and run `body` (which prints its own JSON). */
function query(dataDir, body) {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    const out = (() => { ${body} })();
    console.log(JSON.stringify(out));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/**
 * Everything the migration is responsible for: which objects exist, the exact
 * DDL SQLite stored for each, and each table's column list. Two snapshots that
 * compare equal mean the second run changed nothing.
 */
function snapshot(dataDir) {
  return query(dataDir, `
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const cols = {};
    for (const o of objects) {
      if (o.type !== 'table') continue;
      cols[o.name] = db.prepare('PRAGMA table_info(' + o.name + ')').all().map(c => c.name);
    }
    return { objects, cols };
  `);
}

function withDataDir(prefix, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every table and index the Project View migration owns, and the columns each
// one must end up with. Written out rather than derived from db.js so a column
// silently dropped from the source fails here instead of agreeing with itself.
const REQUIRED = {
  projects: ['id', 'name', 'slug', 'root', 'status', 'sharedBranch', 'branchName',
    'defaultCwd', 'snoozedUntil', 'snoozedAt', 'created', 'modified'],
  project_folders: ['projectId', 'path', 'mode', 'sourcePath', 'branch', 'sortOrder'],
  tracks: ['id', 'projectId', 'name', 'cwd', 'cli', 'status', 'sortOrder', 'created'],
  schedules: ['id', 'name', 'projectId', 'trackId', 'cwd', 'prompt', 'every', 'atHour',
    'atMinute', 'weekday', 'cron', 'cli', 'enabled', 'catchUp', 'sourceFile',
    'lastRunAt', 'lastSessionId', 'sessionConfig', 'created'],
  legacy_schedule_imports: ['sourceFile', 'importedAt'],
  plan_links: ['id', 'projectId', 'file', 'itemText', 'sessionId', 'kind', 'at'],
};
const REQUIRED_INDEXES = [
  'idx_project_folders_path', 'idx_tracks_project', 'idx_schedules_project', 'idx_plan_links_project',
];
// Columns the migration adds to a table it does not own.
const SESSION_META_ADDED = ['projectId', 'trackId', 'formerTrackName', 'scheduleId', 'scheduledAt'];
// Phase 3's session_cache work, which this migration must leave alone.
const SESSION_CACHE_KEPT = ['sessionId', 'folder', 'projectPath', 'summary', 'firstPrompt',
  'created', 'modified', 'messageCount', 'slug', 'aiTitle', 'fileMtime',
  'customTitle', 'textContent', 'headHash', 'indexedBytes', 'firstTimestamp', 'lastTimestamp'];

test('fresh database gets every Project View table, index and column', () => {
  withDataDir('switchboard-projects-fresh-', (dir) => {
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const { objects, cols } = snapshot(dir);
    for (const [table, expected] of Object.entries(REQUIRED)) {
      assert.ok(cols[table], `table ${table} created`);
      for (const col of expected) {
        assert.ok(cols[table].includes(col), `${table}.${col} present`);
      }
    }
    const indexNames = objects.filter(o => o.type === 'index').map(o => o.name);
    for (const idx of REQUIRED_INDEXES) {
      assert.ok(indexNames.includes(idx), `index ${idx} created`);
    }
    for (const col of SESSION_META_ADDED) {
      assert.ok(cols.session_meta.includes(col), `session_meta.${col} added`);
    }
    // The tables this branch already had must come out exactly as before.
    assert.deepEqual(cols.session_cache, SESSION_CACHE_KEPT, 'session_cache untouched');
    assert.deepEqual(cols.session_meta.slice(0, 4), ['sessionId', 'name', 'starred', 'archived']);
  });
});

// A migration that is a no-op on re-run can be left in place forever. One that
// is not invites a second run to double its effect — which is exactly what
// happens when someone finds a version gate that looks inert and removes it.
test('the migration is a no-op when it runs again', () => {
  withDataDir('switchboard-projects-rerun-', (dir) => {
    assert.equal(loadDbModule(dir).status, 0);
    const first = snapshot(dir);

    // Real rows, including the one shape the migration writes to rather than
    // merely creates: a schedule carrying a legacy sourceFile, which the
    // adoption INSERT copies into the import ledger.
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT INTO projects (id, name, slug, root, created, modified) VALUES ('p1', 'P', 'p', '/r', 't', 't')").run();
      db.prepare("INSERT INTO tracks (id, projectId, name, created) VALUES ('t1', 'p1', 'T', 't')").run();
      db.prepare("INSERT INTO schedules (id, name, prompt, every, sourceFile, created) VALUES ('s1', 'S', 'go', 'day', '/x/schedule-a.md', 't')").run();
      db.prepare("INSERT INTO plan_links (projectId, file, itemText, sessionId, kind, at) VALUES ('p1', 'f', 'i', 'sess', 'start', 't')").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    assert.equal(loadDbModule(dir).status, 0);
    assert.deepEqual(snapshot(dir), first, 'second run changed no DDL');

    // The adoption INSERT ran for the first time on that second load. A third
    // load must not record the same file again.
    const afterSecond = query(dir, `return db.prepare('SELECT sourceFile FROM legacy_schedule_imports ORDER BY sourceFile').all();`);
    assert.deepEqual(afterSecond, [{ sourceFile: '/x/schedule-a.md' }]);

    assert.equal(loadDbModule(dir).status, 0);
    assert.deepEqual(snapshot(dir), first, 'third run changed no DDL');
    const counts = query(dir, `return {
      imports: db.prepare('SELECT COUNT(*) AS n FROM legacy_schedule_imports').get().n,
      projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
      tracks: db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,
      schedules: db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n,
      planLinks: db.prepare('SELECT COUNT(*) AS n FROM plan_links').get().n,
    };`);
    assert.deepEqual(counts, { imports: 1, projects: 1, tracks: 1, schedules: 1, planLinks: 1 });
  });
});

// The case a version-gated migration gets wrong. This DB already has the
// tables — an older or parallel build made them — and it has been stamped past
// every version this branch knows about, so a `if (version < N)` gate would
// skip the ALTERs entirely and every prepare() against the missing columns
// would crash at startup. Presence-checking has to repair it regardless of the
// stamp, without disturbing the rows that are already there.
test('a database with the tables but not the columns is repaired, not skipped', () => {
  withDataDir('switchboard-projects-partial-', (dir) => {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec("CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, projectId TEXT)");
      db.exec("CREATE TABLE session_cache (sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT, summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT, messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT)");
      db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '9')").run();

      // projects: no defaultCwd, no snoozedUntil, no snoozedAt, no branchName.
      db.exec(\`CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, root TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', sharedBranch INTEGER NOT NULL DEFAULT 1,
        created TEXT NOT NULL, modified TEXT NOT NULL
      )\`);
      // schedules: no sessionConfig, no catchUp, no lastSessionId.
      db.exec(\`CREATE TABLE schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, projectId TEXT, trackId TEXT, cwd TEXT,
        prompt TEXT NOT NULL, every TEXT NOT NULL, atHour INTEGER, atMinute INTEGER,
        weekday INTEGER, cron TEXT, cli TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        sourceFile TEXT, lastRunAt TEXT, created TEXT NOT NULL
      )\`);
      // tracks: no cli, no sortOrder. A column this branch does not know about
      // rides along to prove nothing rebuilds the table.
      db.exec(\`CREATE TABLE tracks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, cwd TEXT,
        status TEXT NOT NULL DEFAULT 'active', created TEXT NOT NULL, colourFromAnotherBranch TEXT
      )\`);

      db.prepare("INSERT INTO projects (id, name, slug, root, created, modified) VALUES ('p1', 'Keep me', 'keep-me', '/r', 't0', 't0')").run();
      db.prepare("INSERT INTO schedules (id, name, prompt, every, created) VALUES ('s1', 'Nightly', 'go', 'day', 't0')").run();
      db.prepare("INSERT INTO tracks (id, projectId, name, created, colourFromAnotherBranch) VALUES ('t1', 'p1', 'Main', 't0', 'teal')").run();
      db.prepare("INSERT INTO session_meta (sessionId, name, starred) VALUES ('sess', 'Named', 1)").run();
      db.prepare("INSERT INTO session_cache (sessionId, folder, fileMtime) VALUES ('sess', 'f1', 'm')").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const { cols } = snapshot(dir);
    for (const [table, expected] of Object.entries(REQUIRED)) {
      for (const col of expected) {
        assert.ok(cols[table].includes(col), `${table}.${col} added to an existing table`);
      }
    }
    for (const col of SESSION_META_ADDED) {
      assert.ok(cols.session_meta.includes(col), `session_meta.${col} added`);
    }
    assert.ok(cols.tracks.includes('colourFromAnotherBranch'), 'foreign column preserved');

    const state = query(dir, `return {
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get().value,
      project: db.prepare("SELECT id, name, slug, defaultCwd, snoozedUntil FROM projects WHERE id = 'p1'").get(),
      schedule: db.prepare("SELECT id, name, sessionConfig, catchUp, lastSessionId FROM schedules WHERE id = 's1'").get(),
      track: db.prepare("SELECT id, cli, sortOrder, colourFromAnotherBranch FROM tracks WHERE id = 't1'").get(),
      meta: db.prepare("SELECT name, starred, trackId, scheduleId FROM session_meta WHERE sessionId = 'sess'").get(),
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
    };`);

    assert.equal(state.version, '9', 'a higher foreign db_version is left alone');
    assert.deepEqual(state.project, { id: 'p1', name: 'Keep me', slug: 'keep-me', defaultCwd: null, snoozedUntil: null });
    // The NOT NULL DEFAULT columns backfill their default on the existing row.
    assert.deepEqual(state.schedule, { id: 's1', name: 'Nightly', sessionConfig: null, catchUp: 0, lastSessionId: null });
    assert.deepEqual(state.track, { id: 't1', cli: null, sortOrder: 0, colourFromAnotherBranch: 'teal' });
    assert.deepEqual(state.meta, { name: 'Named', starred: 1, trackId: null, scheduleId: null });
    // The session_cache reconciliation clears the cache only when fileMtime is
    // missing. It is present here, so the Project View work must not cost a
    // full re-index.
    assert.equal(state.cacheCount, 1, 'session_cache not cleared by the Project View migration');
  });
});

// The shape the repair path was written for, and the one it could not reach.
// A schedules table that exists without projectId is precisely what
// ensureColumns('schedules', …) is there to fix — but CREATE INDEX resolves
// its columns immediately, and idx_schedules_project over that same column
// used to be created one line earlier, so the index threw "no such column:
// projectId" and the ALTER underneath it never ran. The partial seed above
// happens to carry projectId already, which is why this passed.
test('an index never runs before the ALTER that adds its column', () => {
  withDataDir('switchboard-projects-index-order-', (dir) => {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '9')").run();
      // A pre-Project-View schedules table: no projectId, no trackId, no
      // catchUp, no sessionConfig. Every other table is absent, so only this
      // one exercises the create-then-repair-then-index order.
      db.exec(\`CREATE TABLE schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, every TEXT NOT NULL,
        atHour INTEGER, atMinute INTEGER, weekday INTEGER, cron TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, sourceFile TEXT, lastRunAt TEXT, created TEXT NOT NULL
      )\`);
      db.prepare("INSERT INTO schedules (id, name, prompt, every, sourceFile, created) VALUES ('s1', 'Nightly', 'go', 'day', '/x/schedule-a.md', 't0')").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const { objects, cols } = snapshot(dir);
    for (const col of REQUIRED.schedules) {
      assert.ok(cols.schedules.includes(col), `schedules.${col} added to the existing table`);
    }
    // The index still gets made — moving it after the ALTER must not drop it.
    const indexNames = objects.filter(o => o.type === 'index').map(o => o.name);
    for (const idx of REQUIRED_INDEXES) {
      assert.ok(indexNames.includes(idx), `index ${idx} created`);
    }

    const state = query(dir, `return {
      schedule: db.prepare("SELECT id, name, projectId, trackId, catchUp, sessionConfig FROM schedules WHERE id = 's1'").get(),
      imports: db.prepare('SELECT sourceFile FROM legacy_schedule_imports ORDER BY sourceFile').all(),
    };`);
    assert.deepEqual(state.schedule,
      { id: 's1', name: 'Nightly', projectId: null, trackId: null, catchUp: 0, sessionConfig: null });
    // The adoption INSERT reads schedules.sourceFile, so it too only works
    // once the repair has run.
    assert.deepEqual(state.imports, [{ sourceFile: '/x/schedule-a.md' }]);

    assert.deepEqual(snapshot(dir), { objects, cols }, 'a second load changes nothing');
  });
});

// The other half of the guard. Each of these tables has every column the code
// reads and a key that is not the key the code relies on, so a presence-only
// check clears all four. Two then break loudly — project_folders at the
// upsert's ON CONFLICT (projectId, path), which does not compile without the
// constraint, and plan_links by writing a NULL id — and two break silently:
// duplicate project slugs, and an import ledger whose INSERT OR IGNORE stops
// ignoring so every scan re-imports every schedule-*.md file. A guard that
// says "fine" about any of them is worse than no guard, so the module must
// refuse to load and name the table.
const WRONG_KEY_SEEDS = {
  project_folders: `CREATE TABLE project_folders (
    projectId TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'in-place',
    sourcePath TEXT, branch TEXT, sortOrder INTEGER NOT NULL DEFAULT 0
  )`,
  legacy_schedule_imports: 'CREATE TABLE legacy_schedule_imports (sourceFile TEXT, importedAt TEXT NOT NULL)',
  projects: `CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, root TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', sharedBranch INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL, modified TEXT NOT NULL
  )`,
  plan_links: `CREATE TABLE plan_links (
    id INTEGER, projectId TEXT NOT NULL, file TEXT NOT NULL, itemText TEXT NOT NULL,
    sessionId TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL
  )`,
};

for (const [table, ddl] of Object.entries(WRONG_KEY_SEEDS)) {
  test(`${table} with the right columns and the wrong key is refused by name`, () => {
    withDataDir(`switchboard-projects-key-${table}-`, (dir) => {
      const seed = runInElectronNode(`
        const Database = require('better-sqlite3');
        const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
        db.exec(${JSON.stringify(ddl)});
      `, dir);
      assert.equal(seed.status, 0, seed.stderr);

      const r = loadDbModule(dir);
      assert.notEqual(r.status, 0, 'the module must refuse to load against this database');
      assert.match(r.stderr,
        new RegExp(`Table ${table} has the expected columns but the wrong constraints`),
        r.stderr);
      // The message has to say where the file is, or the user cannot act on it.
      assert.match(r.stderr, /A database written by an incompatible build is at /);
    });
  });
}

// A column that ALTER cannot add is a genuine dead end, but the user must be
// told which one. tracks.projectId is NOT NULL, so ensureColumns cannot add
// it; before the reorder, CREATE INDEX idx_tracks_project got there first and
// the failure read "no such column: projectId" with no table named.
test('an unaddable missing column is reported against its table, not by an index', () => {
  withDataDir('switchboard-projects-unaddable-', (dir) => {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL)');
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.notEqual(r.status, 0, 'the module must refuse to load against this database');
    assert.match(r.stderr, /Table tracks is missing projectId, which ALTER cannot add/, r.stderr);
  });
});
