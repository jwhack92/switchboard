'use strict';
// The scheduler half of the token store (design 3.5 and the scheduler bullets of
// 7.6): the 3 s / 10 s flush rule, the bounded pending set, the 10-minute
// catch-up, the respawn backoff, generation checks on the worker's messages and
// the one-per-second broadcast. Everything runs on a fake clock with a stub
// worker, both injected through ctx.
//
// Not plain Node: the scheduler only runs when the store is open (noteChanged
// is a no-op unless state is ok), and the store needs better-sqlite3, which is
// built for Electron's ABI. So each scenario runs in a child: this same file
// under the Electron binary as Node, with TOKEN_USAGE_SCENARIO set. Contract
// rule 5 holds as in the database test: temp dataDir, SWITCHBOARD_DATA_DIR on
// the same folder, and a refusal to open anything outside os.tmpdir().

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const MOD = path.join(APP_DIR, 'token-usage.js');
const SID = '11111111-1111-4111-8111-111111111111';
const SID_2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-10-03T18:00:00Z');

// ------------------------------------------------------------ child helpers ----

function tempDirs() {
  const raw = process.env.SWITCHBOARD_DATA_DIR;
  assert.ok(raw, 'SWITCHBOARD_DATA_DIR must be set for a database test');
  const dataDir = path.resolve(raw);
  const tmp = path.resolve(os.tmpdir());
  assert.ok(dataDir.toLowerCase().startsWith(tmp.toLowerCase() + path.sep),
    'refusing to open a database outside os.tmpdir(): ' + dataDir);
  return { dataDir, projectsDir: path.join(path.dirname(dataDir), 'projects') };
}

function fakeClock() {
  let now = 1791000000000;
  let seq = 0;
  const timers = new Map();
  function earliest(limit) {
    let best = null;
    for (const t of timers.values()) {
      if (t.at > limit) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { id, fn, at: now + Math.max(0, ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    count: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (let t = earliest(target); t; t = earliest(target)) {
        timers.delete(t.id);
        if (t.at > now) now = t.at;
        t.fn();
      }
      now = target;
    },
  };
}

function stubWorkers(failFirst) {
  const { EventEmitter } = require('events');
  const made = [];
  let calls = 0;
  return {
    made,
    get calls() { return calls; },
    get last() { return made[made.length - 1]; },
    createWorker(workerPath, workerData) {
      calls++;
      if (failFirst && calls === 1) throw new Error('worker file missing');
      const w = new EventEmitter();
      w.workerPath = workerPath;
      w.workerData = workerData;
      w.posted = [];
      w.terminated = false;
      w.postMessage = (m) => { w.posted.push(m); };
      w.terminate = () => { w.terminated = true; return Promise.resolve(0); };
      w.of = (type) => w.posted.filter((m) => m.type === type);
      made.push(w);
      return w;
    },
  };
}

// The queries module belongs to another agent; summary() is exercised against a stub.
function installQueriesStub() {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request) {
    if (/token-usage-queries(\.js)?$/.test(request)) {
      const answer = (name) => () => ({ name });
      return { createQueries: () => ({ summary: answer('summary'), models: answer('models'), daily: answer('daily'),
        sessions: answer('sessions'), context: answer('context') }) };
    }
    return origLoad.apply(this, arguments);
  };
}

function makeHarness() {
  const dirs = tempDirs();
  fs.mkdirSync(dirs.projectsDir, { recursive: true });
  installQueriesStub();
  const t = require(MOD);
  const H = { t, dirs };
  H.start = (opts) => {
    const o = opts || {};
    const workers = stubWorkers(o.failFirst);
    const logs = [];
    const sent = [];
    const clock = fakeClock();
    const log = {};
    for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => logs.push(level + ': ' + m);
    const ctx = {
      log, logs, sent, clock,
      projectsDir: dirs.projectsDir,
      dataDir: dirs.dataDir,
      workerPath: 'C:/app/workers/scan-tokens.js',
      createWorker: workers.createWorker,
      broadcast: (channel, payload) => sent.push({ channel, payload, at: clock.now() }),
    };
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    if (!o.noHello && workers.last) H.hello(workers.last);
    return { ctx, workers, clock };
  };
  H.hello = (w) => w.emit('message', { type: 'hello', gen: w.workerData.gen, parseVersion: 1 });
  H.done = (w, mode) => w.emit('message', { type: 'done', gen: t._gen(), mode: mode || 'catchup', seen: [], missing: [] });
  H.rel = (name) => 'proj/' + name + '.jsonl';
  H.touch = (rel) => {
    const abs = path.join(dirs.projectsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '{}\n');
  };
  H.fileRow = (rel, sid) => ({ rel_path: rel, kind: 'main', slug: 'proj', session_id: sid || SID, agent_id: null, wf_id: null,
    size: 5000, mtime_ms: 1791000000000, birthtime_ms: 1000, head_hash: 'v1:h', indexed_bytes: 5000, tail_hash: 'tail' });
  H.chunk = (rel, ids, o) => {
    const fr = H.fileRow(rel, o && o.sid);
    return Object.assign({
      type: 'chunk', gen: t._gen(), rel_path: rel, seq: 0, last: true, fileRow: fr, fullRescan: false, lines_skipped: 0, compactions: [],
      candidates: ids.map((id) => ({ message_id: id, session_id: fr.session_id, kind: 'main', slug: 'proj', wf_id: null, agent_id: null,
        owner_birth_ms: 1000, model: 'claude-opus-5-5', ts_ms: T0, input: 1, output: 2, cache_write: 3, cache_write_5m: 3,
        cache_write_1h: 0, cache_read: 4, thinking: null, finalized: 1, stop_reason: 'end_turn' })),
    }, o && o.msg);
  };
  H.n = (table) => t._handle().prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
  H.meta = (key) => { const r = t._handle().prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; };
  return H;
}

// --------------------------------------------------------------- scenarios ----

const SCENARIOS = {
  flushRule(H) {
    const { t } = H;
    const { workers, clock } = H.start();
    const w = workers.last;
    const scans = () => w.of('scan').length;
    const a = H.rel(SID);
    const b = 'proj/' + SID + '/subagents/agent-a1.jsonl';
    H.touch(a);
    H.touch(b);
    // Get the startup walk and its broadcast out of the way, so the only timer
    // left is the 10-minute catch-up.
    clock.advance(10000);
    H.done(w, 'backfill');
    clock.advance(1000);
    const idle = clock.count();
    assert.equal(idle, 1);

    // Quiet for 3 s.
    assert.deepEqual(t.noteChanged(a), { ok: true, queued: true });
    assert.equal(clock.count(), idle + 2, 'a quiet timer and a max-wait timer');
    clock.advance(2999);
    assert.equal(scans(), 0);
    clock.advance(1);
    assert.equal(scans(), 1);
    assert.deepEqual(w.of('scan')[0], { type: 'scan', gen: t._gen(), files: [{ rel_path: a, prev: null }] });
    assert.equal(clock.count(), idle, 'both flush timers are gone after the flush');

    // The quiet timer is re-armed by every event: 0 s, 2 s, 4 s -> flush at 7 s.
    t.noteChanged(a);
    clock.advance(2000);
    t.noteChanged(b.replace(/\//g, '\\'));     // the watcher hands over Windows separators
    clock.advance(2000);
    for (let i = 0; i < 100; i++) t.noteChanged(a);
    clock.advance(2999);
    assert.equal(scans(), 1);
    clock.advance(1);
    assert.equal(scans(), 2);
    assert.deepEqual(w.of('scan')[1].files.map((f) => f.rel_path).sort(), [a, b].sort(), 'one entry per path, / separators');

    // Never quiet: an event every 2 s. Without a maximum wait this would starve;
    // the flush comes 10 s after the FIRST pending event.
    t.noteChanged(a);
    for (let i = 0; i < 4; i++) { clock.advance(2000); t.noteChanged(a); }
    clock.advance(1999);
    assert.equal(scans(), 2, 'not before 10 s');
    clock.advance(1);
    assert.equal(scans(), 3, 'at 10 s, although the last event was 2 s ago');
    assert.equal(clock.count(), idle);
    clock.advance(8000);
    assert.equal(scans(), 3, 'the superseded quiet timer does not flush an empty set');

    // Sustained load: one flush per 10 s window.
    for (let i = 0; i < 305; i++) { t.noteChanged(a); clock.advance(100); }
    assert.equal(scans(), 6, 'three windows, three flushes');
    clock.advance(3000);
    assert.equal(scans(), 6 + 1, 'and the quiet rule picks up the tail');

    // Things that are not transcripts never arm a timer.
    for (const p of ['proj/notes.txt', 'top-level.jsonl', '../x/y.jsonl', 'proj/../../y.jsonl', '/abs/x.jsonl',
      'C:\\abs\\x.jsonl', 'proj//x.jsonl', '', null, undefined, 42, {}]) {
      assert.deepEqual(t.noteChanged(p), { ok: true, queued: false }, String(p));
    }
    assert.equal(clock.count(), idle);
    // flush() by hand: nothing pending, nothing posted.
    assert.deepEqual(t.flush(), { ok: true, scanned: 0, missing: 0 });
    t.noteChanged(a);
    assert.deepEqual(t.flush(), { ok: true, scanned: 1, missing: 0 });
    assert.equal(clock.count(), idle, 'a manual flush clears the timers it replaced');
    assert.equal(scans(), 8);
  },

  flushCarriesStoredRow(H) {
    const { t } = H;
    const { workers, clock } = H.start();
    const w = workers.last;
    const a = H.rel(SID);
    const gone = H.rel(SID_2);
    H.touch(a);
    assert.equal(t.applyChunk(H.chunk(a, ['m1'])).ok, true);
    assert.equal(t.applyChunk(H.chunk(gone, ['m2'], { sid: SID_2 })).ok, true);
    t.noteChanged(a);
    t.noteChanged(gone);                         // known to the store, not on disk
    t.noteChanged(H.rel('33333333-3333-4333-8333-333333333333'));   // neither
    clock.advance(3000);
    const scan = w.of('scan').pop();
    assert.equal(scan.files.length, 1, 'only the file that exists is sent');
    assert.equal(scan.files[0].rel_path, a);
    const prev = scan.files[0].prev;
    assert.deepEqual([prev.rel_path, prev.size, prev.mtime_ms, prev.head_hash, prev.indexed_bytes, prev.tail_hash, prev.kind],
      [a, 5000, 1791000000000, 'v1:h', 5000, 'tail', 'main'], 'main is the source of truth: prev is the stored files row');
    const row = t._handle().prepare('SELECT missing_since FROM files WHERE rel_path = ?').get(gone);
    assert.equal(row.missing_since, clock.now(), 'ENOENT on a known path marks it missing');
    assert.equal(H.n('responses'), 2, 'and keeps its rows');
    assert.equal(H.n('files'), 2, 'an unknown missing path creates nothing');
  },

  waitsForHello(H) {
    const { t } = H;
    // Calls before init are no-ops: nothing is queued for later.
    for (let i = 0; i < 20000; i++) t.noteChanged('proj/early-' + i + '.jsonl');
    const { workers, clock } = H.start({ noHello: true });
    const w = workers.last;
    assert.deepEqual(w.workerData, { projectsDir: H.dirs.projectsDir, gen: t._gen() });
    assert.equal(w.workerPath, 'C:/app/workers/scan-tokens.js');
    clock.advance(5000);
    assert.equal(w.posted.length, 0, 'nothing from before init was kept');
    const a = H.rel(SID);
    H.touch(a);
    t.noteChanged(a);
    clock.advance(3000);
    assert.equal(w.posted.length, 0, 'nothing is posted before the worker has said hello');
    clock.advance(60000);
    assert.equal(w.posted.length, 0);
    H.hello(w);
    // hello releases the deferred walk (its 10 s have passed) and re-arms the flush.
    assert.equal(w.of('walk').length, 1);
    assert.equal(w.of('scan').length, 0);
    clock.advance(3000);
    assert.deepEqual(w.of('scan').map((s) => s.files.map((f) => f.rel_path)), [[a]]);
  },

  boundedPending(H) {
    const { t } = H;
    const { workers, clock } = H.start();
    const w = workers.last;
    for (let i = 0; i < 10000; i++) t.noteChanged('proj/f' + i + '.jsonl');
    // At the bound, a path already in the set changes nothing.
    t.noteChanged('proj/f5.jsonl');
    clock.advance(1000);
    assert.equal(w.posted.length, 0);
    // One more distinct path: the set is dropped and a catch-up walk takes its place.
    t.noteChanged('proj/overflow.jsonl');
    const after = H.rel(SID);
    H.touch(after);
    t.noteChanged(after);
    clock.advance(3000);
    assert.equal(w.of('walk').length, 1, 'the next flush turns the overflow into a walk');
    assert.equal(w.of('walk')[0].gen, t._gen());
    const scans = w.of('scan');
    assert.equal(scans.length, 1);
    assert.deepEqual(scans[0].files.map((f) => f.rel_path), [after], 'only what arrived after the drop is scanned by path');
    // The overflow flag does not stick.
    H.done(w, 'backfill');
    t.noteChanged(after);
    clock.advance(3000);
    assert.equal(w.of('walk').length, 1);
    assert.equal(w.of('scan').length, 2);
  },

  catchup(H) {
    const { t } = H;
    const { workers, clock } = H.start();
    const w = workers.last;
    const walks = () => w.of('walk');
    // The startup walk waits for the deferred start, 10 s after init.
    clock.advance(9999);
    assert.equal(walks().length, 0);
    clock.advance(1);
    assert.equal(walks().length, 1);
    assert.deepEqual(walks()[0], { type: 'walk', gen: t._gen(), mode: 'backfill', known: [] });
    assert.equal(t.status().phase, 'backfill');
    H.done(w, 'backfill');
    assert.equal(t.status().phase, 'idle');
    assert.ok(t.status().lastCatchupMs > 0);

    // Every 10 minutes after init.
    clock.advance(600000 - 10000 - 1);
    assert.equal(walks().length, 1);
    clock.advance(1);
    assert.equal(walks().length, 2);
    assert.equal(walks()[1].mode, 'catchup');
    H.done(w);
    clock.advance(600000);
    assert.equal(walks().length, 3);
    H.done(w);

    // Tokens tab opened (summary): a walk only when the last one is older than 60 s.
    clock.advance(60000);
    assert.equal(t.summary({}).name, 'summary');
    assert.equal(walks().length, 3, 'exactly 60 s old: not yet');
    clock.advance(1);
    const s = t.summary({});
    assert.equal(walks().length, 4);
    assert.equal(s.scan.phase, 'catchup');
    t.summary({});
    t.models({});
    assert.equal(walks().length, 4, 'not while one is running, and only from summary');
    H.done(w);
    t.summary({});
    assert.equal(walks().length, 4, 'and not within 60 s of the last one');
    for (const name of ['models', 'daily', 'sessions', 'context']) { clock.advance(61000); t[name]({}); }
    assert.equal(walks().length, 4, 'the other queries never trigger a walk');

    // A walk that has gone silent for 10 minutes is treated as a dead worker.
    clock.advance(600000);
    const running = walks().length;
    assert.ok(running >= 5);
    assert.equal(workers.made.length, 1);
    clock.advance(1200000);
    assert.equal(w.terminated, true, 'the silent worker is terminated');
    assert.equal(workers.made.length, 2, 'and replaced');
    assert.equal(walks().length, running, 'no second walk was stacked on the silent one');
  },

  respawnBackoff(H) {
    const { t } = H;
    const { workers, clock, ctx } = H.start();
    const made = () => workers.made.length;
    const g = t._gen();

    // A pass in flight when the worker dies is forgotten: its tail is not accepted later.
    const a = H.rel(SID);
    workers.last.emit('message', H.chunk(a, ['m1'], { msg: { last: false } }));
    assert.equal(H.n('responses'), 1);

    workers.last.emit('exit', 1);
    assert.equal(made(), 1, 'not immediately');
    clock.advance(4999);
    assert.equal(made(), 1);
    clock.advance(1);
    assert.equal(made(), 2, 'first respawn after 5 s');
    assert.equal(t._gen(), g, 'a respawn is not a new generation');
    assert.equal(workers.last.workerData.gen, g);
    H.hello(workers.last);
    assert.equal(workers.last.of('walk').length, 1, 'the new worker is asked for a walk: what was in flight is picked up');
    assert.deepEqual(t.applyChunk(H.chunk(a, ['m2'], { msg: { seq: 1 } })), { dropped: 'protocol' });
    assert.equal(t.status().phase, 'backfill');

    // error then exit of the same worker: one respawn, not two.
    workers.last.emit('error', new Error('boom'));
    workers.made[1].emit('exit', 1);
    assert.equal(t.status().phase, 'idle', 'the running walk is reset');
    clock.advance(29999);
    assert.equal(made(), 2);
    clock.advance(1);
    assert.equal(made(), 3, 'second respawn after 30 s');
    // Events from a worker that is no longer current are ignored.
    workers.made[0].emit('exit', 1);
    workers.made[1].emit('message', H.chunk(a, ['stray']));
    clock.advance(1000);
    assert.equal(made(), 3);

    workers.last.emit('exit', 1);
    clock.advance(119999);
    assert.equal(made(), 3);
    clock.advance(1);
    assert.equal(made(), 4, 'third respawn after 120 s');

    // A fourth exit inside the hour: the scanner stays down, the store stays up.
    workers.last.emit('exit', 1);
    clock.advance(1800000);
    assert.equal(made(), 4, 'at most 3 respawns per hour');
    assert.equal(t.status().state, 'ok');
    assert.match(t.status().reason, /scanner stopped/);
    assert.equal(t.summary({}).name, 'summary', 'queries still answer');
    assert.equal(t.noteChanged(a).queued, true);
    assert.equal(ctx.logs.filter((l) => l.includes('scanner stopped')).length, 1, 'logged once');

    // Once the hour has moved on, the 10-minute tick starts it again.
    clock.advance(1800000 + 240000);
    assert.equal(made(), 5);
    H.hello(workers.last);
    assert.equal(t.status().reason, null);

    // shutdown() terminates on purpose: no respawn, no timers, no more scanning.
    const last = workers.last;
    assert.deepEqual(t.shutdown(), { ok: true });
    assert.equal(last.terminated, true);
    last.emit('exit', 0);
    assert.equal(clock.count(), 0);
    clock.advance(7200000);
    assert.equal(made(), 5);
    assert.ok(typeof t.noteChanged(a).error === 'string');
    assert.ok(typeof t.flush().error === 'string');
    assert.ok(typeof t.rescan().error === 'string');
    assert.equal(clock.count(), 0);
    assert.equal(t.summary({}).name, 'summary', 'the store stays readable until close()');
    assert.deepEqual(t.close(), { ok: true });
    assert.equal(t._handle(), null);
  },

  spawnFails(H) {
    const { t } = H;
    let r;
    let started;
    assert.doesNotThrow(() => { started = H.start({ failFirst: true, noHello: true }); });
    const { workers, clock } = started;
    assert.equal(workers.calls, 1);
    assert.equal(workers.made.length, 0);
    assert.equal(t.status().state, 'ok', 'a scanner that cannot start costs the live numbers, not the store');
    assert.match(t.status().reason, /scanner failed to start: worker file missing/);
    clock.advance(5000);
    assert.equal(workers.made.length, 1, 'retried with the same backoff');
    H.hello(workers.last);
    assert.equal(t.status().reason, null);
    // A worker whose postMessage throws does not take the caller down.
    workers.last.postMessage = () => { throw new Error('channel closed'); };
    const a = H.rel(SID);
    H.touch(a);
    t.noteChanged(a);
    assert.doesNotThrow(() => clock.advance(3000));
    assert.doesNotThrow(() => { r = t.flush(); });
    assert.equal(r.ok, true);
    assert.equal(t.status().state, 'ok');
    assert.doesNotThrow(() => { r = t.applyChunk(H.chunk(a, ['m1'])); });
    assert.equal(r.ok, true, 'the chunk is stored even though the ack could not be posted');
  },

  workerMessages(H) {
    const { t } = H;
    const { workers, clock } = H.start();
    const w = workers.last;
    const a = H.rel(SID);
    const g = t._gen();

    // Current generation: stored, and acked after the commit.
    w.emit('message', H.chunk(a, ['m1', 'm2'], { msg: { last: false } }));
    assert.equal(H.n('responses'), 2);
    assert.deepEqual(w.of('ack'), [{ type: 'ack', gen: g, rel_path: a, seq: 0 }]);
    w.emit('message', H.chunk(a, ['m3'], { msg: { seq: 1 } }));
    assert.deepEqual(w.of('ack').pop(), { type: 'ack', gen: g, rel_path: a, seq: 1 });
    assert.equal(t._handle().prepare('SELECT indexed_bytes FROM files WHERE rel_path = ?').get(a).indexed_bytes, 5000);

    // Stale generation: dropped. Nothing written, nothing acked.
    const b = H.rel(SID_2);
    for (const stale of [g - 1, g + 1, undefined, '' + g]) {
      assert.doesNotThrow(() => w.emit('message', H.chunk(b, ['x1'], { sid: SID_2, msg: { gen: stale } })));
    }
    assert.equal(H.n('responses'), 3);
    assert.equal(H.n('files'), 1);
    assert.equal(w.of('ack').length, 2);

    // progress and done of another generation change nothing.
    clock.advance(10000);
    assert.equal(t.status().phase, 'backfill');
    w.emit('message', { type: 'progress', gen: g - 1, done: 50, total: 60 });
    assert.deepEqual([t.status().done, t.status().total], [0, 0]);
    w.emit('message', { type: 'done', gen: g - 1, mode: 'backfill', seen: [], missing: [] });
    assert.equal(H.meta('backfill_done'), '');
    assert.equal(t.status().phase, 'backfill');
    w.emit('message', { type: 'progress', gen: g, done: 5, total: 60, warn: 'readdir failed: proj-x' });
    assert.deepEqual([t.status().done, t.status().total], [5, 60]);
    w.emit('message', { type: 'done', gen: g, mode: 'backfill', seen: [a], missing: [] });
    assert.ok(H.meta('backfill_done'));
    assert.equal(t.status().phase, 'idle');

    // Garbage on the channel never throws and never disables the store.
    for (const m of [null, undefined, 'x', 42, [], {}, { type: 'nope', gen: g }, { type: 'chunk' }, { type: 'chunk', gen: g },
      { type: 'chunk', gen: g, rel_path: a, seq: 'x' }, { type: 'done' }, { type: 'progress', gen: g, done: 'x' },
      { type: 'hello' }, { type: 'done', gen: g, missing: 'nope' }]) {
      assert.doesNotThrow(() => w.emit('message', m));
    }
    assert.equal(t.status().state, 'ok', String(t.status().reason));
    assert.equal(H.n('responses'), 3);
  },

  broadcast(H) {
    const { t } = H;
    const { ctx, clock } = H.start();
    const sent = ctx.sent;
    assert.equal(sent.length, 0);
    const a = H.rel(SID);
    const b = H.rel(SID_2);
    // Five commits in the same instant: one message now, one a second later.
    assert.equal(t.applyChunk(H.chunk(a, ['m1'])).ok, true);
    for (let i = 2; i <= 5; i++) assert.equal(t.applyChunk(H.chunk(b, ['m' + i], { sid: SID_2 })).ok, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { channel: 'token-stats-changed', at: clock.now(),
      payload: { phase: 'idle', done: 0, total: 0, changedSessions: [SID] } });
    clock.advance(999);
    assert.equal(sent.length, 1);
    clock.advance(1);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].payload, { phase: 'idle', done: 0, total: 0, changedSessions: [SID_2] });
    // Nothing changed: nothing is sent.
    clock.advance(5000);
    assert.equal(sent.length, 2);
    // A steady stream for 3 s: at most one per second.
    const start = sent.length;
    for (let i = 0; i < 30; i++) {
      assert.equal(t.applyChunk(H.chunk(a, ['s' + i])).ok, true);
      clock.advance(100);
    }
    clock.advance(1000);
    const burst = sent.slice(start);
    // 3 s of commits plus the trailing second: one at the start, then one per second.
    assert.ok(burst.length >= 3 && burst.length <= 5, 'got ' + burst.length);
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 1000, 'never closer than 1 s');
  },
};

// --------------------------------------------------------------- child main ----

function childMain() {
  const name = process.env.TOKEN_USAGE_SCENARIO;
  const fn = SCENARIOS[name];
  assert.equal(typeof fn, 'function', 'unknown scenario ' + name);
  fn(makeHarness());
  fs.writeSync(1, '\nRESULT ok\n');
  process.exit(0);
}

// -------------------------------------------------------------- parent half ----

function parentMain() {
  const test = require('node:test');
  const { spawnSync } = require('child_process');
  const electronBin = require('electron');     // under plain node: the path to the binary

  function run(name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-sched-'));
    const dataDir = path.join(root, 'data');
    assert.ok(path.resolve(dataDir).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep));
    try {
      const r = spawnSync(electronBin, [__filename], {
        cwd: APP_DIR,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir, TOKEN_USAGE_SCENARIO: name },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, 'scenario ' + name + ' failed\n' + r.stderr + '\n' + r.stdout);
      assert.ok(r.stdout.includes('RESULT ok'), 'scenario ' + name + ' did not finish\n' + r.stdout + r.stderr);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const titles = {
    flushRule: 'flush after 3 s quiet OR 10 s after the first pending event, whichever comes first',
    flushCarriesStoredRow: 'flush posts one scan with the stored files rows; ENOENT marks a known file missing',
    waitsForHello: 'noteChanged before init is a no-op; nothing is posted before the worker says hello',
    boundedPending: 'the pending set is bounded at 10,000: past that it is dropped and the next flush walks',
    catchup: 'startup walk on the deferred start, catch-up every 10 minutes, and from summary() after 60 s',
    respawnBackoff: 'worker exit: respawn after 5 s, 30 s, 120 s, at most 3 per hour; shutdown does not respawn',
    spawnFails: 'a worker that cannot start or cannot be posted to never throws into the caller',
    workerMessages: 'worker messages: chunks are acked after commit; a stale-gen chunk, progress or done is dropped',
    broadcast: 'token-stats-changed is sent at most once per second',
  };
  for (const name of Object.keys(titles)) {
    test(titles[name], () => { run(name); });
  }
}

if (process.env.TOKEN_USAGE_SCENARIO) childMain();
else parentMain();
