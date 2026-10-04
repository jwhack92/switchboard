// A schedule-*.md arrives with whatever repository a project folder holds, and
// it names its own permission mode, tools and add-dirs. projects.js imports it
// at app start, so the import must not leave it running: every imported file
// arrives switched off and fires only after someone turns it on.
//
// Plain node with a fake database, as test/projects-scheduling.test.js does:
// projects.js takes its database through init(ctx).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const projects = require('../projects');
const { parseFrontmatter } = require('../schedule-runner');

// Any folder that exists: importLegacySchedules skips a missing one.
const PROJECT_DIR = os.tmpdir();

/** What scanSchedules pushes for one file (schedule-runner.js scanSchedules). */
function scanned(name, lines, extra = {}) {
  const file = `schedule-${name}.md`;
  const { meta, body } = parseFrontmatter('---\n' + lines.join('\n') + '\n---\nDo the thing.\n');
  return {
    file, filePath: path.join(PROJECT_DIR, '.claude', 'commands', file),
    projectPath: PROJECT_DIR, folder: 'a-folder',
    name: meta.name || file, cron: meta.cron, slug: meta.slug || name,
    cli: meta.cli || {}, prompt: body,
    ...extra,
  };
}

/**
 * The part of db.js the import and the ticker reach for. importLegacySchedule
 * stores what db.js insertSchedule stores: `enabled` is 0 only for an explicit
 * false, and a file already in the ledger is not inserted again.
 */
function fakeDb() {
  const rows = [];
  const ledger = new Set();
  return {
    rows,
    getImportedScheduleFiles: () => [...ledger],
    importLegacySchedule: (row) => {
      if (ledger.has(row.sourceFile)) return false;
      ledger.add(row.sourceFile);
      rows.push({
        ...row,
        enabled: row.enabled === false ? 0 : 1, catchUp: row.catchUp ? 1 : 0,
        sessionConfig: JSON.stringify(row.sessionConfig || {}),
        lastRunAt: null, lastSessionId: null,
      });
      return true;
    },
    listSchedules: () => rows.map(r => ({ ...r })),
    getSchedule: (id) => { const r = rows.find(x => x.id === id); return r ? { ...r } : null; },
    getProject: () => null,
    getTrack: () => null,
    updateProject: () => {},
  };
}

function importInto(db, files) {
  projects.init({ db, log: {} });
  projects.resetScheduleFireMemo();
  return projects.importLegacySchedules(files);
}

test('a schedule file is imported switched off', () => {
  const db = fakeDb();
  const count = importInto(db, [scanned('daily', ['name: Daily report', 'cron: 0 9 * * *'])]);
  assert.equal(count, 1);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].name, 'Daily report');
  assert.equal(db.rows[0].enabled, 0);
  assert.equal(projects.schedulePausedReason(db.rows[0]), 'off');
});

test('the file keeps the settings it names, but they do not run by themselves', () => {
  const db = fakeDb();
  importInto(db, [scanned('hostile', [
    'name: x', 'cron: * * * * *',
    'cli:', '  permission-mode: bypassPermissions', '  allowed-tools: Bash', '  add-dirs: C:\\Users',
  ])]);
  const config = JSON.parse(db.rows[0].sessionConfig).claude;
  assert.equal(config.permissionMode, 'bypassPermissions');
  assert.equal(config.allowedTools, 'Bash');
  assert.equal(config.addDirs, 'C:\\Users');
  assert.equal(db.rows[0].enabled, 0);
});

test('a scanned entry cannot switch itself on', () => {
  const db = fakeDb();
  importInto(db, [
    scanned('a', ['name: a', 'cron: 0 9 * * *', 'enabled: true'], { enabled: true }),
    scanned('b', ['name: b', 'cron: 0 9 * * *'], { enabled: 'true' }),
  ]);
  assert.deepEqual(db.rows.map(r => r.enabled), [0, 0]);
});

test('an imported schedule does not come due until it is turned on', () => {
  const db = fakeDb();
  importInto(db, [scanned('minutely', ['name: every minute', 'cron: * * * * *'])]);
  // A whole minute after the import, so the row exists before the minute it is asked about.
  const minute = new Date();
  minute.setSeconds(0, 0);
  minute.setMinutes(minute.getMinutes() + 5);

  assert.deepEqual(projects.dueSchedules(minute), [], 'switched off: the ticker gets nothing');

  // What "Turn on" in the schedule list stores.
  db.rows[0].enabled = 1;
  projects.resetScheduleFireMemo();
  assert.deepEqual(projects.dueSchedules(minute), [db.rows[0].id], 'the same minute fires once it is on');
});

test('a file that was already imported is not imported again', () => {
  const db = fakeDb();
  const file = scanned('once', ['name: once', 'cron: 0 9 * * *']);
  assert.equal(importInto(db, [file]), 1);
  assert.equal(projects.importLegacySchedules([file]), 0);
  assert.equal(db.rows.length, 1);
});
