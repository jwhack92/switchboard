'use strict';
// The token store against a real database (design 7.3).
//
// better-sqlite3 is built for Electron's ABI, so every scenario runs in a child:
// this same file, started with the Electron binary as Node and
// TOKEN_USAGE_SCENARIO naming the scenario. The parent half (plain `node
// --test`) only spawns children and reads their result.
//
// Contract rule 5: the real ~/.switchboard is never opened. Each child gets an
// explicit temp dataDir AND SWITCHBOARD_DATA_DIR pointing at the same folder,
// and refuses to run unless that folder is under os.tmpdir().
//
// Rows are seeded through applyChunk with hand-built chunk messages (the path
// a worker message takes). Nothing here needs the parser, the worker or the
// queries module to exist: the queries module is replaced by a stub.
//
// The five queries are asynchronous (they normally run in the query worker).
// Here ctx.createQueryWorker always throws, which is the "worker cannot start"
// case: the facade then runs them inline on the store's own handle, against
// the stub. The worker itself is test/token-usage-query-worker.test.js.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const MOD = path.join(APP_DIR, 'token-usage.js');

const SID_O = '11111111-1111-4111-8111-111111111111';
const SID_C = '22222222-2222-4222-8222-222222222222';
const SID_X = '33333333-3333-4333-8333-333333333333';
const T0 = Date.parse('2026-10-03T18:00:00Z');

// ------------------------------------------------------------ child helpers ----

function tempDirs() {
  const raw = process.env.SWITCHBOARD_DATA_DIR;
  assert.ok(raw, 'SWITCHBOARD_DATA_DIR must be set for a database test');
  const dataDir = path.resolve(raw);
  const tmp = path.resolve(os.tmpdir());
  assert.ok(dataDir.toLowerCase().startsWith(tmp.toLowerCase() + path.sep),
    'refusing to open a database outside os.tmpdir(): ' + dataDir);
  const root = path.dirname(dataDir);
  return { dataDir, root, projectsDir: path.join(root, 'projects') };
}

function fakeClock() {
  let now = 1791000000000;
  let seq = 0;
  const timers = new Map();
  function earliest(limit) {
    let best = null;
    for (const t of timers.values()) {
      if (limit !== undefined && t.at > limit) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }
  function fire(t) {
    timers.delete(t.id);
    if (t.at > now) now = t.at;
    t.fn();
  }
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { id, fn, at: now + Math.max(0, ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    count: () => timers.size,
    step() { const t = earliest(); if (!t) return false; fire(t); return true; },
    advance(ms) {
      const target = now + ms;
      for (let t = earliest(target); t; t = earliest(target)) fire(t);
      now = target;
    },
  };
}

function stubWorkers() {
  const { EventEmitter } = require('events');
  const made = [];
  return {
    made,
    get last() { return made[made.length - 1]; },
    createWorker(workerPath, workerData) {
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

// The queries module is another agent's file: every scenario runs with a stub
// in its place, so these tests say nothing about it and need nothing from it.
let queriesStub = { exports: { createQueries: () => ({}) } };
function installQueriesStub() {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request) {
    if (/token-usage-queries(\.js)?$/.test(request)) {
      if (queriesStub.throws) throw queriesStub.throws;
      return queriesStub.exports;
    }
    return origLoad.apply(this, arguments);
  };
}

function makeHarness() {
  const dirs = tempDirs();
  fs.mkdirSync(dirs.projectsDir, { recursive: true });
  installQueriesStub();
  const t = require(MOD);
  const H = { t, dirs, dbFile: path.join(dirs.dataDir, 'token-usage.db'), offFile: path.join(dirs.dataDir, 'token-usage.off') };

  H.ctx = (extra) => {
    const logs = [];
    const sent = [];
    const clock = fakeClock();
    const log = {};
    for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => logs.push(level + ': ' + m);
    return Object.assign({
      log, logs, sent, clock,
      projectsDir: dirs.projectsDir,
      dataDir: dirs.dataDir,
      appVersion: '0.0.0-test',
      createQueryWorker: () => { throw new Error('no query worker in this test'); },
      broadcast: (channel, payload) => sent.push({ channel, payload, at: clock.now() }),
    }, extra || {});
  };

  // init, with a stub worker that has said hello when opts.worker is set.
  H.start = (opts) => {
    const o = opts || {};
    const workers = o.worker ? stubWorkers() : null;
    const ctx = H.ctx(workers ? { createWorker: workers.createWorker, workerPath: 'stub-worker.js' } : null);
    const r = t.init(ctx);
    assert.deepEqual(r, { ok: true, state: 'ok' });
    if (workers) H.hello(workers.last);
    return { ctx, workers };
  };
  H.hello = (w, pv) => w.emit('message', { type: 'hello', gen: w.workerData.gen, parseVersion: pv === undefined ? 1 : pv });

  H.touch = (rel) => {
    const abs = path.join(dirs.projectsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '{}\n');
  };
  H.remove = (rel) => fs.unlinkSync(path.join(dirs.projectsDir, rel));

  H.mainRow = (sid, o) => Object.assign({
    rel_path: 'proj/' + sid + '.jsonl', kind: 'main', slug: 'proj', session_id: sid, agent_id: null, wf_id: null,
    size: 5000, mtime_ms: 1791000000000, birthtime_ms: 1000, head_hash: 'v1:head-' + sid, indexed_bytes: 5000,
    tail_hash: 'tail-' + sid,
  }, o);
  H.agentRow = (sid, agent, o) => Object.assign({
    rel_path: 'proj/' + sid + '/subagents/' + agent + '.jsonl', kind: 'subagent', slug: 'proj', session_id: sid,
    agent_id: agent, wf_id: null, size: 6000, mtime_ms: 1791000000000, birthtime_ms: 3000,
    head_hash: 'v1:head-' + agent, indexed_bytes: 6000, tail_hash: 'tail-' + agent,
  }, o);
  // A candidate in the contract 6.1 shape: no file_id, no local_day.
  H.cand = (id, fr, o) => Object.assign({
    message_id: id, session_id: fr.session_id, kind: fr.kind, slug: fr.slug, wf_id: fr.wf_id, agent_id: fr.agent_id,
    owner_birth_ms: fr.birthtime_ms, model: 'claude-opus-5-5', ts_ms: T0, input: 10, output: 100, cache_write: 20,
    cache_write_5m: 20, cache_write_1h: 0, cache_read: 1000, thinking: null, finalized: 1, stop_reason: 'end_turn',
  }, o);
  H.chunk = (fr, candidates, o) => Object.assign({
    type: 'chunk', gen: t._gen(), rel_path: fr.rel_path, seq: 0, last: true, fileRow: fr,
    candidates: candidates || [], compactions: [], fullRescan: false, lines_skipped: 0,
  }, o);
  H.apply = (msg) => {
    const r = t.applyChunk(msg);
    assert.equal(r.ok, true, 'applyChunk: ' + JSON.stringify(r));
    return r;
  };

  H.all = (sql, ...args) => t._handle().prepare(sql).all(...args);
  H.get = (sql, ...args) => t._handle().prepare(sql).get(...args);
  H.n = (table) => H.get('SELECT COUNT(*) AS n FROM ' + table).n;
  H.meta = (key) => { const r = H.get('SELECT value FROM meta WHERE key = ?', key); return r ? r.value : null; };
  H.file = (rel) => H.get('SELECT * FROM files WHERE rel_path = ?', rel);
  H.resp = (id) => H.get('SELECT * FROM responses WHERE message_id = ?', id);
  H.dump = () => ({
    responses: H.all('SELECT * FROM responses ORDER BY message_id'),
    sightings: H.all('SELECT * FROM sightings ORDER BY message_id, file_id'),
    compactions: H.all('SELECT * FROM compactions ORDER BY uuid'),
  });
  H.master = () => H.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
  H.listData = () => fs.readdirSync(dirs.dataDir).sort();
  return H;
}

// The four invariants of design 7.3, run after every scenario.
function checkInvariants(db) {
  const one = (sql) => db.prepare(sql).get();
  const c = one('SELECT COUNT(*) AS n, COUNT(DISTINCT message_id) AS d FROM responses');
  assert.equal(c.n, c.d, 'COUNT(*) = COUNT(DISTINCT message_id)');
  for (const col of ['input', 'output', 'cache_write', 'cache_read']) {
    const grand = one('SELECT COALESCE(SUM(' + col + '), 0) AS v FROM responses').v;
    const perSession = db.prepare('SELECT COALESCE(SUM(' + col + '), 0) AS v FROM responses GROUP BY session_id').all()
      .reduce((sum, r) => sum + r.v, 0);
    assert.equal(perSession, grand, 'per-session ' + col + ' adds up to the grand total');
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM responses r WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = r.file_id)').n,
    0, 'every responses.file_id exists in files');
  assert.equal(one('SELECT COUNT(*) AS n FROM responses r WHERE NOT EXISTS ' +
    '(SELECT 1 FROM sightings s WHERE s.message_id = r.message_id AND s.file_id = r.file_id)').n,
    0, 'every owner row has its own sighting');
  assert.equal(one('SELECT COUNT(*) AS n FROM responses WHERE cache_write_5m + cache_write_1h > cache_write').n,
    0, 'the cache-write split never exceeds the counter');
  return c.n;
}

function invariantsAfter(H) {
  let db = H.t._handle();
  if (db) return checkInvariants(db);
  let st = null;
  try { st = fs.statSync(H.dbFile); } catch { return null; }
  if (!st.isFile()) return null;
  db = new (require('better-sqlite3'))(H.dbFile, { readonly: true });
  try { return checkInvariants(db); } finally { db.close(); }
}

const LIFECYCLE = ['init', 'noteChanged', 'flush', 'rescan', 'disable', 'enable', 'applyChunk'];
const QUERY_NAMES = ['summary', 'models', 'daily', 'sessions', 'context'];
const GARBAGE = [undefined, null, 0, 42, NaN, '', 'x', '../../etc/passwd', true, [], [1, 2], {}, { gen: 'x' },
  { gen: 1, rel_path: 5, seq: 'a' }, { type: 'chunk', candidates: 'no', fileRow: 7 }, () => {}, Symbol('s'), 10n];

function isError(r) { return !!r && typeof r === 'object' && typeof r.error === 'string' && r.error.length > 0; }

function isThenable(r) { return !!r && typeof r === 'object' && typeof r.then === 'function'; }

// Every export, every garbage argument: nothing may throw, and a query's
// Promise may not reject (it resolves to an object, whatever it was given).
async function callEverything(t, skip) {
  let calls = 0;
  const promised = [];
  const call = (name, args, label) => {
    let r;
    assert.doesNotThrow(() => { r = t[name](...args); }, label);
    if (QUERY_NAMES.includes(name)) assert.ok(isThenable(r), label + ' returns a Promise');
    if (isThenable(r)) promised.push({ label, p: r });
    calls++;
  };
  for (const name of Object.keys(t)) {
    if (typeof t[name] !== 'function' || (skip && skip.includes(name))) continue;
    for (const g of GARBAGE) {
      call(name, [g], name + '(' + String(typeof g) + ')');
      call(name, [g, g, g], name + ' with three garbage arguments');
    }
    call(name, [], name + '()');
  }
  for (const { label, p } of promised) {
    let v;
    try { v = await p; } catch (err) { assert.fail(label + ' rejected: ' + (err && err.message)); }
    assert.ok(v && typeof v === 'object', label + ' resolves to an object');
    assert.ok(v.scan && typeof v.scan === 'object', label + ' carries scan');
  }
  return calls;
}

// `except`: names not checked here. rescan() on a store that is off because of
// a FAILURE is the "Try again" path (it re-runs init), checked by the caller.
async function assertUnavailable(t, label, except) {
  for (const name of LIFECYCLE.concat(QUERY_NAMES)) {
    // init and enable are the way back, and disable on a store that is already
    // off is a legitimate request (it writes the flag): all three are checked by the caller.
    if (name === 'init' || name === 'enable' || name === 'disable') continue;
    if (except && except.includes(name)) continue;
    const r = await t[name]({});
    assert.ok(isError(r), label + ': ' + name + ' returns { error }, got ' + JSON.stringify(r));
  }
  assert.equal(t.status().state, 'disabled', label);
  assert.equal(t.status().files, null, label + ': no file count while the store is not open');
  assert.equal(t._handle(), null, label);
}

// --------------------------------------------------------------- scenarios ----

const SCENARIOS = {
  fresh(H) {
    const { t } = H;
    assert.equal(fs.existsSync(H.dbFile), false);
    const ctx = H.ctx();
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    assert.equal(fs.statSync(H.dbFile).isFile(), true);
    assert.equal(H.meta('schema_version'), String(t.SCHEMA_VERSION));
    assert.equal(H.meta('backfill_done'), '');
    assert.equal(H.meta('app_version'), '0.0.0-test');
    assert.equal(H.meta('tz'), Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(t._handle().pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(t._handle().pragma('synchronous', { simple: true }), 1);       // NORMAL
    assert.equal(t._handle().pragma('busy_timeout', { simple: true }), 5000);
    const names = H.master().map((r) => r.type + ':' + r.name);
    for (const table of ['meta', 'files', 'responses', 'sightings', 'compactions']) assert.ok(names.includes('table:' + table), table);
    assert.equal(names.filter((n) => n.startsWith('index:idx_')).length, 0, 'secondary indexes wait for the first backfill');
    const scan = t.status();
    assert.equal(scan.state, 'ok');
    assert.equal(scan.phase, 'idle');
    assert.equal(scan.backfillDone, null);
    for (const key of ['state', 'reason', 'phase', 'done', 'total', 'backfillDone', 'lastScanMs', 'lastCatchupMs',
      'filesWithErrors', 'filesMissing', 'linesSkipped', 'parseVersion', 'pricesVersion',
      'reasonCode', 'files', 'queryMode']) assert.ok(key in scan, key);
    assert.equal(scan.reasonCode, null, 'an open store has no reason code');
    assert.equal(scan.files, 0, 'files is the row count of the files table');
    assert.equal(scan.queryMode, 'worker', 'no query has been asked yet: the worker is where the next one goes');
    const O = H.mainRow(SID_O);
    const C = H.mainRow(SID_C, { birthtime_ms: 2000 });
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    H.apply(H.chunk(C, [H.cand('m2', C)]));
    assert.equal(t.status().files, 2);
    // A second init in the same process changes nothing and keeps the generation.
    const g = t._gen();
    const before = JSON.stringify(H.master());
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    assert.deepEqual(t.init(H.ctx()), { ok: true, state: 'ok' });
    assert.equal(t._gen(), g);
    assert.equal(JSON.stringify(H.master()), before);
  },

  garbageFile(H) {
    const { t } = H;
    fs.mkdirSync(H.dirs.dataDir, { recursive: true });
    const junk = 'this is not a database. '.repeat(400);
    fs.writeFileSync(H.dbFile, junk);
    const ctx = H.ctx();
    let r;
    assert.doesNotThrow(() => { r = t.init(ctx); });
    assert.deepEqual(r, { ok: true, state: 'ok' });
    const kept = H.listData().filter((f) => /^token-usage\.db\.corrupt-\d+$/.test(f));
    assert.equal(kept.length, 1, 'the corrupt file is kept under another name: ' + H.listData().join(','));
    assert.equal(fs.readFileSync(path.join(H.dirs.dataDir, kept[0]), 'utf8'), junk, 'and its bytes are untouched');
    assert.equal(t.status().state, 'ok');
    assert.equal(H.meta('schema_version'), String(t.SCHEMA_VERSION));
    assert.equal(H.meta('backfill_done'), '');
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    assert.equal(H.n('responses'), 1);
    assert.ok(ctx.logs.some((l) => l.startsWith('error: [token-usage] store is corrupt')), ctx.logs.join('\n'));
  },

  schemaBump(H) {
    const { t } = H;
    H.start();
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('m1', O), H.cand('m2', O)]));
    t._handle().prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    t._handle().prepare("UPDATE meta SET value = '2026-10-03T00:00:00.000Z' WHERE key = 'backfill_done'").run();
    const g = t._gen();
    assert.deepEqual(t.close(), { ok: true });
    assert.equal(t._handle(), null);
    assert.deepEqual(t.init(H.ctx()), { ok: true, state: 'ok' });
    assert.ok(t._gen() > g, 'the generation moves on a rebuild');
    assert.equal(H.meta('schema_version'), String(t.SCHEMA_VERSION));
    assert.equal(H.meta('backfill_done'), '', 'a full backfill has to run');
    for (const table of ['files', 'responses', 'sightings', 'compactions']) assert.equal(H.n(table), 0, table);
    assert.equal(t.status().state, 'ok');

    // A store whose meta has lost schema_version is rebuilt too, never trusted.
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    t._handle().prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    t.close();
    assert.deepEqual(t.init(H.ctx()), { ok: true, state: 'ok' });
    assert.equal(H.n('responses'), 0);
    assert.equal(H.meta('schema_version'), String(t.SCHEMA_VERSION));
  },

  upsertRules(H) {
    const { t } = H;
    H.start();
    const O = H.mainRow(SID_O, { birthtime_ms: 1000 });
    const C = H.mainRow(SID_C, { birthtime_ms: 2000 });
    const placeholder = { finalized: 0, stop_reason: null, output: 4, ts_ms: T0 };

    // Counter rule (1.4), one file.
    H.apply(H.chunk(O, [H.cand('p-then-f', O, placeholder), H.cand('f-then-p', O, { output: 300, ts_ms: T0 + 5000 }),
      H.cand('grow', O, placeholder), H.cand('tie', O, { output: 50, ts_ms: T0 + 1000 })]));
    const oId = H.file(O.rel_path).id;
    assert.equal(H.resp('p-then-f').local_day, t.localDay(T0), 'local_day is stamped by the store');
    H.apply(H.chunk(O, [
      H.cand('p-then-f', O, { output: 300, ts_ms: T0 + 9000, model: 'claude-sonnet-5', input: 11, cache_read: 7 }),
      H.cand('f-then-p', O, Object.assign({}, placeholder, { output: 9999, ts_ms: T0 + 9000 })),
      H.cand('grow', O, Object.assign({}, placeholder, { output: 8, ts_ms: T0 - 60000 })),
      H.cand('tie', O, { output: 50, ts_ms: T0 + 2000 }),
    ]));
    assert.equal(H.file(O.rel_path).id, oId, 'the files row keeps its id (ON CONFLICT DO UPDATE, not REPLACE)');
    let r = H.resp('p-then-f');
    assert.deepEqual([r.finalized, r.output, r.ts_ms, r.model, r.input, r.cache_read, r.stop_reason],
      [1, 300, T0 + 9000, 'claude-sonnet-5', 11, 7, 'end_turn'], 'a finalised line replaces a placeholder as a unit');
    r = H.resp('f-then-p');
    assert.deepEqual([r.finalized, r.output, r.ts_ms], [1, 300, T0 + 5000], 'a placeholder never replaces a finalised line');
    r = H.resp('grow');
    assert.deepEqual([r.finalized, r.output, r.ts_ms], [0, 8, T0 - 60000], 'same state: the larger output wins');
    assert.equal(H.resp('tie').ts_ms, T0 + 2000, 'equal output: the later timestamp wins');
    H.apply(H.chunk(O, [H.cand('tie', O, { output: 50, ts_ms: T0 + 1500 }), H.cand('grow', O, Object.assign({}, placeholder, { output: 6 }))]));
    assert.equal(H.resp('tie').ts_ms, T0 + 2000, 'equal output, earlier timestamp: kept');
    assert.equal(H.resp('grow').output, 8, 'smaller output: kept');

    // Ownership (1.5): the continuation is scanned first, the earlier-born original takes over.
    H.apply(H.chunk(C, [H.cand('shared', C, { output: 500 }), H.cand('own-c', C)]));
    const cId = H.file(C.rel_path).id;
    r = H.resp('shared');
    assert.deepEqual([r.file_id, r.session_id, r.owner_birth_ms], [cId, SID_C, 2000]);
    H.apply(H.chunk(O, [H.cand('shared', O, placeholder)]));
    r = H.resp('shared');
    assert.deepEqual([r.file_id, r.session_id, r.owner_birth_ms], [oId, SID_O, 1000], 'the earlier-born main file takes the row over');
    assert.deepEqual([r.finalized, r.output], [1, 500], 'while the better counters stay (the two rules are independent)');
    H.apply(H.chunk(C, [H.cand('shared', C, { output: 500 })]));
    assert.equal(H.resp('shared').file_id, oId, 'a later-born file never takes it back');
    assert.deepEqual(H.all("SELECT file_id FROM sightings WHERE message_id = 'shared' ORDER BY file_id").map((x) => x.file_id),
      [oId, cId].sort((a, b) => a - b), 'both files are recorded as sightings');

    // A subagent line never takes over, whatever its file's birth time.
    const A = H.agentRow(SID_X, 'agent-a1', { birthtime_ms: 5 });
    H.apply(H.chunk(A, [H.cand('own-c', A), H.cand('sub-1', A)]));
    assert.equal(H.resp('own-c').file_id, cId);
    assert.equal(H.resp('own-c').kind, 'main');
    const B = H.agentRow(SID_X, 'agent-b1', { birthtime_ms: 1 });
    H.apply(H.chunk(B, [H.cand('sub-1', B)]));
    assert.equal(H.resp('sub-1').agent_id, 'agent-a1', 'subagent rows keep their first owner');

    // Rows that cannot be stored are skipped, not thrown; the rest of the chunk lands.
    const res = H.apply(H.chunk(O, [null, 'x', H.cand('', O), H.cand('no-ts', O, { ts_ms: 'yesterday' }),
      H.cand('neg', O, { output: -1 }), H.cand('bad-kind', O, { kind: 'other' }), H.cand('fine', O)]));
    assert.deepEqual([res.written, res.rejected], [1, 6]);
    assert.ok(H.resp('fine'));

    // Compactions dedupe on uuid across files.
    const comp = (uuid, fr) => ({ uuid, session_id: fr.session_id, slug: fr.slug, ts_ms: T0, trigger: 'auto', pre_tokens: 400000, post_tokens: 30000 });
    H.apply(H.chunk(O, [], { compactions: [comp('u1', O)] }));
    H.apply(H.chunk(C, [], { compactions: [comp('u1', C), comp('u2', C), { uuid: 7 }] }));
    assert.deepEqual(H.all('SELECT uuid, file_id, trigger FROM compactions ORDER BY uuid'),
      [{ uuid: 'u1', file_id: oId, trigger: 'auto' }, { uuid: 'u2', file_id: cId, trigger: 'auto' }]);
  },

  ownershipIsCommutative(H) {
    // The same two files in both scan orders give the same rows.
    const { t } = H;
    H.start();
    const O = H.mainRow(SID_O, { birthtime_ms: 1000 });
    const C = H.mainRow(SID_C, { birthtime_ms: 2000 });
    const oC = () => [H.cand('a', O), H.cand('b', O, { finalized: 0, stop_reason: null, output: 4 }), H.cand('c', O, { ts_ms: T0 + 1 })];
    const cC = () => [H.cand('a', C, { ts_ms: T0 + 77 }), H.cand('b', C, { output: 250 }), H.cand('c', C), H.cand('d', C)];
    const strip = (rows) => rows.map((r) => Object.assign({}, r, { file_id: r.session_id }));
    H.apply(H.chunk(O, oC()));
    H.apply(H.chunk(C, cC()));
    const forward = strip(H.dump().responses);
    assert.deepEqual(t.rescan(), { ok: true });
    H.apply(H.chunk(C, cC()));
    H.apply(H.chunk(O, oC()));
    assert.deepEqual(strip(H.dump().responses), forward);
    assert.equal(forward.filter((r) => r.session_id === SID_O).length, 3, 'a, b, c belong to the original');
  },

  cascade(H) {
    const { t } = H;
    const { ctx, workers } = H.start({ worker: true });
    const O = H.mainRow(SID_O, { birthtime_ms: 1000 });
    const C = H.mainRow(SID_C, { birthtime_ms: 2000 });
    const G = H.mainRow(SID_X, { birthtime_ms: 3000 });
    H.touch(O.rel_path);
    H.touch(C.rel_path);
    const comp = (uuid, fr) => ({ uuid, session_id: fr.session_id, slug: fr.slug, ts_ms: T0, trigger: 'manual', pre_tokens: 1, post_tokens: 1 });
    // C is a continuation: a copy of O's ids plus its own. The finalised line of
    // 'b' lives only in the copy.
    const oMsg = (o) => H.chunk(O, [H.cand('a', O), H.cand('b', O, { finalized: 0, stop_reason: null, output: 4 }), H.cand('c', O)],
      Object.assign({ compactions: [comp('u1', O)] }, o));
    const cMsg = (o) => H.chunk(C, [H.cand('a', C), H.cand('b', C, { output: 250 }), H.cand('c', C), H.cand('d', C, { output: 7 }), H.cand('e', C)],
      Object.assign({ compactions: [comp('u1', C), comp('u2', C)] }, o));

    H.apply(oMsg());
    H.apply(cMsg());
    const oId = H.file(O.rel_path).id;
    const cId = H.file(C.rel_path).id;
    assert.deepEqual(H.all('SELECT message_id, file_id FROM responses ORDER BY message_id').map((r) => r.message_id + ':' + r.file_id),
      ['a:' + oId, 'b:' + oId, 'c:' + oId, 'd:' + cId, 'e:' + cId]);
    assert.deepEqual([H.resp('b').finalized, H.resp('b').output], [1, 250]);
    const before = H.dump();
    const scansBefore = workers.last.of('scan').length;

    // Full rescan of O. Same owner afterwards, but the row is the placeholder
    // again until the copy is rescanned: exactly what the cascade repairs.
    H.apply(oMsg({ fullRescan: true }));
    assert.equal(H.resp('b').file_id, oId, 'deleted then re-inserted with the same owner');
    assert.deepEqual([H.resp('b').finalized, H.resp('b').output], [0, 4]);
    let c = H.file(C.rel_path);
    assert.deepEqual([c.indexed_bytes, c.head_hash, c.tail_hash], [0, null, null], 'the copy is reset so it is fully rescanned');
    assert.equal(H.file(O.rel_path).indexed_bytes, 5000);
    checkInvariants(t._handle());

    // A pass of C that the worker resumed from a row older than the reset (a
    // walk works from the list it was given at its start) must not write the
    // offset back: that would undo the reset and the copies would stay lost.
    const acksBefore = workers.last.of('ack').length;
    assert.deepEqual(t.applyChunk(cMsg()), { dropped: 'stale row' });
    c = H.file(C.rel_path);
    assert.deepEqual([c.indexed_bytes, c.head_hash, c.tail_hash], [0, null, null], 'the reset survives');
    assert.deepEqual([H.resp('b').finalized, H.resp('b').output], [0, 4], 'and nothing of the stale pass was stored');
    assert.deepEqual(workers.last.of('ack').slice(acksBefore),
      [{ type: 'ack', gen: t._gen(), rel_path: C.rel_path, seq: 0, dropped: true }], 'the worker is told, so it does not stall');

    // Run the flush: the copy is sent to the worker with its reset row.
    ctx.clock.advance(3000);
    const scans = workers.last.of('scan');
    assert.equal(scans.length, scansBefore + 1);
    const scan = scans[scans.length - 1];
    assert.equal(scan.gen, t._gen());
    assert.deepEqual(scan.files.map((f) => f.rel_path), [C.rel_path]);
    assert.deepEqual([scan.files[0].prev.head_hash, scan.files[0].prev.indexed_bytes], [null, 0]);
    // What the worker answers for a row that cannot resume: a full rescan.
    H.apply(cMsg({ fullRescan: true }));
    assert.deepEqual(H.dump(), before, 'after the flush every row equals the state before the rescan');
    // The rescan of C does not queue O back.
    ctx.clock.advance(30000);
    assert.equal(workers.last.of('scan').length, scansBefore + 1, 'the cascade ends');
    assert.equal(H.file(O.rel_path).indexed_bytes, 5000);
    c = H.file(C.rel_path);
    assert.deepEqual([c.indexed_bytes, c.head_hash], [5000, C.head_hash]);

    // O deleted from disk (decision: keep the rows, mark the file missing).
    H.remove(O.rel_path);
    assert.deepEqual(t.noteChanged(O.rel_path.replace(/\//g, '\\')), { ok: true, queued: true });
    ctx.clock.advance(3000);
    assert.equal(workers.last.of('scan').length, scansBefore + 1, 'a missing file is not sent to the worker');
    const gone = H.file(O.rel_path);
    assert.equal(gone.missing_since, ctx.clock.now());
    assert.deepEqual(H.dump(), before, 'the rows of a missing file are kept');
    assert.equal(t.status().filesMissing, 1);
    // A second sighting of the same absence keeps the first date.
    t.noteChanged(O.rel_path);
    ctx.clock.advance(3000);
    assert.equal(H.file(O.rel_path).missing_since, gone.missing_since);

    // The walk's missing list is checked again here: only ENOENT counts.
    H.apply(H.chunk(G, [H.cand('g1', G)]));
    workers.last.emit('message', { type: 'done', gen: t._gen(), mode: 'catchup', seen: [C.rel_path],
      missing: [G.rel_path, C.rel_path, 'proj/never-indexed.jsonl', 42, '../outside.jsonl'] });
    assert.ok(H.file(G.rel_path).missing_since > 0, 'ENOENT: marked');
    assert.equal(H.file(C.rel_path).missing_since, null, 'still on disk: not marked, whatever the worker said');
    assert.equal(t.status().filesMissing, 2);
    assert.equal(H.n('responses'), 6);

    // The file comes back: the next pass clears the mark.
    H.touch(O.rel_path);
    H.apply(oMsg());
    assert.equal(H.file(O.rel_path).missing_since, null);

    // Totals equal a fresh rebuild (Rebuild, then the same files as a backfill delivers them).
    const withG = H.dump();
    assert.deepEqual(t.rescan(), { ok: true });
    assert.equal(H.n('responses'), 0);
    H.apply(oMsg());
    H.apply(cMsg());
    H.apply(H.chunk(G, [H.cand('g1', G)]));
    assert.deepEqual(H.dump(), withG, 'incremental state equals a fresh rebuild');
  },

  cascadeGuard(H) {
    // Two agent files that each own a row the other sighted would queue each
    // other forever. One cascade cycle rescans a file at most once.
    const { t } = H;
    const { ctx, workers } = H.start({ worker: true });
    const A = H.agentRow(SID_O, 'agent-aaa');
    const B = H.agentRow(SID_O, 'agent-bbb');
    H.touch(A.rel_path);
    H.touch(B.rel_path);
    H.apply(H.chunk(A, [H.cand('x', A)]));
    H.apply(H.chunk(B, [H.cand('y', B), H.cand('x', B)]));
    H.apply(H.chunk(A, [H.cand('y', A)]));
    const aId = H.file(A.rel_path).id;
    const bId = H.file(B.rel_path).id;
    assert.deepEqual([H.resp('x').file_id, H.resp('y').file_id], [aId, bId], 'mutual ownership');
    const scanCount = () => workers.last.of('scan').length;
    const base = scanCount();

    H.apply(H.chunk(A, [H.cand('x', A), H.cand('y', A)], { fullRescan: true }));
    assert.equal(H.file(B.rel_path).indexed_bytes, 0, 'B is reset and queued');
    ctx.clock.advance(3000);
    assert.equal(scanCount(), base + 1);
    assert.deepEqual(workers.last.of('scan').pop().files.map((f) => f.rel_path), [B.rel_path]);
    H.apply(H.chunk(B, [H.cand('y', B), H.cand('x', B)], { fullRescan: true }));
    assert.equal(H.file(A.rel_path).indexed_bytes, 6000, 'A was rescanned in this cycle: not reset again');
    ctx.clock.advance(60000);
    assert.equal(scanCount(), base + 1, 'no ping-pong');
    assert.ok(ctx.logs.some((l) => l.includes('already rescanned in this cycle')), ctx.logs.join('\n'));
    assert.equal(H.n('responses'), 2);

    // The guard is per cycle, not for ever: a later full rescan cascades again.
    t.noteChanged('proj/' + SID_X + '.jsonl');     // an unrelated flush ends the cycle (ENOENT, no row: nothing to mark)
    ctx.clock.advance(3000);
    const owner = H.resp('y').file_id === bId ? B : A;
    const other = owner === B ? A : B;
    H.apply(H.chunk(owner, [H.cand('x', owner), H.cand('y', owner)], { fullRescan: true }));
    assert.equal(H.file(other.rel_path).indexed_bytes, 0, 'a new cycle queues the other file again');
  },

  generation(H) {
    const { t } = H;
    const { workers, ctx } = H.start({ worker: true });
    const O = H.mainRow(SID_O);
    const w = workers.last;

    // Stale generation: nothing written, no ack, no throw.
    for (const stale of [t._gen() - 1, t._gen() + 1, undefined, null, String(t._gen())]) {
      let r;
      assert.doesNotThrow(() => { r = t.applyChunk(H.chunk(O, [H.cand('m1', O)], { gen: stale })); });
      assert.deepEqual(r, { dropped: 'stale gen' });
    }
    assert.deepEqual([H.n('files'), H.n('responses'), H.n('sightings')], [0, 0, 0]);
    assert.equal(w.of('ack').length, 0);

    // In order: every committed chunk is acked with its seq.
    H.apply(H.chunk(O, [H.cand('m1', O)], { seq: 0, last: false }));
    assert.deepEqual(w.of('ack').pop(), { type: 'ack', gen: t._gen(), rel_path: O.rel_path, seq: 0 });
    // Out of order: dropped, the file marked for the next walk, the rest of the pass dropped too.
    assert.deepEqual(t.applyChunk(H.chunk(O, [H.cand('m3', O)], { seq: 2, last: false })), { dropped: 'protocol' });
    assert.equal(H.file(O.rel_path).scan_error, 'protocol');
    assert.deepEqual(w.of('ack').pop(), { type: 'ack', gen: t._gen(), rel_path: O.rel_path, seq: 2, dropped: true });
    assert.deepEqual(t.applyChunk(H.chunk(O, [H.cand('m2', O)], { seq: 1, last: true })), { dropped: 'protocol' });
    assert.deepEqual(H.all('SELECT message_id FROM responses').map((r) => r.message_id), ['m1']);
    const f = H.file(O.rel_path);
    assert.deepEqual([f.indexed_bytes, f.head_hash, f.size, f.scan_error], [0, null, 0, 'protocol'], 'no offset was committed');
    assert.equal(t.status().filesWithErrors, 1);
    // A chunk that does not start at 0 for a file with no pass is dropped as well.
    const C = H.mainRow(SID_C);
    assert.deepEqual(t.applyChunk(H.chunk(C, [H.cand('z', C)], { seq: 1 })), { dropped: 'protocol' });
    assert.equal(H.file(C.rel_path), undefined);
    for (const seq of [-1, 1.5, '0', null]) {
      assert.deepEqual(t.applyChunk(H.chunk(C, [H.cand('z', C)], { seq })), { dropped: 'protocol' });
    }
    assert.deepEqual(t.applyChunk(H.chunk(C, [H.cand('z', C)], { fileRow: { rel_path: C.rel_path, kind: 'nope' } })), { dropped: 'protocol' });
    assert.equal(H.n('files'), 1);

    // The walk that follows sends the failed row with a size that can never
    // match, so the "same size and mtime" shortcut cannot skip it.
    ctx.clock.advance(10000);
    assert.deepEqual(w.of('walk').pop().known.map((k) => [k.rel_path, k.size, k.indexed_bytes]), [[O.rel_path, -1, 0]]);
    // A clean full pass clears the error.
    H.apply(H.chunk(O, [H.cand('m1', O), H.cand('m2', O), H.cand('m3', O)], { fullRescan: true }));
    assert.equal(H.file(O.rel_path).scan_error, null);
    assert.equal(t.status().filesWithErrors, 0);
    assert.equal(H.n('responses'), 3);

    // A pass discarded because the file changed under it: nothing written, retried.
    assert.deepEqual(t.applyChunk({ type: 'chunk', gen: t._gen(), rel_path: O.rel_path, seq: 0, last: true, discarded: true }),
      { ok: true, discarded: true });
    const d = H.file(O.rel_path);
    assert.deepEqual([d.scan_error, d.indexed_bytes, H.n('responses')], ['changed during scan', 5000, 3]);
    assert.deepEqual(t.applyChunk({ type: 'chunk', gen: t._gen(), rel_path: 'proj/unknown.jsonl', seq: 0, last: true, discarded: true }),
      { ok: true, discarded: true });
    assert.equal(H.n('files'), 1, 'a discarded pass of an unknown file writes no row');
  },

  killBetweenChunks(H) {
    const { t } = H;
    H.start();
    const O = H.mainRow(SID_O);
    const part = (from, to) => { const out = []; for (let i = from; i < to; i++) out.push(H.cand('m' + i, O, { output: 100 + i })); return out; };

    // (a) First pass of a new file: seq 0 and seq 1 of three land, then the app dies.
    H.apply(H.chunk(O, part(0, 3), { seq: 0, last: false }));
    H.apply(H.chunk(O, part(3, 6), { seq: 1, last: false }));
    let f = H.file(O.rel_path);
    assert.deepEqual([f.indexed_bytes, f.head_hash, f.tail_hash, f.size, f.last_scan_ms], [0, null, null, 0, null],
      'the partial pass committed no offset');
    assert.equal(H.n('responses'), 6);
    // Restart: a new process has no pass state. Simulated by close + init.
    t.close();
    assert.deepEqual(t.init(H.ctx()), { ok: true, state: 'ok' });
    assert.deepEqual(t.applyChunk(H.chunk(O, part(6, 9), { seq: 2, last: true })), { dropped: 'protocol' },
      'the tail of a pass from before the restart is not accepted');
    t.applyChunk(H.chunk(O, [], { fullRescan: true }));   // clears the protocol mark for the comparison below
    // Rescan from the stored row (which cannot resume, so the worker reports a full rescan).
    H.apply(H.chunk(O, part(0, 3), { seq: 0, last: false, fullRescan: true }));
    H.apply(H.chunk(O, part(3, 6), { seq: 1, last: false, fullRescan: true }));
    H.apply(H.chunk(O, part(6, 9), { seq: 2, last: true, fullRescan: true, lines_skipped: 2 }));
    f = H.file(O.rel_path);
    assert.deepEqual([f.indexed_bytes, f.head_hash, f.size, f.lines_skipped, f.scan_error], [5000, O.head_hash, 5000, 2, null]);
    const afterCrash = H.dump();

    // (b) A resumed pass that dies before its last chunk leaves the old offset.
    const grown = Object.assign({}, O, { size: 9000, indexed_bytes: 9000, tail_hash: 'tail-2', mtime_ms: O.mtime_ms + 5 });
    H.apply(H.chunk(grown, part(9, 11), { seq: 0, last: false }));
    H.apply(H.chunk(grown, part(11, 13), { seq: 1, last: false }));
    f = H.file(O.rel_path);
    assert.deepEqual([f.indexed_bytes, f.size, f.tail_hash, f.mtime_ms], [5000, 5000, O.tail_hash, O.mtime_ms],
      'indexed_bytes was never advanced by the partial pass');
    // The next scan resumes from the same stored offset and re-applies the same rows.
    H.apply(H.chunk(grown, part(9, 11), { seq: 0, last: false }));
    H.apply(H.chunk(grown, part(11, 13), { seq: 1, last: false }));
    H.apply(H.chunk(grown, part(13, 15), { seq: 2, last: true, lines_skipped: 3 }));
    f = H.file(O.rel_path);
    assert.deepEqual([f.indexed_bytes, f.size, f.tail_hash, f.lines_skipped], [9000, 9000, 'tail-2', 5],
      'a resumed pass adds its skipped lines');
    const incremental = H.dump();

    // Both equal a single full scan into an empty store.
    assert.deepEqual(t.rescan(), { ok: true });
    H.apply(H.chunk(O, part(0, 9)));
    assert.deepEqual(H.dump(), afterCrash);
    assert.deepEqual(t.rescan(), { ok: true });
    H.apply(H.chunk(grown, part(0, 15)));
    assert.deepEqual(H.dump(), incremental);
    // A full rescan replaces the skipped-line count.
    H.apply(H.chunk(grown, part(0, 15), { fullRescan: true, lines_skipped: 1 }));
    assert.equal(H.file(O.rel_path).lines_skipped, 1);
    assert.deepEqual(H.dump(), incremental);
  },

  zoneSeed(H) {
    const { t } = H;
    H.start();
    assert.equal(H.meta('tz'), process.env.TZ);
    const O = H.mainRow(SID_O);
    const at = (s) => Date.parse(s);
    H.apply(H.chunk(O, [H.cand('r1', O, { ts_ms: at('2026-10-04T03:30:00Z') }), H.cand('r2', O, { ts_ms: at('2026-10-04T13:30:00Z') })],
      { seq: 0, last: false }));
    // Enough rows for more than one 5,000-row recompute batch.
    let seq = 1;
    for (let i = 0; i < 5200; i += 400) {
      const rows = [];
      for (let j = i; j < Math.min(i + 400, 5200); j++) rows.push(H.cand('f' + j, O, { ts_ms: at('2026-10-04T13:30:00Z') }));
      H.apply(H.chunk(O, rows, { seq: seq++, last: i + 400 >= 5200 }));
    }
    const days = {};
    for (const r of H.all('SELECT local_day, COUNT(*) AS n FROM responses GROUP BY local_day')) days[r.local_day] = r.n;
    const out = { tz: H.meta('tz'), r1: H.resp('r1').local_day, r2: H.resp('r2').local_day, days };
    t.close();
    return out;
  },

  zoneRecompute(H) {
    const { t } = H;
    const ctx = H.ctx();
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const count05 = () => H.get("SELECT COUNT(*) AS n FROM responses WHERE local_day = '2026-10-05'").n;
    const out = { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, steps: [] };
    // Not inline: init leaves the rows and meta.tz alone.
    out.steps.push({ tz: H.meta('tz'), n05: count05() });
    ctx.clock.advance(9999);
    out.steps.push({ tz: H.meta('tz'), n05: count05() });
    // The deferred start runs the first batch of 5,000; each further batch is its own timer turn.
    ctx.clock.advance(1);
    ctx.clock.advance(0);
    out.steps.push({ tz: H.meta('tz'), n05: count05() });
    out.final = { r1: H.resp('r1').local_day, r2: H.resp('r2').local_day, total: H.n('responses'),
      distinctDays: H.all('SELECT DISTINCT local_day FROM responses ORDER BY 1').map((r) => r.local_day) };
    // A row written during or after the recompute is stamped with the new zone.
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('late', O, { ts_ms: Date.parse('2026-10-04T13:30:00Z') })]));
    out.late = H.resp('late').local_day;
    return out;
  },

  zoneBatches(H) {
    // Same store, read step by step: one batch per timer turn, meta.tz only at the end.
    const { t } = H;
    const ctx = H.ctx();
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const count05 = () => H.get("SELECT COUNT(*) AS n FROM responses WHERE local_day = '2026-10-05'").n;
    const out = [];
    out.push({ tz: H.meta('tz'), n05: count05() });
    assert.equal(ctx.clock.step(), true);      // the deferred start: batch 1
    out.push({ tz: H.meta('tz'), n05: count05() });
    assert.equal(ctx.clock.step(), true);      // batch 2 (the last, short one)
    out.push({ tz: H.meta('tz'), n05: count05() });
    return out;
  },

  zoneLA(H) {
    H.start();
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('r1', O, { ts_ms: Date.parse('2026-10-04T03:30:00Z') })]));
    return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, r1: H.resp('r1').local_day };
  },

  async killSwitch(H) {
    const { t } = H;
    fs.mkdirSync(H.dirs.dataDir, { recursive: true });
    fs.writeFileSync(H.offFile, '');
    const workers = stubWorkers();
    const ctx = H.ctx({ createWorker: workers.createWorker, workerPath: 'stub-worker.js' });
    const r = t.init(ctx);
    assert.equal(r.state, 'disabled');
    assert.equal(r.error, 'Token store unavailable: disabled by token-usage.off');
    assert.deepEqual(H.listData(), ['token-usage.off'], 'nothing is opened or created');
    assert.equal(workers.made.length, 0, 'no worker is started');
    assert.equal(ctx.clock.count(), 0, 'no timer is armed');
    assert.deepEqual([t.status().state, t.status().reason], ['disabled', 'disabled by token-usage.off']);
    assert.equal(t.status().reasonCode, 'kill-switch');
    await assertUnavailable(t, 'flag file present');
    assert.equal(t.status().state, 'disabled', 'rescan() does not open a store the kill switch turned off');

    // enable(): removes the flag and runs init again, no relaunch.
    assert.deepEqual(t.enable(), { ok: true, state: 'ok' });
    assert.equal(fs.existsSync(H.offFile), false);
    assert.equal(t.status().state, 'ok');
    assert.equal(workers.made.length, 1);
    H.hello(workers.last);
    const O = H.mainRow(SID_O);
    H.touch(O.rel_path);
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    assert.deepEqual(t.noteChanged(O.rel_path), { ok: true, queued: true });
    assert.deepEqual(t.enable(), { ok: true, state: 'ok' }, 'enable on a running store is a no-op');
    assert.equal(workers.made.length, 1);

    // disable(): stops everything now and writes the flag.
    const g = t._gen();
    assert.deepEqual(t.disable(), { ok: true, state: 'disabled' });
    assert.equal(fs.existsSync(H.offFile), true);
    assert.equal(workers.last.terminated, true);
    assert.equal(ctx.clock.count(), 0, 'every timer is cleared');
    await assertUnavailable(t, 'after disable');
    assert.equal(t.status().reason, 'disabled by token-usage.off');
    assert.equal(t.status().reasonCode, 'kill-switch');
    assert.equal((await t.summary({})).error, 'Token store unavailable: disabled by token-usage.off');
    assert.equal((await t.summary({})).scan.state, 'disabled');
    assert.equal((await t.summary({})).scan.reasonCode, 'kill-switch');
    assert.equal(ctx.clock.count(), 0, 'a refused query leaves no timer behind');
    ctx.clock.advance(3600000);
    assert.equal(workers.made.length, 1, 'nothing respawns while disabled');
    // A stray chunk from the terminated worker is ignored.
    workers.last.emit('message', H.chunk(O, [H.cand('m2', O)], { gen: g }));
    workers.last.emit('exit', 1);
    assert.equal(workers.made.length, 1);
    // init while the flag exists stays off.
    assert.equal(t.init(ctx).state, 'disabled');
    assert.deepEqual(t.disable(), { ok: true, state: 'disabled' }, 'disable twice is harmless');

    assert.deepEqual(t.enable(), { ok: true, state: 'ok' });
    assert.equal(fs.existsSync(H.offFile), false);
    assert.ok(t._gen() > g, 'a reopen bumps the generation');
    assert.equal(workers.made.length, 2);
    assert.equal(workers.last.workerData.gen, t._gen());
    assert.deepEqual(H.all('SELECT message_id FROM responses').map((x) => x.message_id), ['m1'], 'the data is still there');
  },

  async noThrow(H) {
    const { t } = H;
    const out = {};
    // Before init.
    out.before = await callEverything(t);
    await assertUnavailable(t, 'before init');
    assert.equal(t.status().reasonCode, null, 'not initialised is neither the kill switch nor a failure');
    assert.ok(isError(t.init()), 'init() with no ctx');
    assert.ok(isError(t.init({ log: console })), 'init without projectsDir');
    assert.ok(isError(t.enable()), 'enable before init');
    assert.ok(isError(t.disable()), 'disable before init has no folder to write the flag into');
    assert.equal(t.status().reason, 'not initialised');
    assert.equal(fs.existsSync(H.dirs.dataDir), false, 'nothing touched the disk before init');
    assert.deepEqual(t.shutdown(), { ok: true });
    assert.deepEqual(t.close(), { ok: true });

    // Running, with garbage (the calls that would change the store's state on
    // purpose are exercised in their own scenarios).
    const { ctx } = H.start();
    out.running = await callEverything(t, ['disable', 'rescan', 'close', 'shutdown', 'init', 'enable']);
    assert.equal(t.status().state, 'ok', 'garbage arguments do not turn the store off: ' + t.status().reason);
    for (const g of GARBAGE) assert.ok(isError(t.init(g)) || t.init(g).ok === true);
    assert.equal(t.status().state, 'ok');
    assert.equal(H.n('files'), 0);
    assert.equal(H.n('responses'), 0);
    // Throwing collaborators cost a log line, not the caller.
    const O = H.mainRow(SID_O);
    ctx.broadcast = () => { throw new Error('broadcast blew up'); };
    ctx.log.warn = () => { throw new Error('logger blew up'); };
    assert.doesNotThrow(() => H.apply(H.chunk(O, [H.cand('m1', O)])));
    assert.doesNotThrow(() => ctx.clock.advance(5000));
    assert.equal(t.status().state, 'ok');

    // After disable.
    assert.deepEqual(t.disable(), { ok: true, state: 'disabled' });
    out.disabled = await callEverything(t, ['enable', 'init']);
    await assertUnavailable(t, 'after disable');
    assert.equal(fs.existsSync(H.offFile), true);
    return out;
  },

  async dbPathIsDirectory(H) {
    const { t } = H;
    fs.mkdirSync(H.dbFile, { recursive: true });
    const ctx = H.ctx();
    let r;
    assert.doesNotThrow(() => { r = t.init(ctx); });
    assert.ok(isError(r), JSON.stringify(r));
    assert.equal(t.status().state, 'disabled');
    assert.equal(t.status().reason, r.error);
    assert.equal(t.status().reasonCode, 'failure');
    // "Try again" on a store that still cannot open: an { error }, never a throw.
    let again;
    assert.doesNotThrow(() => { again = t.enable(); });
    assert.ok(isError(again), 'enable: ' + JSON.stringify(again));
    assert.doesNotThrow(() => { again = t.rescan(); });
    assert.ok(isError(again), 'rescan: ' + JSON.stringify(again));
    assert.equal(t.status().reasonCode, 'failure');
    await assertUnavailable(t, 'db path is a directory');
    await callEverything(t, ['enable', 'init', 'disable']);
    assert.equal(fs.statSync(H.dbFile).isDirectory(), true, 'the directory is left alone');
    assert.equal(ctx.clock.count(), 0);
    return { error: r.error, files: H.listData() };
  },

  async queriesFacade(H) {
    const { t } = H;
    const sessionInfo = () => ({ title: 'x' });
    const ctx = H.ctx({ sessionInfo, ctxDir: 'C:/ctx', handoffsDir: 'C:/handoffs' });

    // Missing module: { error }, no throw, and the store itself stays up.
    queriesStub = { throws: Object.assign(new Error("Cannot find module './token-usage-queries'"), { code: 'MODULE_NOT_FOUND' }) };
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    for (const name of QUERY_NAMES) {
      let p;
      assert.doesNotThrow(() => { p = t[name]({}); });
      assert.ok(isThenable(p), name + ' returns a Promise');
      const r = await p;
      assert.match(r.error, /Cannot find module/, name);
      assert.equal(r.scan.state, 'ok', name + ': an error answer carries scan too');
      assert.equal(r.scan.queryMode, 'inline');
    }
    assert.equal(t.status().state, 'ok', 'a broken queries module does not disable the store');
    assert.equal(t.status().queryMode, 'inline', 'the query worker could not start');
    assert.equal(ctx.logs.filter((l) => l.includes('query worker is not available')).length, 1, 'logged once');

    // Broken in other ways.
    const broken = [
      {},                                                              // no createQueries
      { createQueries: () => { throw new Error('boom in createQueries'); } },
      { createQueries: () => null },
      { createQueries: () => ({}) },                                   // no methods
      { createQueries: () => ({ summary: () => { throw new Error('boom in summary'); }, models: () => 7, daily: () => null }) },
    ];
    for (const exp of broken) {
      t.close();
      queriesStub = { exports: exp };
      assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
      for (const name of QUERY_NAMES) {
        let p;
        assert.doesNotThrow(() => { p = t[name]({}); });
        const r = await p;
        assert.ok(isError(r), name + ' -> ' + JSON.stringify(r));
      }
      assert.equal(t.status().state, 'ok');
    }

    // Working module: delegated, with `scan` added and the deps of contract 6.4.
    t.close();
    let seen = null;
    queriesStub = { exports: { createQueries: (db, deps) => {
      seen = { db, deps, calls: (seen ? seen.calls : 0) + 1 };
      const answer = (name) => (q) => (q && q.bad ? { error: 'bad request: ' + name } : { name, q });
      return { summary: answer('summary'), models: answer('models'), daily: answer('daily'), sessions: answer('sessions'), context: answer('context') };
    } } };
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    for (const name of QUERY_NAMES) {
      const r = await t[name]({ from: '2026-10-01' });
      assert.equal(r.name, name);
      assert.deepEqual(r.q, { from: '2026-10-01' });
      assert.equal(r.scan.state, 'ok');
      const bad = await t[name]({ bad: true });
      assert.equal(bad.error, 'bad request: ' + name);
      assert.equal(bad.scan.state, 'ok');
    }
    assert.equal(seen.calls, 1, 'createQueries runs once per open handle');
    assert.equal(seen.db, t._handle());
    assert.equal(seen.deps.sessionInfo, sessionInfo);
    assert.equal(seen.deps.ctxDir, 'C:/ctx');
    assert.equal(seen.deps.handoffsDir, 'C:/handoffs');
    assert.equal('prices' in seen.deps, false, 'prices is left to the queries module default');
    assert.equal(seen.deps.localDay(T0), t.localDay(T0));
    assert.deepEqual(seen.deps.dayList('2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.equal(seen.deps.now(), ctx.clock.now());
    // A reopened handle gets fresh query statements.
    t.close();
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    await t.summary({});
    assert.equal(seen.calls, 2);
    assert.equal(seen.db, t._handle());
  },

  rebuild(H) {
    const { t } = H;
    const { ctx, workers } = H.start({ worker: true });
    const O = H.mainRow(SID_O);
    H.touch(O.rel_path);
    H.apply(H.chunk(O, [H.cand('m1', O), H.cand('m2', O)]));
    t.noteChanged(O.rel_path);
    const first = workers.last;
    const oldGen = t._gen();
    assert.equal(first.workerData.gen, oldGen);
    assert.equal(first.workerData.projectsDir, H.dirs.projectsDir);

    assert.deepEqual(t.rescan(), { ok: true });
    assert.ok(t._gen() > oldGen);
    assert.equal(first.terminated, true, 'the old worker is terminated');
    assert.equal(workers.made.length, 2, 'a new worker is spawned');
    assert.equal(workers.last.workerData.gen, t._gen());
    assert.deepEqual([H.n('files'), H.n('responses'), H.n('sightings')], [0, 0, 0]);
    assert.equal(H.meta('backfill_done'), '');
    assert.deepEqual(t.rescan(), { error: 'rescan already running' });
    assert.equal(workers.made.length, 2);
    // The pending set and its timers went with the old generation.
    ctx.clock.advance(15000);
    assert.equal(workers.last.of('scan').length, 0);
    assert.equal(first.of('scan').length, 0);

    // What the terminated worker had already posted is dropped.
    first.emit('message', H.chunk(O, [H.cand('late', O)], { gen: oldGen }));
    first.emit('message', H.chunk(O, [H.cand('late', O)]));      // even with the current gen: wrong worker
    first.emit('message', { type: 'done', gen: oldGen, mode: 'backfill', seen: [], missing: [] });
    assert.deepEqual(t.applyChunk(H.chunk(O, [H.cand('late', O)], { gen: oldGen })), { dropped: 'stale gen' });
    assert.equal(H.n('files'), 0, 'no files row with an offset from the old generation');
    assert.equal(H.meta('backfill_done'), '');
    assert.deepEqual(t.rescan(), { error: 'rescan already running' });

    // The new worker says hello: a backfill walk over an empty `known`.
    assert.equal(workers.last.of('walk').length, 0);
    H.hello(workers.last);
    const walks = workers.last.of('walk');
    assert.equal(walks.length, 1);
    assert.deepEqual(walks[0], { type: 'walk', gen: t._gen(), mode: 'backfill', known: [] });
    assert.equal(t.status().phase, 'backfill');
    workers.last.emit('message', { type: 'progress', gen: t._gen(), done: 3, total: 9 });
    assert.deepEqual([t.status().done, t.status().total], [3, 9]);
    workers.last.emit('message', Object.assign(H.chunk(O, [H.cand('m1', O), H.cand('m2', O)])));
    assert.equal(H.n('responses'), 2);
    assert.equal(H.master().filter((r) => r.type === 'index' && r.name.startsWith('idx_')).length, 0);
    workers.last.emit('message', { type: 'done', gen: t._gen(), mode: 'backfill', seen: [O.rel_path], missing: [] });
    assert.ok(Date.parse(H.meta('backfill_done')) > 0);
    assert.equal(t.status().backfillDone, H.meta('backfill_done'));
    assert.equal(t.status().phase, 'idle');
    assert.equal(H.meta('indexes_built'), '1');
    assert.equal(H.master().filter((r) => r.type === 'index' && r.name.startsWith('idx_')).length, 7,
      'the secondary indexes are created after the first backfill');
    ctx.clock.advance(1000);      // broadcasts are held to one per second; let the trailing one out
    assert.ok(ctx.sent.length > 0 && ctx.sent.every((s) => s.channel === 'token-stats-changed'));
    assert.equal(ctx.sent[ctx.sent.length - 1].payload.phase, 'idle');
    // The next walk is a catch-up and carries the stored rows.
    ctx.clock.advance(600000);
    const next = workers.last.of('walk').pop();
    assert.equal(next.mode, 'catchup');
    assert.deepEqual(next.known, [{ rel_path: O.rel_path, size: 5000, mtime_ms: O.mtime_ms, head_hash: O.head_hash,
      indexed_bytes: 5000, tail_hash: O.tail_hash }]);
    workers.last.emit('message', { type: 'done', gen: t._gen(), mode: 'catchup', seen: [O.rel_path], missing: [] });
    // And Rebuild is allowed again.
    assert.deepEqual(t.rescan(), { ok: true });
    assert.equal(workers.made.length, 3);
  },

  parseVersion(H) {
    const { t } = H;
    const { ctx, workers } = H.start({ worker: true });      // hello with parseVersion 1
    assert.equal(H.meta('parse_version'), '1');
    assert.equal(t.status().parseVersion, 1);
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    workers.last.emit('message', { type: 'done', gen: t._gen(), mode: 'backfill', seen: [], missing: [] });
    assert.ok(H.meta('backfill_done'));
    t.close();

    // Next launch, same parser: nothing is rebuilt.
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    H.hello(workers.last, 1);
    assert.equal(H.n('responses'), 1);
    assert.ok(H.meta('backfill_done'));
    t.close();

    // Next launch, the parser's rules changed: rebuild, never refuse.
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const count = workers.made.length;
    const g = t._gen();
    assert.doesNotThrow(() => H.hello(workers.last, 2));
    assert.equal(t.status().state, 'ok');
    assert.equal(H.n('responses'), 0, 'rows counted under the old rules are gone');
    assert.equal(H.meta('backfill_done'), '');
    assert.ok(t._gen() > g);
    assert.equal(workers.made.length, count + 1, 'the rebuild starts a new worker');
    assert.equal(workers.made[count - 1].terminated, true);
    H.hello(workers.last, 2);
    assert.equal(H.meta('parse_version'), '2');
    assert.equal(t.status().parseVersion, 2);
    assert.equal(workers.made.length, count + 1, 'and its hello does not rebuild again');
    assert.equal(workers.last.of('walk').pop().mode, 'backfill');
  },

  async corruptAtRunTime(H) {
    // A statement that fails with a corruption code at any time takes the same
    // path as a corrupt file at open. The failure is injected from inside the
    // chunk transaction, carrying the code better-sqlite3 would report.
    const { t } = H;
    const { ctx, workers } = H.start({ worker: true });
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    const poisoned = (code) => {
      const c = H.cand('m2', O);
      Object.defineProperty(c, 'ts_ms', { get() { throw Object.assign(new Error('database disk image is malformed'), { code }); } });
      return c;
    };
    const g = t._gen();
    let r;
    assert.doesNotThrow(() => { r = t.applyChunk(H.chunk(O, [H.cand('m3', O), poisoned('SQLITE_CORRUPT')])); });
    assert.equal(r.error, 'database disk image is malformed');
    assert.equal(t.status().state, 'ok', 'recovered: ' + t.status().reason);
    assert.ok(t._gen() > g, 'the generation is bumped');
    assert.equal(H.listData().filter((f) => /^token-usage\.db\.corrupt-\d+$/.test(f)).length, 1);
    assert.equal(H.n('responses'), 0, 'a fresh store');
    assert.equal(H.meta('backfill_done'), '');
    assert.equal(workers.made.length, 2);
    assert.equal(workers.made[0].terminated, true);
    assert.equal(workers.last.workerData.gen, t._gen());
    H.hello(workers.last);
    assert.equal(workers.last.of('walk').pop().mode, 'backfill');
    assert.deepEqual(t.applyChunk(H.chunk(O, [H.cand('old', O)], { gen: g })), { dropped: 'stale gen' });

    // A second corruption in the same run turns the store off; still no throw.
    assert.doesNotThrow(() => { r = t.applyChunk(H.chunk(O, [poisoned('SQLITE_IOERR_SHORT_READ')])); });
    assert.equal(r.error, 'database disk image is malformed');
    assert.deepEqual([t.status().state, t.status().reason], ['disabled', 'database disk image is malformed']);
    assert.equal(t.status().reasonCode, 'failure');
    await assertUnavailable(t, 'after a second corruption', ['rescan']);
    assert.equal(workers.last.terminated, true);
    assert.equal(ctx.clock.count(), 0);

    // "Try again" through Rebuild: rescan() on a store that is off because of
    // a failure re-runs init and then rebuilds.
    const made = workers.made.length;
    const g2 = t._gen();
    let again;
    assert.doesNotThrow(() => { again = t.rescan(); });
    assert.deepEqual(again, { ok: true });
    assert.deepEqual([t.status().state, t.status().reasonCode], ['ok', null]);
    assert.ok(t._gen() > g2);
    assert.ok(workers.made.length > made, 'a scanner worker is started again');
    assert.equal(workers.last.workerData.gen, t._gen());
    assert.equal(H.n('responses'), 0);
    assert.equal(H.meta('backfill_done'), '');
    H.hello(workers.last);
    assert.equal(workers.last.of('walk').pop().mode, 'backfill');
    assert.deepEqual(t.rescan(), { error: 'rescan already running' });
    assert.equal(fs.existsSync(H.offFile), false);
  },

  writeFailure(H) {
    // Any other failure on the write path turns the store off instead of
    // repeating on every event. The transaction is rolled back.
    const { t } = H;
    const { ctx, workers } = H.start({ worker: true });
    const O = H.mainRow(SID_O);
    H.apply(H.chunk(O, [H.cand('m1', O)]));
    const c = H.cand('m3', O);
    Object.defineProperty(c, 'model', { get() { throw new Error('disk is full'); } });
    let r;
    assert.doesNotThrow(() => { workers.last.emit('message', H.chunk(O, [H.cand('m2', O), c])); });
    assert.deepEqual([t.status().state, t.status().reason], ['disabled', 'disk is full']);
    assert.equal(t.status().reasonCode, 'failure');
    assert.doesNotThrow(() => { r = t.noteChanged(O.rel_path); });
    assert.equal(r.error, 'Token store unavailable: disk is full');
    assert.equal(workers.last.terminated, true);
    assert.equal(ctx.clock.count(), 0);
    assert.equal(fs.existsSync(H.offFile), false, 'a failure does not write the kill switch: the next launch tries again');
    // The half-applied chunk left nothing behind.
    const db = new (require('better-sqlite3'))(H.dbFile, { readonly: true });
    try {
      assert.deepEqual(db.prepare('SELECT message_id FROM responses').all().map((x) => x.message_id), ['m1']);
    } finally {
      db.close();
    }
    // enable() is the way back without a relaunch ("Try again": no flag file,
    // so there is nothing to remove; it re-runs init).
    assert.deepEqual(t.enable(), { ok: true, state: 'ok' });
    assert.equal(H.n('responses'), 1);
    assert.deepEqual([t.status().state, t.status().reasonCode, t.status().files], ['ok', null, 1]);
    assert.equal(fs.existsSync(H.offFile), false);
  },

  snapshot(H) {
    // Run twice on the same folder by the parent: the second init changes nothing.
    const { t } = H;
    const second = process.env.TOKEN_USAGE_ARG === 'second';
    const { workers } = H.start({ worker: true });
    if (!second) {
      const O = H.mainRow(SID_O);
      H.apply(H.chunk(O, [H.cand('m1', O), H.cand('m2', O)]));
      workers.last.emit('message', { type: 'done', gen: t._gen(), mode: 'backfill', seen: [], missing: [] });
    }
    const out = {
      master: H.master(),
      meta: H.all('SELECT key, value FROM meta ORDER BY key'),
      files: H.all('SELECT * FROM files ORDER BY id'),
      dump: H.dump(),
      indexes: H.master().filter((r) => r.type === 'index' && r.name.startsWith('idx_')).length,
    };
    t.close();
    return out;
  },
};

// --------------------------------------------------------------- child main ----

function childMain() {
  const name = process.env.TOKEN_USAGE_SCENARIO;
  const fn = SCENARIOS[name];
  assert.equal(typeof fn, 'function', 'unknown scenario ' + name);
  const H = makeHarness();
  // Scenarios that ask a query are async; the rest return at once.
  Promise.resolve()
    .then(() => fn(H))
    .then((out) => {
      const responses = invariantsAfter(H);
      fs.writeSync(1, '\nRESULT ' + JSON.stringify({ out: out === undefined ? null : out, responses }) + '\n');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write((err && err.stack) || String(err));
      process.exit(1);
    });
}

// -------------------------------------------------------------- parent half ----

function parentMain() {
  const test = require('node:test');
  const { spawnSync } = require('child_process');
  // Under plain node, require('electron') is the path to the binary.
  const electronBin = require('electron');

  function freshRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-db-')); }

  function run(name, opts) {
    const o = opts || {};
    const root = o.root || freshRoot();
    const dataDir = path.join(root, 'data');
    assert.ok(path.resolve(dataDir).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep));
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir, TOKEN_USAGE_SCENARIO: name };
    delete env.TOKEN_USAGE_ARG;
    if (o.tz) env.TZ = o.tz;
    if (o.arg) env.TOKEN_USAGE_ARG = o.arg;
    try {
      const r = spawnSync(electronBin, [__filename], { cwd: APP_DIR, env, encoding: 'utf8' });
      assert.equal(r.status, 0, 'scenario ' + name + ' failed\n' + r.stderr + '\n' + r.stdout);
      const line = r.stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
      assert.ok(line, 'scenario ' + name + ' printed no result\n' + r.stdout + r.stderr);
      return JSON.parse(line.slice(7));
    } finally {
      if (!o.keep) fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const simple = {
    fresh: 'fresh dir: init creates the store, schema_version set, scan.state ok; a second init is a no-op',
    garbageFile: 'garbage in token-usage.db: init does not throw, the file is kept as .corrupt-*, a fresh store works',
    schemaBump: 'schema_version changed or missing: the store is rebuilt, backfill_done empty',
    upsertRules: 'the upsert: counter rule with the ts tie-break, independent ownership takeover, sightings, compactions',
    ownershipIsCommutative: 'ownership and counters are the same in either scan order',
    cascade: 'cascade: scan O, scan C, full-rescan O, flush; totals equal a fresh rebuild; O marked missing keeps its rows',
    cascadeGuard: 'cascade guard: mutual owners are rescanned at most once per cycle',
    generation: 'stale gen writes nothing; out-of-order seq is dropped with scan_error protocol; discarded pass writes nothing',
    killBetweenChunks: 'kill between chunks: the offset never advances without the last chunk; rows equal a single full scan',
    killSwitch: 'kill switch: token-usage.off opens nothing; disable() and enable() work without a relaunch',
    noThrow: 'no export throws: garbage arguments, before init, after disable',
    dbPathIsDirectory: 'no export throws when the database path is a directory',
    queriesFacade: 'a missing or broken queries module yields { error }; a working one is delegated to with scan added',
    rebuild: 'Rebuild: gen bump, worker replaced, store emptied, backfill walk, second request refused while running',
    parseVersion: 'parse_version comes from hello; a changed parser rebuilds the store',
    corruptAtRunTime: 'corruption at run time: renamed, generation bumped, rebuilt once, then disabled',
    writeFailure: 'a write-path failure disables the store without throwing and without the kill-switch file',
  };
  for (const name of Object.keys(simple)) {
    test(simple[name], () => { run(name); });
  }

  test('zone: rows are stamped with the local day, and a changed zone recomputes every row in batches', () => {
    const root = freshRoot();
    try {
      const seeded = run('zoneSeed', { root, tz: 'Pacific/Auckland', keep: true }).out;
      assert.equal(seeded.tz, 'Pacific/Auckland');
      assert.equal(seeded.r1, '2026-10-04');
      assert.equal(seeded.r2, '2026-10-05');
      assert.deepEqual(seeded.days, { '2026-10-04': 1, '2026-10-05': 5201 });

      // A copy of the seeded store for the step-by-step reading.
      const rootB = freshRoot();
      fs.cpSync(path.join(root, 'data'), path.join(rootB, 'data'), { recursive: true });

      const re = run('zoneRecompute', { root, tz: 'UTC', keep: true }).out;
      assert.equal(re.zone, 'UTC');
      assert.deepEqual(re.steps[0], { tz: 'Pacific/Auckland', n05: 5201 }, 'init does not recompute inline');
      assert.deepEqual(re.steps[1], { tz: 'Pacific/Auckland', n05: 5201 }, 'nor before the deferred start');
      assert.deepEqual(re.steps[2], { tz: 'UTC', n05: 0 });
      assert.deepEqual(re.final, { r1: '2026-10-04', r2: '2026-10-04', total: 5202, distinctDays: ['2026-10-04'] });
      assert.equal(re.late, '2026-10-04');

      const steps = run('zoneBatches', { root: rootB, tz: 'UTC' }).out;
      assert.deepEqual(steps, [
        { tz: 'Pacific/Auckland', n05: 5201 },
        { tz: 'Pacific/Auckland', n05: 202 },     // 5,000 rows per batch; meta.tz not yet moved
        { tz: 'UTC', n05: 0 },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('zone: 2026-10-04T03:30Z lands on 2026-10-03 under America/Los_Angeles', () => {
    assert.deepEqual(run('zoneLA', { tz: 'America/Los_Angeles' }).out, { zone: 'America/Los_Angeles', r1: '2026-10-03' });
  });

  test('a second init on the same folder changes nothing', () => {
    const root = freshRoot();
    try {
      const first = run('snapshot', { root, keep: true });
      const second = run('snapshot', { root, keep: true, arg: 'second' });
      assert.equal(first.out.indexes, 7);
      assert.deepEqual(second.out, first.out);
      assert.equal(second.responses, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

if (process.env.TOKEN_USAGE_SCENARIO) childMain();
else parentMain();
