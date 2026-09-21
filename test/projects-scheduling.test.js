// projects.js scheduling: the gate as PRODUCTION runs it.
//
// test/schedule-dst-kinds.test.js pins public/schedule-time.js's
// `createFireGate` — the per-kind fire rule, the window, the slot memo — and
// pins it thoroughly. It proved nothing about the app, because projects.js
// kept a memo of its own and `dueSchedules` / `missedSchedules` consulted
// that one. The tested code was not the run code. This file asserts the same
// DST outcomes one layer up, through `projects.dueSchedules`, which is what
// main.js's ticker actually calls (main.js:2525), so the two can no longer
// diverge without a red test.
//
// It also pins the two places where the POLICY around the gate lives only
// here and so cannot be covered from schedule-time at all:
//
//   * the startup catch-up (`missedSchedules`, main.js:2562) and the ticker
//     share one gate, and the catch-up READS it before writing to it. It used
//     to only write, and was saved from launching a second session for an
//     occurrence the ticker had already fired purely by usually getting there
//     first — which main does not guarantee. Both paths wait for a window
//     (main.js:2521, 2554) and the catch-up re-checks only every 5s
//     (main.js:2549), so a ticker minute boundary can land inside that gap.
//   * a caller that passes its own `since` window is asking a question, not
//     closing a tick, and must not move the clock the real ticker's next
//     window starts from.
//
// Plain node, not Electron-as-Node: projects.js takes its database through
// `init(ctx)` (projects.js:69) and requires no native module, so a fake db is
// enough and there is no better-sqlite3 to load. A child process is still
// needed for the DST half, for the reason the sibling suite gives: TZ has to
// be set before the process starts, and guarding those assertions with "skip
// unless the local zone happens to fall back" would leave them unrun on CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projects = require('../projects');

const MIN = 60 * 1000;
const PROJECTS_MODULE = path.join(__dirname, '..', 'projects.js');

// --- A schedule row, and a database that holds nothing else ---
//
// Folder schedules (projectId null) are used throughout: `schedulePausedReason`
// returns null for an enabled one without touching projects or tracks
// (projects.js:1279), which keeps these cases about timing and nothing else.

/** A schedules-table row (db.js:304), with the timing fields overridden per case. */
function mkRow(extra) {
  return {
    id: 'sched', name: 'a schedule', prompt: 'do the thing',
    projectId: null, trackId: null, cwd: '/tmp/anywhere',
    every: 'hour', atHour: null, atMinute: null, weekday: null, cron: null,
    cli: null, enabled: 1, catchUp: 0,
    sourceFile: null, lastRunAt: null, lastSessionId: null, sessionConfig: null,
    created: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** The whole database projects.js's scheduling reaches for. */
function fakeDb(rows) {
  return {
    // Copied out, so nothing under test can mutate the fixture in place.
    listSchedules: () => rows.map(r => ({ ...r })),
    getSchedule: (id) => { const r = rows.find(x => x.id === id); return r ? { ...r } : null; },
    deleteSchedule: (id) => { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
    getProject: () => null,
    getTrack: () => null,
    updateProject: () => {},
  };
}

function withRows(rows) {
  projects.init({ db: fakeDb(rows), log: {} });
  projects.resetScheduleFireMemo();
}

// --- The DST half, in a child pinned to America/Los_Angeles ---

// The two helpers above are injected by source rather than restated, so the
// child and the in-process cases cannot be testing different rows.
const PROBE = `
const projects = require(${JSON.stringify(PROJECTS_MODULE)});
${mkRow}
${fakeDb}
const iso = (ms) => new Date(ms).toISOString();

/**
 * A healthy ticker: projects.dueSchedules once a minute, on the minute, with
 * nothing else touching the gate. Records the tick instants that launched
 * something; ticks are minute-aligned, so each one IS the due minute.
 */
function tickThrough(row, fromIso, toIso) {
  projects.init({ db: fakeDb([row]), log: {} });
  projects.resetScheduleFireMemo();
  const fired = [];
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 60000) {
    if (projects.dueSchedules(new Date(t)).length) fired.push(iso(t));
  }
  return fired;
}

/** A ticker under load: the tick for 08:30Z never happens. */
function driftedTicker(row) {
  projects.init({ db: fakeDb([row]), log: {} });
  projects.resetScheduleFireMemo();
  const fired = [];
  for (const at of ['2026-11-01T08:29:30Z', '2026-11-01T08:31:10Z', '2026-11-01T08:32:05Z']) {
    if (projects.dueSchedules(new Date(Date.parse(at))).length) fired.push(iso(Date.parse(at)));
  }
  return fired;
}

const WINDOW = ['2026-11-01T07:00:00Z', '2026-11-01T10:00:00Z']; // 00:00-02:00 local, both passes

process.stdout.write(JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  wall: [new Date(Date.parse('2026-11-01T08:30:00Z')).getHours(),
         new Date(Date.parse('2026-11-01T09:30:00Z')).getHours()],
  fired: {
    cron: tickThrough(mkRow({ id: 'cron-0130', every: 'cron', cron: '30 1 * * *' }), ...WINDOW),
    cronTwice: tickThrough(mkRow({ id: 'cron-0100-0130', every: 'cron', cron: '0,30 1 * * *' }), ...WINDOW),
    daily: tickThrough(mkRow({ id: 'daily-0130', every: 'day', atHour: 1, atMinute: 30 }), ...WINDOW),
    weekly: tickThrough(mkRow({ id: 'weekly-0130', every: 'week', atHour: 1, atMinute: 30, weekday: 0 }), ...WINDOW),
    half: tickThrough(mkRow({ id: 'every-30m', every: '30m' }), ...WINDOW),
    hourly: tickThrough(mkRow({ id: 'hourly-at-30', every: 'hour', atMinute: 30 }), ...WINDOW),
  },
  drifted: driftedTicker(mkRow({ id: 'daily-0130', every: 'day', atHour: 1, atMinute: 30 })),
}));
`;

let probe;
try {
  probe = JSON.parse(execFileSync(process.execPath, ['-e', PROBE], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    encoding: 'utf8',
  }));
} catch (err) {
  throw new Error(`projects scheduling probe failed: ${err.stderr || err.message}`);
}

test('the probe really is in a zone that lives 01:30 twice on 2026-11-01', () => {
  assert.equal(probe.tz, 'America/Los_Angeles');
  assert.deepEqual(probe.wall, [1, 1], '08:30Z and 09:30Z both read as local 01:xx');
});

test('a cron entry in the repeated hour fires ONCE through projects.dueSchedules', () => {
  // The whole point of the per-kind key, exercised where it is spent: the
  // 09:30Z pass reads local 01:30 again, and a calendar kind means that clock
  // reading, once. Two fires here are two unattended, billed sessions.
  assert.deepEqual(probe.fired.cron, ['2026-11-01T08:30:00.000Z']);
});

test('day and week entries in the repeated hour fire ONCE too', () => {
  assert.deepEqual(probe.fired.daily, ['2026-11-01T08:30:00.000Z']);
  assert.deepEqual(probe.fired.weekly, ['2026-11-01T08:30:00.000Z'],
    '2026-11-01 is a Sunday, so the weekly entry is due that day');
});

test('a cron that fires twice an hour is suppressed on BOTH of its repeats', () => {
  // The memo must hold a SET of slots per schedule. Holding only the last one
  // — which is what projects.js used to keep — this entry walks 01:00 → 01:30
  // through the first pass, so when 01:00 comes round again the memo says
  // 01:30, it misses, and the whole repeated hour fires a second time.
  assert.deepEqual(probe.fired.cronTwice, [
    '2026-11-01T08:00:00.000Z',
    '2026-11-01T08:30:00.000Z',
  ]);
});

test('a 30m entry across the repeated hour fires TWICE', () => {
  // The other direction, and just as load-bearing: an interval kind names a
  // spacing, the repeated hour is two real hours, and suppressing the second
  // pass would silently drop an hour of runs.
  assert.deepEqual(probe.fired.half, [
    '2026-11-01T07:00:00.000Z',
    '2026-11-01T07:30:00.000Z',
    '2026-11-01T08:00:00.000Z',
    '2026-11-01T08:30:00.000Z', // 01:30 PDT
    '2026-11-01T09:00:00.000Z', // 01:00 PST — the repeat, an hour of real time later
    '2026-11-01T09:30:00.000Z', // 01:30 PST
    '2026-11-01T10:00:00.000Z',
  ]);
});

test('an hourly entry fires in both passes of the repeated hour', () => {
  assert.deepEqual(probe.fired.hourly, [
    '2026-11-01T07:30:00.000Z',
    '2026-11-01T08:30:00.000Z', // 01:30 PDT
    '2026-11-01T09:30:00.000Z', // 01:30 PST
  ]);
});

test('a tick the machine skipped still fires what that minute owed', () => {
  // The window half of the gate, also reaching production: without it the
  // 08:30Z minute is simply never examined and a daily task does not run.
  assert.deepEqual(probe.drifted, ['2026-11-01T08:31:10.000Z'],
    'the late tick pays the minute it stepped over, once');
});

// --- The catch-up and the ticker share one gate (the double launch) ---

// Local wall-clock anchors, so due-ness does not depend on the runner's UTC
// offset: a zone at :45 would read 12:30Z as minute 15 and no 30m schedule
// would be due at all.
const HALF_PAST = new Date(2026, 5, 15, 12, 30, 0, 0).getTime(); // a Monday, local
const NOON = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();

function catchUpRow() {
  return mkRow({
    id: 'catch-me',
    every: '30m',
    catchUp: 1,
    // Closed for two hours: there is a missed occurrence to catch up on.
    created: new Date(HALF_PAST - 2 * 60 * 60 * 1000).toISOString(),
  });
}

test('the catch-up does not re-launch an occurrence the ticker just fired', () => {
  // THE BUG. main starts the ticker immediately and the catch-up ~20s later
  // (main.js startScheduleTicker), so both see the same minute. The catch-up
  // burned the slot but never read it, and `lastRunAt` cannot separate them:
  // the session it returns has not launched yet, so nothing is recorded.
  withRows([catchUpRow()]);
  assert.deepEqual(projects.dueSchedules(new Date(HALF_PAST)), ['catch-me'],
    'the ticker fires the 12:30 occurrence');
  assert.deepEqual(projects.missedSchedules(new Date(HALF_PAST + 20 * 1000)), [],
    'and the catch-up 20s later must not fire it again');
});

test('the reverse order is one launch too — the fix is not an ordering', () => {
  // This direction already worked, by the catch-up burning the slot. It is
  // pinned so that reading the gate cannot be mistaken for replacing the
  // write: both halves are needed, one per order.
  withRows([catchUpRow()]);
  assert.deepEqual(projects.missedSchedules(new Date(HALF_PAST + 20 * 1000)), ['catch-me'],
    'the catch-up fires the missed occurrence');
  assert.deepEqual(projects.dueSchedules(new Date(HALF_PAST + 40 * 1000)), [],
    'and the tick in the same minute must not double it');
});

test('a catch-up the ticker has NOT fired still runs', () => {
  // The guard must not swallow the feature it guards. The first tick has no
  // previous window, so it looks only at its own minute and never pays 12:30
  // — which is exactly the case the opt-in catch-up exists for.
  withRows([catchUpRow()]);
  assert.deepEqual(projects.dueSchedules(new Date(HALF_PAST + 5 * MIN)), [],
    'a tick at 12:35: nothing due in that minute, and no window behind it');
  assert.deepEqual(projects.missedSchedules(new Date(HALF_PAST + 5 * MIN + 20 * 1000)), ['catch-me'],
    'so the missed 12:30 is still owed and the catch-up pays it');
});

test('a busy predecessor skips the run and still burns its slot', () => {
  // Upstream drops a run whose previous session is still working rather than
  // queueing it. Burning the slot is what keeps that a drop: unburned, the
  // minute is still inside a later window and the run arrives late instead.
  const rows = [mkRow({ id: 'busy-one', every: 'hour', atMinute: 0, lastSessionId: 'sess-1' })];
  withRows(rows);
  assert.deepEqual(projects.dueSchedules(new Date(NOON), (id) => id === 'sess-1'), [],
    'skipped, not launched');
  assert.deepEqual(
    projects.dueSchedules(new Date(NOON + 3 * MIN), () => false, { since: NOON - MIN }),
    [],
    'and a later look over the same minute finds the slot spent',
  );
});

// --- A caller's own window is a question, not a tick ---

test('an explicit `since` does not move the clock the real ticker ticks from', () => {
  const rows = [mkRow({ id: 'hourly', every: 'hour', atMinute: 0 })];
  withRows(rows);
  assert.deepEqual(projects.dueSchedules(new Date(NOON - MIN)), [],
    'a real tick at 11:59 — nothing due, but this is where the window now starts');
  assert.deepEqual(
    projects.dueSchedules(new Date(NOON + 30 * MIN), () => false, { since: NOON + 25 * MIN }),
    [],
    'a caller asks about 12:25-12:30 of its own',
  );
  assert.deepEqual(projects.dueSchedules(new Date(NOON)), ['hourly'],
    'the ticker still owes 12:00: the question must not have consumed the window');
});

test('an explicit window still answers to the shared memo', () => {
  const rows = [mkRow({ id: 'reused', every: 'hour', atMinute: 0 })];
  withRows(rows);
  const reask = () => projects.dueSchedules(new Date(NOON + 3 * MIN), () => false, { since: NOON - MIN });
  assert.deepEqual(projects.dueSchedules(new Date(NOON)), ['reused'], 'fired at 12:00');
  assert.deepEqual(reask(), [], 'asking again over that minute does not fire it twice');

  // And deleting the row forgets its slots, so an id reused by a new schedule
  // is not suppressed by its predecessor's.
  assert.deepEqual(projects.deleteSchedule('reused'), { ok: true });
  rows.push(mkRow({ id: 'reused', every: 'hour', atMinute: 0 }));
  assert.deepEqual(reask(), ['reused'], 'a recreated schedule starts with a clean memo');
});
