const test = require('node:test');
const assert = require('node:assert/strict');

const { formatEntryTime, formatEntryTimeTitle } = require('../public/jsonl-viewer');

// Every transcript line already carries an ISO `timestamp`; the viewer just
// never rendered it on messages, and formatted system rows with
// toLocaleTimeString() — time only. In a session spanning weeks (this repo has
// one running since 22 Aug) "15:42" cannot be placed on a day.

const iso = d => d.toISOString();
const minutesAgo = n => new Date(Date.now() - n * 60_000);

// A fixed offset like "30 minutes ago" is not reliably today: run the suite at
// 00:15 and it lands on yesterday, which is exactly how this test failed. The
// midpoint between midnight and now is always both today and in the past.
const earlierToday = () => {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return new Date((midnight.getTime() + now.getTime()) / 2);
};

test('a message from today shows time only', () => {
  const out = formatEntryTime(iso(earlierToday()));
  assert.doesNotMatch(out, /[A-Za-z]{3}/, `expected no month name, got ${out}`);
  assert.match(out, /\d/);
});

test('an older message in the same year carries the date', () => {
  // Six days back is always a different calendar day, in any timezone.
  const out = formatEntryTime(iso(minutesAgo(60 * 24 * 6)));
  assert.match(out, /[A-Za-z]{3}/, `expected a month name, got ${out}`);
});

test('a message from another year carries the year', () => {
  const past = new Date();
  past.setFullYear(past.getFullYear() - 1);
  assert.match(formatEntryTime(iso(past)), new RegExp(String(past.getFullYear())));
});

test('same-day output is shorter than cross-day output', () => {
  // The whole point: today stays uncluttered, older entries pay for the date.
  assert.ok(formatEntryTime(iso(earlierToday())).length
    < formatEntryTime(iso(minutesAgo(60 * 24 * 6))).length);
});

// ---------------------------------------------------- degenerate input

test('missing or unparseable timestamps render as empty, never as a crash or "Invalid Date"', () => {
  for (const bad of [null, undefined, '', 'not-a-date', {}, [], NaN]) {
    assert.equal(formatEntryTime(bad), '', `input ${JSON.stringify(bad)}`);
    assert.equal(formatEntryTimeTitle(bad), '');
  }
});

// ---------------------------------------------------- hover title

test('the title carries the full instant plus how long ago', () => {
  const t = formatEntryTimeTitle(iso(minutesAgo(90)));
  assert.match(t, /—/);
  assert.match(t, /hour/);
});

test('relative units are singular at one', () => {
  assert.match(formatEntryTimeTitle(iso(minutesAgo(1))), /\b1 min ago\b/);
  assert.match(formatEntryTimeTitle(iso(minutesAgo(60))), /\b1 hour ago\b/);
  assert.match(formatEntryTimeTitle(iso(minutesAgo(60 * 24))), /\b1 day ago\b/);
});

test('relative units are plural above one', () => {
  assert.match(formatEntryTimeTitle(iso(minutesAgo(5))), /\b5 mins ago\b/);
  assert.match(formatEntryTimeTitle(iso(minutesAgo(60 * 3))), /\b3 hours ago\b/);
  assert.match(formatEntryTimeTitle(iso(minutesAgo(60 * 24 * 4))), /\b4 days ago\b/);
});

test('a very recent message reads "just now"', () => {
  assert.match(formatEntryTimeTitle(new Date().toISOString()), /just now/);
});

test('a future timestamp is labelled, not rendered as negative time', () => {
  // Sessions move between machines and clocks disagree; "-3 mins ago" is worse
  // than admitting the timestamp is ahead of us.
  const t = formatEntryTimeTitle(new Date(Date.now() + 10 * 60_000).toISOString());
  assert.match(t, /future/);
  assert.doesNotMatch(t, /-\d/);
});

// ---------------------------------------------------- real data

test('it formats a real timestamp from this repo\'s own transcript', () => {
  const out = formatEntryTime('2026-08-22T15:42:59.331Z');
  assert.ok(out.length > 0);
  assert.doesNotMatch(out, /Invalid/);
});
