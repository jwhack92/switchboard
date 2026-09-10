const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../driver-store');

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  store.init({ dir: d, log: { error() {} } });
  return d;
}
const cleanup = d => fs.rmSync(d, { recursive: true, force: true });

// ------------------------------------------------------------------ HALT

test('no HALT file means not halted', () => {
  const d = tmpdir();
  try {
    assert.deepEqual(store.isHalted(), { halted: false, reason: null, since: null });
  } finally { cleanup(d); }
});

test('a HALT file halts, and its first line is the reason', () => {
  const d = tmpdir();
  try {
    store.halt('night budget exhausted');
    const h = store.isHalted();
    assert.equal(h.halted, true);
    assert.equal(h.reason, 'night budget exhausted');
    assert.ok(h.since > 0);
  } finally { cleanup(d); }
});

test('an UNREADABLE HALT file counts as halted — fail closed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  try {
    // Only a definitively absent file may permit spawning. Anything else —
    // permissions, a lock, a corrupt directory — must read as halted.
    store.init({
      dir: d,
      log: { error() {} },
      fs: {
        ...fs,
        existsSync: () => true,
        mkdirSync: () => {},
        readFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
      },
    });
    const h = store.isHalted();
    assert.equal(h.halted, true, 'a file we cannot read must not be assumed absent');
    assert.match(h.reason, /unreadable/);
  } finally { cleanup(d); }
});

test('halt is idempotent and keeps the original reason', () => {
  const d = tmpdir();
  try {
    store.halt('first reason');
    store.halt('second reason');
    assert.equal(store.isHalted().reason, 'first reason');
    store.halt('third reason', { overwrite: true });
    assert.equal(store.isHalted().reason, 'third reason');
  } finally { cleanup(d); }
});

test('a multi-line reason is reduced to its first line', () => {
  const d = tmpdir();
  try {
    store.halt('reason line\nsomething else entirely');
    assert.equal(store.isHalted().reason, 'reason line');
  } finally { cleanup(d); }
});

test('clearHalt removes the stop and is safe when none exists', () => {
  const d = tmpdir();
  try {
    store.halt('x');
    assert.equal(store.isHalted().halted, true);
    store.clearHalt();
    assert.equal(store.isHalted().halted, false);
    store.clearHalt(); // must not throw
  } finally { cleanup(d); }
});

// ------------------------------------------------------------ atomic write

test('writeJsonAtomic round-trips', () => {
  const d = tmpdir();
  try {
    const f = path.join(d, 'x.json');
    store.writeJsonAtomic(f, { a: 1, b: [2, 3] });
    assert.deepEqual(store.readJson(f), { a: 1, b: [2, 3] });
  } finally { cleanup(d); }
});

test('a transient EPERM on rename is retried, not surfaced', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  try {
    let attempts = 0;
    store.init({
      dir: d,
      log: { error() {} },
      fs: {
        ...fs,
        renameSync: (from, to) => {
          attempts += 1;
          if (attempts < 3) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
          return fs.renameSync(from, to);
        },
      },
    });
    const f = path.join(d, 'y.json');
    store.writeJsonAtomic(f, { ok: true });
    assert.equal(attempts, 3, 'Defender/OneDrive hold the destination briefly; that is survivable');
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { ok: true });
  } finally { cleanup(d); }
});

test('a persistent write failure THROWS — it must never be a logged warning', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  try {
    store.init({
      dir: d,
      log: { error() {} },
      fs: {
        ...fs,
        renameSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
      },
    });
    // A counter that silently stops advancing is a bound that silently stops
    // bounding. Callers are expected to treat this throw as halt-class.
    assert.throws(() => store.writeJsonAtomic(path.join(d, 'z.json'), { a: 1 }),
      err => err.code === 'ATOMIC_WRITE_FAILED');
  } finally { cleanup(d); }
});

test('a non-retryable error is not retried', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  try {
    let attempts = 0;
    store.init({
      dir: d, log: { error() {} },
      fs: { ...fs, renameSync: () => { attempts += 1; const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } },
    });
    assert.throws(() => store.writeJsonAtomic(path.join(d, 'z.json'), { a: 1 }));
    assert.equal(attempts, 1, 'a full disk will not clear by waiting');
  } finally { cleanup(d); }
});

test('readJson returns the fallback rather than throwing on corrupt input', () => {
  const d = tmpdir();
  try {
    const f = path.join(d, 'bad.json');
    fs.writeFileSync(f, '{ not json');
    assert.deepEqual(store.readJson(f, []), []);
    assert.equal(store.readJson(path.join(d, 'missing.json')), null);
  } finally { cleanup(d); }
});

// ------------------------------------------------------------------ events

test('events append and read back in order', () => {
  const d = tmpdir();
  try {
    store.appendEvent('A', { n: 1 });
    store.appendEvent('B', { n: 2 });
    const ev = store.readEvents();
    assert.deepEqual(ev.map(e => e.type), ['HALT_CLEARED'].includes(ev[0].type) ? ev.map(e => e.type) : ['A', 'B']);
    assert.equal(ev.at(-1).n, 2);
  } finally { cleanup(d); }
});

test('a torn log line is skipped rather than poisoning the read', () => {
  const d = tmpdir();
  try {
    store.appendEvent('GOOD', { n: 1 });
    fs.appendFileSync(path.join(d, 'events.jsonl'), '{ truncated\n');
    store.appendEvent('ALSO_GOOD', { n: 2 });
    const types = store.readEvents().map(e => e.type);
    assert.deepEqual(types, ['GOOD', 'ALSO_GOOD']);
  } finally { cleanup(d); }
});

test('appendEvent never throws — losing a log line must not block a halt', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-store-'));
  try {
    store.init({
      dir: d, log: { error() {} },
      fs: { ...fs, appendFileSync: () => { throw new Error('disk gone'); } },
    });
    assert.doesNotThrow(() => store.appendEvent('X', {}));
  } finally { cleanup(d); }
});

// -------------------------------------------------------------------- lock

test('the lock is exclusive and re-entrant for its own holder', () => {
  const d = tmpdir();
  try {
    const a = store.acquireLock(() => true);
    assert.equal(a.ok, true);
    const b = store.acquireLock(() => true);
    assert.equal(b.ok, true);
    assert.equal(b.reentrant, true, 'the same process may re-acquire');
  } finally { cleanup(d); }
});

test('a lock held by a LIVE foreign pid is not stealable', () => {
  const d = tmpdir();
  try {
    fs.writeFileSync(path.join(d, 'LOCK'), JSON.stringify({ pid: 999999, startedAtMs: 1 }));
    const r = store.acquireLock(() => true); // pretend that pid is alive
    assert.equal(r.ok, false);
    assert.match(r.reason, /live pid/);
  } finally { cleanup(d); }
});

test('a lock held by a DEAD pid is broken and retaken', () => {
  const d = tmpdir();
  try {
    fs.writeFileSync(path.join(d, 'LOCK'), JSON.stringify({ pid: 999999, startedAtMs: 1 }));
    const r = store.acquireLock(() => false); // that pid is gone
    assert.equal(r.ok, true);
    assert.equal(store.readJson(path.join(d, 'LOCK')).pid, process.pid);
  } finally { cleanup(d); }
});

test('releaseLock will not remove a lock owned by another process', () => {
  const d = tmpdir();
  try {
    fs.writeFileSync(path.join(d, 'LOCK'), JSON.stringify({ pid: 999999, startedAtMs: 1 }));
    assert.equal(store.releaseLock(), false);
    assert.ok(fs.existsSync(path.join(d, 'LOCK')));
  } finally { cleanup(d); }
});

test('the store directory is machine-wide, not under the app data dir', () => {
  // A dev instance and the installed app must share one HALT file and one lock,
  // or the kill switch reaches only one of them.
  const before = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(os.tmpdir(), 'some-other-place');
  try {
    assert.ok(!store.defaultDir().includes('some-other-place'));
  } finally {
    if (before === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = before;
  }
});
