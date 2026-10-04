'use strict';
// scripts/token-rehearsal.js, the wait for the secondary indexes.
//
// The store builds its seven secondary indexes one statement per timer turn
// after the backfill's `done` (token-usage.js, startIndexBuild), about a second
// in all on the real-size store. The rehearsal counted the indexes right after
// the walk, so its "n indexes" could print fewer than seven for a store that
// was fine. It now waits for meta.indexes_built = '1', for a bounded time.
//
// Plain Node: the wait takes its clock, its sleep and the flag reader as
// arguments, so nothing here opens a database or starts a store. (Requiring
// the script runs nothing: it only starts when it is the main module.)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const R = require(path.join(__dirname, '..', 'scripts', 'token-rehearsal.js'));

// A clock that only moves when the wait sleeps.
function fakeTime() {
  let now = 5000;
  const naps = [];
  return {
    naps,
    now: () => now,
    sleep: (ms) => { naps.push(ms); now += ms; return Promise.resolve(); },
  };
}

test('the rehearsal waits until indexes_built is set before it counts', async () => {
  assert.equal(typeof R.waitForIndexes, 'function', 'scripts/token-rehearsal.js exports waitForIndexes');
  const time = fakeTime();
  let reads = 0;
  // '' is what a fresh store holds; the chain sets '1' in its last turn.
  const flag = () => { reads += 1; return reads < 5 ? '' : '1'; };
  const r = await R.waitForIndexes(flag, { timeoutMs: 60000, pollMs: 250, now: time.now, sleep: time.sleep });
  assert.deepEqual(r, { built: true, waitedMs: 1000 });
  assert.equal(reads, 5, 'read once per poll, and it stopped at the first read that saw the flag');
  assert.deepEqual(time.naps, [250, 250, 250, 250]);
});

test('a flag that is already set costs no wait', async () => {
  const time = fakeTime();
  const r = await R.waitForIndexes(() => '1', { timeoutMs: 60000, pollMs: 250, now: time.now, sleep: time.sleep });
  assert.deepEqual(r, { built: true, waitedMs: 0 });
  assert.deepEqual(time.naps, []);
});

test('the wait is bounded: a flag that never comes ends it at the timeout', async () => {
  const time = fakeTime();
  let reads = 0;
  for (const never of ['', null, undefined, '0', 1, true]) {
    time.naps.length = 0;
    reads = 0;
    const r = await R.waitForIndexes(() => { reads += 1; return never; },
      { timeoutMs: 2000, pollMs: 250, now: time.now, sleep: time.sleep });
    assert.deepEqual(r, { built: false, waitedMs: 2000 }, 'only the string 1 counts: ' + String(never));
    assert.equal(time.naps.length, 8);
    assert.equal(reads, 9);
  }
});

test('a flag that cannot be read ends the wait at once, and says why', async () => {
  const time = fakeTime();
  const r = await R.waitForIndexes(() => { throw new Error('the store is closed'); },
    { timeoutMs: 60000, pollMs: 250, now: time.now, sleep: time.sleep });
  assert.deepEqual(r, { built: false, waitedMs: 0, error: 'the store is closed' });
  assert.deepEqual(time.naps, []);
});

test('the defaults are a real bound', () => {
  assert.ok(Number.isFinite(R.INDEX_WAIT_MS) && R.INDEX_WAIT_MS >= 10000 && R.INDEX_WAIT_MS <= 120000, String(R.INDEX_WAIT_MS));
});
