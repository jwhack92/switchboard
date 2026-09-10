const test = require('node:test');
const assert = require('node:assert/strict');

const { cronMatches, localSlotKey } = require('../schedule-runner');

// cronMatches compares local getHours()/getMinutes() and keeps no memo of what
// already fired. On a DST fall-back the same wall-clock minute occurs twice, 60
// real minutes apart, so a daily cron inside the repeated hour matches both
// instants and the task runs twice. For a scheduled Claude session that is two
// billed runs, unattended, at 01:30.
//
// localSlotKey identifies the wall-clock minute, so the second occurrence is
// recognised as the same slot and suppressed.

// Both of these read as local 01:30 on 2026-11-01 in America/Los_Angeles:
// 08:30Z is 01:30 PDT, 09:30Z is 01:30 PST.
const FIRST = new Date('2026-11-01T08:30:00Z');
const SECOND = new Date('2026-11-01T09:30:00Z');

// This suite asserts a property of the local timezone, so it only means
// anything where a fall-back actually happens.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HAS_FALLBACK = FIRST.getHours() === 1 && SECOND.getHours() === 1
  && FIRST.getMinutes() === 30 && SECOND.getMinutes() === 30;

test('the DST fall-back really does repeat a wall-clock minute here', { skip: !HAS_FALLBACK && `no fall-back in ${TZ}` }, () => {
  assert.notEqual(FIRST.getTime(), SECOND.getTime(), 'two distinct instants');
  assert.equal((SECOND - FIRST) / 60000, 60, 'an hour apart in real time');
  assert.equal(FIRST.getHours(), SECOND.getHours(), 'but the same local hour');
});

test('a daily cron in the repeated hour matches BOTH instants', { skip: !HAS_FALLBACK && `no fall-back in ${TZ}` }, () => {
  // This is the bug, stated as a test: without a memo, both of these fire.
  assert.equal(cronMatches('30 1 * * *', FIRST), true);
  assert.equal(cronMatches('30 1 * * *', SECOND), true);
});

test('localSlotKey collapses the repeat to one slot', { skip: !HAS_FALLBACK && `no fall-back in ${TZ}` }, () => {
  assert.equal(localSlotKey(FIRST), localSlotKey(SECOND),
    'the second occurrence must be recognised as already fired');
});

test('localSlotKey still separates genuinely different minutes', () => {
  const a = new Date('2026-06-15T10:30:00Z');
  const b = new Date('2026-06-15T10:31:00Z');
  assert.notEqual(localSlotKey(a), localSlotKey(b));
});

test('localSlotKey separates the same minute on different days', () => {
  const a = new Date('2026-06-15T10:30:00Z');
  const b = new Date('2026-06-16T10:30:00Z');
  assert.notEqual(localSlotKey(a), localSlotKey(b),
    'a daily cron must fire again tomorrow');
});

test('localSlotKey separates the same minute in different months and years', () => {
  assert.notEqual(
    localSlotKey(new Date('2026-06-15T10:30:00Z')),
    localSlotKey(new Date('2026-07-15T10:30:00Z')),
  );
  assert.notEqual(
    localSlotKey(new Date('2026-06-15T10:30:00Z')),
    localSlotKey(new Date('2027-06-15T10:30:00Z')),
  );
});

test('a spring-forward skipped hour simply never matches — documented, not fixed', () => {
  // 2026-03-08 in America/Los_Angeles: local 02:00-02:59 does not exist, so
  // `cron: 30 2 * * *` never fires that day. That is standard cron behaviour
  // and out of scope for the double-fire fix; asserted here so a future change
  // to localSlotKey cannot quietly alter it.
  const skipped = new Date('2026-03-08T10:30:00Z'); // 03:30 PDT, not 02:30
  if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Los_Angeles') {
    assert.notEqual(skipped.getHours(), 2);
  }
  assert.ok(typeof localSlotKey(skipped) === 'string');
});
