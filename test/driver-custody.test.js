const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../driver-store');
const custody = require('../driver-custody');

// process.pid is guaranteed alive; this is guaranteed not to be ours.
const LIVE = process.pid;
const DEAD = 0x7ffffffe;

/**
 * @param {object} opts
 * @param {object|null} opts.inspectResult what the OS "reports" for a live pid
 * @param {object} [opts.storeOverrides]
 */
function harness({ inspectResult = null, storeOverrides = {} } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-custody-'));
  const calls = { taskkill: [], inspect: [] };
  store.init({ dir: d, log: { error() {} }, ...storeOverrides });
  custody.init({
    platform: 'win32',
    log: { error() {} },
    execFileSync: (cmd, args) => {
      if (cmd === 'taskkill') { calls.taskkill.push(args); return ''; }
      calls.inspect.push(args);
      return inspectResult === null ? '' : JSON.stringify(inspectResult);
    },
  });
  return { dir: d, calls, cleanup: () => fs.rmSync(d, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- registry

test('a child is recorded before it is spawned', () => {
  const h = harness();
  try {
    custody.register({ pid: 4321, startedAtMs: 1000, tag: 'nightly', cwd: 'C:\\repo' });
    const recs = custody.list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].pid, 4321);
    assert.equal(recs[0].tag, 'nightly');
  } finally { h.cleanup(); }
});

test('register THROWS when the registry cannot be written', () => {
  // If we cannot record the child we cannot promise to stop it, so it must not
  // be started. "Log and continue" here is exactly how orphans are made.
  const h = harness({
    storeOverrides: {
      fs: { ...fs, renameSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } },
    },
  });
  try {
    assert.throws(() => custody.register({ pid: 4321, startedAtMs: 1000 }),
      err => err.code === 'ATOMIC_WRITE_FAILED');
  } finally { h.cleanup(); }
});

test('re-registering the same pid replaces rather than duplicates', () => {
  const h = harness();
  try {
    custody.register({ pid: 42, startedAtMs: 1, tag: 'first' });
    custody.register({ pid: 42, startedAtMs: 2, tag: 'second' });
    const recs = custody.list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].tag, 'second');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- identity

test('a dead pid verifies as not_running', () => {
  const h = harness();
  try {
    const v = custody.verify({ pid: DEAD, startedAtMs: 1000 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not_running');
  } finally { h.cleanup(); }
});

test('a REUSED pid is detected by creation-time drift', () => {
  // The OS says this pid was created hours after we recorded it, so the pid has
  // been recycled onto some unrelated process.
  const h = harness({ inspectResult: { c: 9_000_000, l: 'something-else.exe' } });
  try {
    const v = custody.verify({ pid: LIVE, startedAtMs: 1_000_000 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'pid_reused');
    assert.ok(v.driftMs > custody.CREATION_TOLERANCE_MS);
  } finally { h.cleanup(); }
});

test('a command line that does not match verifies as a mismatch', () => {
  const h = harness({ inspectResult: { c: 1_000_000, l: 'C:\\Windows\\notepad.exe' } });
  try {
    const v = custody.verify({ pid: LIVE, startedAtMs: 1_000_000, cmdlineNeedle: 'abc-session-id' });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'cmdline_mismatch');
  } finally { h.cleanup(); }
});

test('a matching creation time and command line verifies ok', () => {
  const h = harness({ inspectResult: { c: 1_000_000, l: 'claude --session-id abc-session-id -p' } });
  try {
    const v = custody.verify({ pid: LIVE, startedAtMs: 1_000_500, cmdlineNeedle: 'abc-session-id' });
    assert.equal(v.ok, true);
  } finally { h.cleanup(); }
});

test('a process we cannot inspect is not assumed to be ours', () => {
  const h = harness({ inspectResult: null });
  try {
    const v = custody.verify({ pid: LIVE, startedAtMs: 1_000_000 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not_inspectable');
  } finally { h.cleanup(); }
});

// -------------------------------------------------------------------- stop

test('an UNVERIFIED record is dropped and NEVER killed', () => {
  // The whole safety case for having a kill at all. Killing on a reused pid
  // would take down an unrelated process on the user's machine.
  const h = harness({ inspectResult: { c: 9_000_000, l: 'unrelated.exe' } });
  try {
    custody.register({ pid: LIVE, startedAtMs: 1_000_000 });
    const r = custody.stop({ pid: LIVE, startedAtMs: 1_000_000 });
    assert.equal(r.verified, false);
    assert.equal(r.killed, false);
    assert.equal(h.calls.taskkill.length, 0, 'must not issue a kill for a pid it cannot identify');
    assert.equal(custody.list().length, 0, 'and must forget the stale record');
  } finally { h.cleanup(); }
});

test('a verified record is killed as a tree', () => {
  const h = harness({ inspectResult: { c: 1_000_000, l: 'claude -p' } });
  try {
    custody.register({ pid: LIVE, startedAtMs: 1_000_000 });
    custody.stop({ pid: LIVE, startedAtMs: 1_000_000 });
    assert.equal(h.calls.taskkill.length, 1);
    const args = h.calls.taskkill[0];
    assert.ok(args.includes('/T'), 'descendants must be included, or subagents survive');
    assert.ok(args.includes('/F'));
    assert.ok(args.includes(String(LIVE)));
  } finally { h.cleanup(); }
});

// -------------------------------------------------------------------- reap

test('reap drops dead records and reports nothing degraded', () => {
  const h = harness();
  try {
    custody.register({ pid: DEAD, startedAtMs: 1000 });
    const r = custody.reap();
    assert.equal(r.degraded, false);
    assert.equal(r.survivors.length, 0);
    assert.equal(custody.list().length, 0);
  } finally { h.cleanup(); }
});

test('a survivor makes the reap DEGRADED rather than silently clean', () => {
  // taskkill "succeeds" but the process is still there. We must not report a
  // clean halt — a paper halt is the failure mode this whole module exists for.
  const h = harness({ inspectResult: { c: 1_000_000, l: 'claude -p' } });
  try {
    custody.register({ pid: LIVE, startedAtMs: 1_000_000, cmdlineNeedle: 'claude' });
    const r = custody.reap();
    assert.equal(r.degraded, true, 'LIVE is this test process, so it cannot actually die');
    assert.equal(r.survivors.length, 1);
    assert.equal(r.survivors[0].pid, LIVE);
    assert.ok(custody.list().some(x => x.pid === LIVE), 'a survivor stays on the books');
  } finally { h.cleanup(); }
});

test('reap on an empty registry is a no-op', () => {
  const h = harness();
  try {
    const r = custody.reap();
    assert.equal(r.degraded, false);
    assert.deepEqual(r.results, []);
  } finally { h.cleanup(); }
});

test('haltAndReap writes the stop before killing', () => {
  const h = harness();
  try {
    custody.register({ pid: DEAD, startedAtMs: 1 });
    custody.haltAndReap('test stop');
    assert.equal(store.isHalted().halted, true);
    assert.equal(store.isHalted().reason, 'test stop');
    assert.equal(custody.list().length, 0);
  } finally { h.cleanup(); }
});

test('isPidAlive is honest about both cases', () => {
  assert.equal(custody.isPidAlive(LIVE), true);
  assert.equal(custody.isPidAlive(DEAD), false);
  assert.equal(custody.isPidAlive(-1), false);
  assert.equal(custody.isPidAlive(undefined), false);
});
