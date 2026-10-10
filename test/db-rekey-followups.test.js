'use strict';
// The SQL behind the four database follow-ups of a re-key (session-transitions.js rekey()):
// copySessionAssignment, rekeyPlanLinks, rekeyScheduleSession for every kind, copyStar for a /clear.
// db.js loads only under Electron's ABI, so each test runs its body in the Electron binary run as Node,
// on a data folder of its own (the pattern of test/db-schema-projects.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const electronBin = require('electron');

/** Runs `body` with `db` = the real db.js on a fresh data folder; answers what it returns. */
function inDb(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-db-rekey-'));
  try {
    const code = `const db = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      const out = (() => { ${body} })();
      db.closeDb();
      console.log(JSON.stringify(out));`;
    const r = spawnSync(electronBin, ['-e', code], {
      cwd: APP_DIR, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('db re-key follow-ups: copyStar stars the new id when the old id is starred and the new one is not, and changes nothing otherwise', () => {
  const out = inDb(`
    db.toggleStar('old-1');
    const a = db.copyStar('old-1', 'new-1');            // old starred, new has no row
    db.toggleStar('old-2'); db.setName('new-2', 'named');
    const b = db.copyStar('old-2', 'new-2');            // new has a row, not starred
    db.toggleStar('old-3'); db.toggleStar('new-3');
    const c = db.copyStar('old-3', 'new-3');            // both starred: must not toggle the new one off
    const d = db.copyStar('old-4', 'new-4');            // old has no row
    db.setName('old-5', 'named');
    const e = db.copyStar('old-5', 'new-5');            // old has a row, not starred
    const star = (id) => { const m = db.getMeta(id); return m ? m.starred : null; };
    return { a, b, c, d, e,
      stars: ['old-1', 'new-1', 'old-2', 'new-2', 'old-3', 'new-3', 'old-4', 'new-4', 'old-5', 'new-5'].map(star),
      name: db.getMeta('new-2').name };
  `);
  assert.deepEqual(out, { a: true, b: true, c: false, d: false, e: false, stars: [1, 1, 1, 1, 1, 1, null, null, 0, null], name: 'named' });
});

test('db re-key follow-ups: copySessionAssignment gives the new id the project and track of the old id, which keeps its own', () => {
  const out = inDb(`
    db.setSessionAssignment('old-1', 'proj-1', 'track-1');
    const a = db.copySessionAssignment('old-1', 'new-1');
    const b = db.copySessionAssignment('old-2', 'new-2');   // nothing filed
    const filed = (id) => { const m = db.getMeta(id); return m ? [m.projectId, m.trackId] : null; };
    return { a, b, rows: [filed('old-1'), filed('new-1'), filed('new-2')] };
  `);
  assert.deepEqual(out, { a: true, b: false, rows: [['proj-1', 'track-1'], ['proj-1', 'track-1'], null] });
});

test('db re-key follow-ups: rekeyPlanLinks moves every plan link of the old id to the new id and no other', () => {
  const out = inDb(`
    const link = (itemText, sessionId, at) => db.insertPlanLink({ projectId: 'proj-1', file: 'PLAN.md', itemText, sessionId, kind: 'started', at });
    link('first', 'old-1', '2026-01-01T00:00:01.000Z');
    link('second', 'old-1', '2026-01-01T00:00:02.000Z');
    link('third', 'other', '2026-01-01T00:00:03.000Z');
    const changed = db.rekeyPlanLinks('old-1', 'new-1');
    return { changed, links: db.listPlanLinks('proj-1').map((l) => [l.itemText, l.sessionId]) };
  `);
  assert.deepEqual(out, { changed: 2, links: [['first', 'new-1'], ['second', 'new-1'], ['third', 'other']] });
});

test("db re-key follow-ups: rekeyScheduleSession moves the schedule's last session and the session's schedule link to the new id", () => {
  const out = inDb(`
    db.insertSchedule({ id: 'sched-1', name: 'Nightly', prompt: 'run', every: 'day', created: '2026-01-01T00:00:00.000Z' });
    db.recordScheduleRun('sched-1', 'old-1', '2026-01-02T00:00:00.000Z');
    db.rekeyScheduleSession('old-1', 'new-1');
    const link = (id) => { const m = db.getMeta(id); return m ? [m.scheduleId, m.scheduledAt] : null; };
    return { last: db.getSchedule('sched-1').lastSessionId, old: link('old-1'), now: link('new-1') };
  `);
  assert.deepEqual(out, { last: 'new-1', old: [null, null], now: ['sched-1', '2026-01-02T00:00:00.000Z'] });
});
