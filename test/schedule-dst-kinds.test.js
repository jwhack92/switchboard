const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  CALENDAR_KINDS, INTERVAL_KINDS, EVERY_VALUES, PRESETS,
  MAX_TICK_CATCHUP_MINUTES, MEMO_RETENTION_MS,
  dueThisMinute, dueSince, fireSlotKey, localSlotKey, utcSlotKey, createFireGate,
} = require('../public/schedule-time');

// The DST rule, per kind (schedule-time.js CALENDAR_KINDS / INTERVAL_KINDS).
//
// 2837596 closed a real double-fire: cronMatches reads local getHours()/
// getMinutes() and kept no memo, so on 2026-11-01 in America/Los_Angeles —
// where local 01:00-01:59 is lived through twice, 60 real minutes apart —
// `cron: 30 1 * * *` matched both 08:30Z and 09:30Z and billed two unattended
// runs. Its fix, localSlotKey, is a wall-clock-minute memo.
//
// Upstream d4a51aa brings kinds that fork's scheduler never had: 15m, 30m and
// hour. Those name a SPACING, not a clock reading, so in the repeated hour
// they SHOULD fire twice — the two fires are an hour of real time apart. The
// 2837596 memo applied to them would silently eat an hour of runs.
//
// So both directions are pinned below, and both must stay pinned:
//   a cron / day / weekdays / week entry in the repeated hour fires ONCE
//   a 15m / 30m / hour entry in the repeated hour fires TWICE
//
// test/schedule-dst.test.js stays as the record for the old file-based
// schedule-runner, which is untouched; the parity check below keeps its
// localSlotKey and this module's from drifting apart.

// --- The real 2026-11-01 boundary, in a child process pinned to Pacific ---
//
// The existing suite guards its boundary tests with "skip unless the local
// zone happens to fall back here", which means the fix is unverified on a UTC
// CI box — exactly where nobody would notice it break. Forcing TZ in a child
// makes these assertions run everywhere. `probe` is spawned once, at load.

const MODULE = path.join(__dirname, '..', 'public', 'schedule-time.js');
const RUNNER = path.join(__dirname, '..', 'schedule-runner.js');

const PROBE = `
const st = require(${JSON.stringify(MODULE)});
const runner = require(${JSON.stringify(RUNNER)});
const iso = (ms) => new Date(ms).toISOString();
const FIRST = Date.parse('2026-11-01T08:30:00Z');   // 01:30 PDT
const SECOND = Date.parse('2026-11-01T09:30:00Z');  // 01:30 PST, the repeat

const CRON = { id: 'cron-0130', every: 'cron', cron: '30 1 * * *' };
const CRON_TWICE = { id: 'cron-0100-0130', every: 'cron', cron: '0,30 1 * * *' };
const DAILY = { id: 'daily-0130', every: 'day', atHour: 1, atMinute: 30 };
const WEEKLY = { id: 'weekly-0130', every: 'week', atHour: 1, atMinute: 30, weekday: 0 };
const HALF = { id: 'every-30m', every: '30m' };
const HOURLY = { id: 'hourly-at-30', every: 'hour', atMinute: 30 };

/** A healthy ticker: one tick per minute, each closing its window. */
function tickThrough(schedule, fromIso, toIso) {
  const gate = st.createFireGate();
  const fired = [];
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 60000) {
    const dueAt = gate.due(schedule, t);
    if (dueAt !== null) { gate.markFired(schedule, dueAt); fired.push(iso(dueAt)); }
    gate.endTick(t);
  }
  return fired;
}

/** A ticker under load: the tick for 08:30Z never happens. */
function driftedTicker(schedule) {
  const gate = st.createFireGate();
  const fired = [];
  for (const at of ['2026-11-01T08:29:30Z', '2026-11-01T08:31:10Z', '2026-11-01T08:32:05Z']) {
    const nowMs = Date.parse(at);
    const dueAt = gate.due(schedule, nowMs);
    if (dueAt !== null) { gate.markFired(schedule, dueAt); fired.push(iso(dueAt)); }
    gate.endTick(nowMs);
  }
  return fired;
}

/** Two ticks inside one minute — a resumed machine, or plain timer jitter. */
function twiceInOneMinute(schedule) {
  const gate = st.createFireGate();
  const fired = [];
  for (const at of ['2026-11-01T08:30:02Z', '2026-11-01T08:30:47Z']) {
    const nowMs = Date.parse(at);
    const dueAt = gate.due(schedule, nowMs);
    if (dueAt !== null) { gate.markFired(schedule, dueAt); fired.push(iso(dueAt)); }
    gate.endTick(nowMs);
  }
  return fired;
}

const WINDOW = ['2026-11-01T07:00:00Z', '2026-11-01T10:00:00Z']; // 00:00-02:00 local, both passes

process.stdout.write(JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  wall: {
    first: [new Date(FIRST).getHours(), new Date(FIRST).getMinutes()],
    second: [new Date(SECOND).getHours(), new Date(SECOND).getMinutes()],
    apartMinutes: (SECOND - FIRST) / 60000,
  },
  dueAtBoth: {
    cron: [st.dueThisMinute(CRON, new Date(FIRST)), st.dueThisMinute(CRON, new Date(SECOND))],
    half: [st.dueThisMinute(HALF, new Date(FIRST)), st.dueThisMinute(HALF, new Date(SECOND))],
  },
  keys: {
    cron: [st.fireSlotKey(CRON, FIRST), st.fireSlotKey(CRON, SECOND)],
    daily: [st.fireSlotKey(DAILY, FIRST), st.fireSlotKey(DAILY, SECOND)],
    half: [st.fireSlotKey(HALF, FIRST), st.fireSlotKey(HALF, SECOND)],
    hourly: [st.fireSlotKey(HOURLY, FIRST), st.fireSlotKey(HOURLY, SECOND)],
  },
  fired: {
    cron: tickThrough(CRON, ...WINDOW),
    cronTwice: tickThrough(CRON_TWICE, ...WINDOW),
    daily: tickThrough(DAILY, ...WINDOW),
    weekly: tickThrough(WEEKLY, ...WINDOW),
    half: tickThrough(HALF, ...WINDOW),
    hourly: tickThrough(HOURLY, ...WINDOW),
  },
  drifted: { daily: driftedTicker(DAILY), half: driftedTicker(HALF) },
  twiceInOneMinute: { daily: twiceInOneMinute(DAILY), half: twiceInOneMinute(HALF) },
  afterLongGap: (() => {
    // Three hours of no ticks, then one: the clamp must make that one fire,
    // not six. (The opt-in catchUp path is what covers a real absence.)
    const gate = st.createFireGate();
    gate.endTick(Date.parse('2026-11-01T05:30:00Z'));
    const nowMs = Date.parse('2026-11-01T08:30:00Z');
    const dueAt = gate.due(HALF, nowMs);
    return dueAt === null ? null : iso(dueAt);
  })(),
  parity: {
    runnerFirst: runner.localSlotKey(new Date(FIRST)),
    runnerSecond: runner.localSlotKey(new Date(SECOND)),
    mineFirst: st.localSlotKey(new Date(FIRST)),
    mineSecond: st.localSlotKey(new Date(SECOND)),
  },
  springForward: {
    // 2026-03-08: local 02:00-02:59 never happens, so a 02:30 daily never
    // fires that day. Standard cron behaviour, asserted so a change to the
    // fire key cannot quietly alter it.
    fired: tickThrough({ id: 'daily-0230', every: 'day', atHour: 2, atMinute: 30 },
      '2026-03-08T09:00:00Z', '2026-03-08T12:00:00Z'),
  },
}));
`;

let probe;
try {
  probe = JSON.parse(execFileSync(process.execPath, ['-e', PROBE], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    encoding: 'utf8',
  }));
} catch (err) {
  throw new Error(`DST probe failed: ${err.stderr || err.message}`);
}

test('the probe really is in a zone that repeats a wall-clock minute', () => {
  assert.equal(probe.tz, 'America/Los_Angeles');
  assert.deepEqual(probe.wall.first, [1, 30], '08:30Z reads as local 01:30');
  assert.deepEqual(probe.wall.second, [1, 30], '09:30Z reads as local 01:30 as well');
  assert.equal(probe.wall.apartMinutes, 60, 'a real hour apart');
});

test('both instants look due to dueThisMinute — the memo is what decides', () => {
  assert.deepEqual(probe.dueAtBoth.cron, [true, true]);
  assert.deepEqual(probe.dueAtBoth.half, [true, true]);
});

test('calendar kinds key on the wall-clock minute, so the repeat collapses', () => {
  assert.equal(probe.keys.cron[0], probe.keys.cron[1], 'cron: one slot');
  assert.equal(probe.keys.daily[0], probe.keys.daily[1], 'day: one slot');
  assert.match(probe.keys.cron[0], /^L/, 'calendar keys are local-keyed');
});

test('interval kinds key on the absolute minute, so the repeat stays two', () => {
  assert.notEqual(probe.keys.half[0], probe.keys.half[1], '30m: two slots');
  assert.notEqual(probe.keys.hourly[0], probe.keys.hourly[1], 'hour: two slots');
  assert.match(probe.keys.half[0], /^U/, 'interval keys are UTC-keyed');
});

test('a cron entry in the repeated hour fires ONCE', () => {
  assert.deepEqual(probe.fired.cron, ['2026-11-01T08:30:00.000Z'],
    'the PST 01:30 is the same wall-clock slot and must be suppressed');
});

test('a cron that fires twice an hour is suppressed on BOTH of its repeats', () => {
  // The slot memo has to be a set. Holding only the last slot, this entry
  // walks 01:00 → 01:30 through the first pass, so on the repeat the memo
  // says 01:30 when 01:00 comes round again and both fire a second time.
  assert.deepEqual(probe.fired.cronTwice, [
    '2026-11-01T08:00:00.000Z',
    '2026-11-01T08:30:00.000Z',
  ]);
});

test('day and week entries in the repeated hour fire ONCE too', () => {
  assert.deepEqual(probe.fired.daily, ['2026-11-01T08:30:00.000Z']);
  assert.deepEqual(probe.fired.weekly, ['2026-11-01T08:30:00.000Z'],
    '2026-11-01 is a Sunday, so the weekly entry is due that day');
});

test('a 30m entry across the repeated hour fires TWICE', () => {
  assert.deepEqual(probe.fired.half, [
    '2026-11-01T07:00:00.000Z',
    '2026-11-01T07:30:00.000Z',
    '2026-11-01T08:00:00.000Z',
    '2026-11-01T08:30:00.000Z', // 01:30 PDT
    '2026-11-01T09:00:00.000Z',
    '2026-11-01T09:30:00.000Z', // 01:30 PST — a second real half-hour later
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

test('a tick that skips a minute still fires what that minute owed', () => {
  // D4: setInterval drops ticks under load. Without the window, 08:30Z is
  // simply lost — a daily task silently does not run that day.
  assert.deepEqual(probe.drifted.daily, ['2026-11-01T08:30:00.000Z']);
  assert.deepEqual(probe.drifted.half, ['2026-11-01T08:30:00.000Z']);
});

test('two ticks inside one minute fire once', () => {
  assert.deepEqual(probe.twiceInOneMinute.daily, ['2026-11-01T08:30:00.000Z']);
  assert.deepEqual(probe.twiceInOneMinute.half, ['2026-11-01T08:30:00.000Z'],
    'interval kinds are UTC-keyed, but one minute is still one minute');
});

test('a long gap between ticks fires once, not once per missed slot', () => {
  assert.equal(probe.afterLongGap, '2026-11-01T08:30:00.000Z');
});

test('localSlotKey here is the same function as schedule-runner 2837596', () => {
  assert.equal(probe.parity.mineFirst, probe.parity.runnerFirst);
  assert.equal(probe.parity.mineSecond, probe.parity.runnerSecond);
  assert.equal(probe.parity.mineFirst, probe.parity.mineSecond,
    'and it still collapses the repeated minute');
});

test('a spring-forward skipped hour simply never fires — documented, not fixed', () => {
  assert.deepEqual(probe.springForward.fired, [],
    '2026-03-08 has no local 02:30, so a 02:30 daily does not run that day');
});

// --- The rule itself, independent of any zone ---

test('every kind belongs to exactly one family', () => {
  for (const every of EVERY_VALUES) {
    const calendar = CALENDAR_KINDS.has(every);
    const interval = INTERVAL_KINDS.has(every);
    assert.ok(calendar !== interval, `${every} must be calendar xor interval`);
  }
  for (const p of PRESETS) {
    assert.ok(CALENDAR_KINDS.has(p.every) || INTERVAL_KINDS.has(p.every),
      `the dialog offers ${p.every}, so it needs a family`);
  }
  assert.ok(CALENDAR_KINDS.has('cron'), 'an imported cron is a wall-clock instruction');
});

test('an unknown kind is never due, so its key never matters', () => {
  const at = new Date(2026, 5, 15, 12, 0, 0, 0);
  assert.equal(dueThisMinute({ every: 'fortnightly' }, at), false);
  assert.equal(dueSince({ every: 'fortnightly' }, at.getTime() - 60000, at.getTime()), null);
});

test('the two key namespaces cannot collide', () => {
  const at = new Date(2026, 5, 15, 12, 0, 0, 0);
  assert.notEqual(fireSlotKey({ every: 'day' }, at), fireSlotKey({ every: 'hour' }, at),
    'an edited kind misses the memo and is allowed to fire — the safe direction');
  assert.equal(fireSlotKey({ every: 'day' }, at), `L${localSlotKey(at)}`);
  assert.equal(fireSlotKey({ every: '30m' }, at), `U${utcSlotKey(at)}`);
  assert.equal(fireSlotKey({ every: '30m' }, at.getTime()), fireSlotKey({ every: '30m' }, at),
    'ms and Date are the same argument');
});

test('utcSlotKey separates two instants a minute apart and joins one minute', () => {
  const base = Date.parse('2026-06-15T12:00:00Z');
  assert.notEqual(utcSlotKey(new Date(base)), utcSlotKey(new Date(base + 60000)));
  assert.equal(utcSlotKey(new Date(base)), utcSlotKey(new Date(base + 59999)));
});

// --- dueSince: the window (D4) ---

const NOON = new Date(2026, 5, 15, 12, 0, 0, 0).getTime(); // a Monday, local
const MIN = 60 * 1000;

test('dueSince is strictly after "from", so a fired minute does not fire again', () => {
  const hourly = { every: 'hour', atMinute: 0 };
  assert.equal(dueSince(hourly, NOON, NOON + 30 * MIN), null);
  assert.equal(dueSince(hourly, NOON - 5 * MIN, NOON + MIN), NOON);
});

test('dueSince with no window looks only at the minute containing "to"', () => {
  const hourly = { every: 'hour', atMinute: 0 };
  assert.equal(dueSince(hourly, null, NOON + 30 * 1000), NOON, 'mid-minute still counts');
  assert.equal(dueSince(hourly, undefined, NOON + 5 * MIN), null, 'and looks no further back');
});

test('dueSince answers with the latest due minute, not every one', () => {
  const everyTwo = { every: 'cron', cron: '*/2 * * * *' };
  assert.equal(dueSince(everyTwo, NOON, NOON + 8 * MIN), NOON + 8 * MIN,
    'four due minutes in the window, one session');
});

test('dueSince clamps the window, so a resume is not a burst', () => {
  const hourly = { every: 'hour', atMinute: 0 };
  const late = NOON + (MAX_TICK_CATCHUP_MINUTES + 1) * MIN;
  assert.equal(dueSince(hourly, NOON - 60 * MIN, late), null,
    'the 12:00 slot is older than the clamp: the catchUp path owns that, not the ticker');
  assert.equal(dueSince(hourly, NOON - 60 * MIN, NOON + 5 * MIN), NOON,
    'inside the clamp it is still recovered');
});

test('dueSince refuses nonsense rather than inventing a due minute', () => {
  const hourly = { every: 'hour', atMinute: 0 };
  assert.equal(dueSince(null, NOON - MIN, NOON), null);
  assert.equal(dueSince(hourly, NOON, NaN), null);
  assert.equal(dueSince(hourly, NOON, NOON - 10 * MIN), null, 'a clock that went backwards');
});

// --- createFireGate: the memo (D3 + D4 together) ---

test('the gate does not burn a slot the caller chose to skip', () => {
  // A schedule whose previous run is still working is skipped by the caller.
  // If `due` marked it fired, the next tick inside the same minute would
  // never retry it — so marking is the caller's, and it retries.
  const gate = createFireGate();
  const row = { id: 'busy-one', every: 'hour', atMinute: 0 };
  assert.equal(gate.due(row, NOON + 5 * 1000), NOON, 'due');
  assert.deepEqual(gate.firedSlots(row), [], 'and nothing recorded');
  assert.equal(gate.due(row, NOON + 20 * 1000), NOON, 'still due on the next look');
  gate.markFired(row, NOON);
  assert.equal(gate.due(row, NOON + 40 * 1000), null, 'only now is it done');
});

test('the memo holds a set of slots and forgets the stale ones', () => {
  const gate = createFireGate();
  const row = { id: 'many-a-day', every: 'cron', cron: '0,30 * * * *' };
  gate.markFired(row, NOON);
  gate.markFired(row, NOON + 30 * MIN);
  assert.equal(gate.firedSlots(row).length, 2, 'both slots, not just the last');
  assert.equal(gate.hasFired(row, NOON), true, 'the earlier one is still known');
  gate.markFired(row, NOON + MEMO_RETENTION_MS + MIN);
  assert.equal(gate.hasFired(row, NOON), false, 'past the retention it is dropped');
  assert.equal(gate.hasFired(row, NOON + 30 * MIN), true, 'inside it, still held');
  assert.equal(gate.firedSlots(row).length, 2, 'so the memo does not grow forever');
});

test('the gate advances its window only on endTick', () => {
  const gate = createFireGate();
  assert.equal(gate.lastTickMs, null);
  gate.endTick(NOON);
  assert.equal(gate.lastTickMs, NOON);
  gate.endTick(NaN);
  assert.equal(gate.lastTickMs, NOON, 'a bad clock reading does not move it');
});

test('endTick forgets schedules that no longer exist', () => {
  const gate = createFireGate();
  const kept = { id: 'kept', every: 'hour', atMinute: 0 };
  const gone = { id: 'gone', every: 'hour', atMinute: 0 };
  gate.markFired(kept, NOON);
  gate.markFired(gone, NOON);
  gate.endTick(NOON, ['kept']);
  assert.equal(gate.hasFired(kept, NOON), true, 'a live schedule keeps its memo');
  assert.equal(gate.hasFired(gone, NOON), false, 'a deleted one does not leak');
  assert.deepEqual(gate.firedSlots(gone), []);
  gate.endTick(NOON + MIN);
  assert.equal(gate.hasFired(kept, NOON), true, 'no id list means no pruning');
});

test('a schedule with no id is never deduped rather than sharing a slot', () => {
  // The dialog builds timing-only objects for its preview. They must not be
  // able to collide in the memo with each other or with a real row.
  const gate = createFireGate();
  const anonymous = { every: 'hour', atMinute: 0 };
  assert.equal(gate.due(anonymous, NOON + 5 * 1000), NOON);
  gate.markFired(anonymous, NOON);
  assert.deepEqual(gate.firedSlots(anonymous), [], 'nothing was recorded');
  assert.equal(gate.due(anonymous, NOON + 20 * 1000), NOON, 'so nothing is suppressed');
});

test('a destructured due() still works', () => {
  // `due` reads the memo through a closure, not `this`, so main can pull it
  // off the gate without silently losing the dedupe.
  const gate = createFireGate();
  const { due, markFired } = gate;
  const row = { id: 'destructured', every: 'hour', atMinute: 0 };
  assert.equal(due(row, NOON + 5 * 1000), NOON);
  markFired(row, NOON);
  assert.equal(due(row, NOON + 40 * 1000), null);
});
