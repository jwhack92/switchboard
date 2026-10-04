'use strict';
// The query worker (workers/query-tokens.js) and the facade around it in
// token-usage.js: the five queries leave the main thread, and the store still
// deletes, renames and closes its file with the worker's connection confirmed
// closed first.
//
// better-sqlite3 is built for Electron's ABI, so every scenario runs in a
// child: this same file under the Electron binary as Node, with
// TOKEN_USAGE_SCENARIO naming the scenario. The parent half (plain `node
// --test`) only spawns children and reads their result.
//
// Contract rule 5: the real ~/.switchboard is never opened. Each child gets an
// explicit temp dataDir AND SWITCHBOARD_DATA_DIR pointing at the same folder,
// and refuses to run unless that folder is under os.tmpdir().
//
// Rows are seeded through applyChunk with hand-built chunks. No scanner worker
// runs here (ctx has no workerPath), so the default query worker path is the
// real file beside token-usage.js. Scenarios named "real" start that thread;
// the others inject a stub through ctx.createQueryWorker and a fake clock.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const MOD = path.join(APP_DIR, 'token-usage.js');
const QUERIES = path.join(APP_DIR, 'token-usage-queries.js');
const QW_PATH = path.join(APP_DIR, 'workers', 'query-tokens.js');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S9 = '99999999-9999-4999-8999-999999999999';
const D_OLD = Date.parse('2025-12-25T15:00:00Z');
const D1 = Date.parse('2026-03-01T15:00:00Z');
const D2 = Date.parse('2026-03-05T15:00:00Z');
// The store's clock in the real-worker scenarios. Months before the real date
// on purpose: the default range (the last 30 local days) holds the March rows
// only if the worker uses the time the store sends with each query.
const NOW = Date.parse('2026-03-10T12:00:00Z');
const ALL = { from: '2025-12-01', to: '2026-03-31' };
const QUERY_NAMES = ['summary', 'models', 'daily', 'sessions', 'context'];
const GARBAGE = [undefined, null, 0, 42, NaN, '', 'x', '../../etc/passwd', true, [], [1, 2], {}, { from: () => {} },
  { from: Symbol('s'), to: 10n, limit: {}, slug: [], sessionId: () => {} }, { slug: 'x'.repeat(100000) },
  () => {}, Symbol('s'), 10n, new Date(0), new Map([[1, 2]])];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ child helpers ----

function tempDirs() {
  const raw = process.env.SWITCHBOARD_DATA_DIR;
  assert.ok(raw, 'SWITCHBOARD_DATA_DIR must be set for a database test');
  const dataDir = path.resolve(raw);
  const tmp = path.resolve(os.tmpdir());
  assert.ok(dataDir.toLowerCase().startsWith(tmp.toLowerCase() + path.sep),
    'refusing to open a database outside os.tmpdir(): ' + dataDir);
  const root = path.dirname(dataDir);
  return { dataDir, root, projectsDir: path.join(root, 'projects'), ctxDir: path.join(root, 'ctx'), handoffsDir: path.join(root, 'handoffs') };
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

// A query worker that is driven by the test. It honours the one thing the
// store waits for synchronously: 'close' raises the closed flag at once.
function stubQueryWorkers() {
  const { EventEmitter } = require('events');
  const made = [];
  return {
    made,
    get last() { return made[made.length - 1]; },
    create(workerPath, workerData) {
      const w = new EventEmitter();
      w.workerPath = workerPath;
      w.workerData = workerData;
      w.signal = new Int32Array(workerData.signal);
      w.posted = [];
      w.terminated = false;
      w.postMessage = (m) => {
        w.posted.push(m);
        if (m && m.type === 'close') Atomics.store(w.signal, 1, 1);
      };
      w.terminate = () => { w.terminated = true; return Promise.resolve(0); };
      w.queries = () => w.posted.filter((m) => m.type === 'query');
      w.hello = (o) => w.emit('message', Object.assign({ type: 'hello', ok: true }, o));
      w.answer = (id, result) => w.emit('message', { type: 'result', id, result, ms: 1 });
      made.push(w);
      return w;
    },
  };
}

// The real thread, started the way the store starts it; the wrapper only
// keeps hold of it and of the memory it shares with the store.
function realQueryWorkers() {
  const made = [];
  return {
    made,
    get last() { return made[made.length - 1]; },
    create(workerPath, workerData) {
      const { Worker } = require('worker_threads');
      const w = new Worker(workerPath, { workerData });
      made.push({ w, workerPath, workerData, signal: new Int32Array(workerData.signal) });
      return w;
    },
  };
}

function makeHarness() {
  const dirs = tempDirs();
  fs.mkdirSync(dirs.projectsDir, { recursive: true });
  const t = require(MOD);
  const H = { t, dirs, dbFile: path.join(dirs.dataDir, 'token-usage.db'), offFile: path.join(dirs.dataDir, 'token-usage.off') };

  H.ctx = (extra) => {
    const logs = [];
    const log = {};
    for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => logs.push(level + ': ' + m);
    return Object.assign({
      log, logs,
      projectsDir: dirs.projectsDir,
      dataDir: dirs.dataDir,
      ctxDir: dirs.ctxDir,
      handoffsDir: dirs.handoffsDir,
      appVersion: '0.0.0-test',
      broadcast: () => {},
      sessionInfo: (id) => {
        if (id === S2) throw new Error('title lookup blew up');
        return id === S1 ? { title: 'First' } : null;
      },
      folderMeta: (slug) => {
        if (slug === 'proj-b') throw new Error('folder lookup blew up');
        return slug === 'proj-a' ? { projectPath: 'C:/work/alpha' } : null;
      },
      isRunning: (id) => {
        if (id === S2) throw new Error('running lookup blew up');
        return id === S3;
      },
    }, extra || {});
  };

  H.fileRow = (rel, kind, slug, sid, o) => Object.assign({
    rel_path: rel, kind, slug, session_id: sid, agent_id: null, wf_id: null,
    size: 5000, mtime_ms: 1791000000000, birthtime_ms: 1000, head_hash: 'v1:head-' + rel, indexed_bytes: 5000, tail_hash: 'tail-' + rel,
  }, o);
  H.cand = (id, fr, o) => Object.assign({
    message_id: id, session_id: fr.session_id, kind: fr.kind, slug: fr.slug, wf_id: fr.wf_id, agent_id: fr.agent_id,
    owner_birth_ms: fr.birthtime_ms, model: 'claude-opus-5-5', ts_ms: D1, input: 10, output: 100, cache_write: 20,
    cache_write_5m: 20, cache_write_1h: 0, cache_read: 1000, thinking: null, finalized: 1, stop_reason: 'end_turn',
  }, o);
  H.apply = (fr, candidates, compactions) => {
    const r = t.applyChunk({
      type: 'chunk', gen: t._gen(), rel_path: fr.rel_path, seq: 0, last: true, fileRow: fr,
      candidates: candidates || [], compactions: compactions || [], fullRescan: false, lines_skipped: 0,
    });
    assert.equal(r.ok, true, 'applyChunk: ' + JSON.stringify(r));
    return r;
  };

  // Three sessions in three projects, three kinds, four models (one a dated
  // alias, one without a price), three days (one outside the default range), an
  // unfinalised response and two compactions. Returns what was seeded.
  H.seed = () => {
    const rows = [];
    const add = (fr, id, o) => { const c = H.cand(id, fr, o); rows.push(c); return c; };
    const f1 = H.fileRow('proj-a/' + S1 + '.jsonl', 'main', 'proj-a', S1);
    H.apply(f1, [
      add(f1, 'a1', { ts_ms: D_OLD, input: 7, output: 70 }),
      add(f1, 'a2', { ts_ms: D1, input: 11, output: 110, cache_write: 30, cache_write_5m: 10, cache_write_1h: 20 }),
      add(f1, 'a3', { ts_ms: D1 + 60000, model: 'claude-haiku-4-5-20251001', output: 5, cache_read: 40000 }),
      add(f1, 'a4', { ts_ms: D2, output: 9, finalized: 0, stop_reason: null, cache_read: 250000 }),
    ], [
      { uuid: 'c1', session_id: S1, slug: 'proj-a', ts_ms: D1 + 30000, trigger: 'auto', pre_tokens: 180000, post_tokens: 20000 },
      { uuid: 'c2', session_id: S1, slug: 'proj-a', ts_ms: D2 + 1000, trigger: 'manual', pre_tokens: 260000, post_tokens: 30000 },
    ]);
    const f1s = H.fileRow('proj-a/' + S1 + '/subagents/agent-x.jsonl', 'subagent', 'proj-a', S1, { agent_id: 'agent-x', birthtime_ms: 3000 });
    H.apply(f1s, [add(f1s, 's1', { ts_ms: D1 + 1000, model: 'claude-sonnet-5-5', output: 300 }), add(f1s, 's2', { ts_ms: D2, model: 'claude-sonnet-5-5' })]);
    const f1w = H.fileRow('proj-a/' + S1 + '/workflows/wf1/agent-y.jsonl', 'workflow', 'proj-a', S1, { agent_id: 'agent-y', wf_id: 'wf1', birthtime_ms: 4000 });
    H.apply(f1w, [add(f1w, 'w1', { ts_ms: D1 + 2000, output: 700 }), add(f1w, 'w2', { ts_ms: D2 + 2000, output: 800 })]);
    const f2 = H.fileRow('proj-b/' + S2 + '.jsonl', 'main', 'proj-b', S2, { birthtime_ms: 2000 });
    H.apply(f2, [
      add(f2, 'b1', { ts_ms: D1, model: 'mystery-model-9', output: 1234 }),
      add(f2, 'b2', { ts_ms: D2, model: 'mystery-model-9', output: 2 }),
      add(f2, 'b3', { ts_ms: D2 + 5000, output: 50 }),
    ]);
    const f3 = H.fileRow('proj-c/' + S3 + '.jsonl', 'main', 'proj-c', S3, { birthtime_ms: 2500 });
    H.apply(f3, [add(f3, 'd1', { ts_ms: D2, output: 4000, cache_read: 5 })]);

    // What only the worker can read for a context query, in the folders the
    // store was given (they reach the worker through workerData).
    fs.mkdirSync(path.join(dirs.handoffsDir, 'latest'), { recursive: true });
    fs.mkdirSync(dirs.ctxDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.ctxDir, S1 + '.json'), JSON.stringify({ context_window_size: 500000 }));
    fs.writeFileSync(path.join(dirs.ctxDir, S1 + '.state.json'),
      JSON.stringify({ written_at: D2 / 1000, written_tokens: 251000, handoff_path: 'C:/h/one.md' }));
    fs.writeFileSync(path.join(dirs.handoffsDir, 'latest', 'proj-a.json'),
      JSON.stringify({ entries: [{ session_id: S1, written_at: (D2 + 600000) / 1000, tokens: 300000, path: 'C:/h/two.md', consumed_by: S9 }] }));
    const sum = (key, pred) => rows.filter(pred || (() => true)).reduce((a, r) => a + r[key], 0);
    return { rows, sum };
  };

  H.asks = () => [
    ['summaryDefault', 'summary', undefined],
    ['summaryAll', 'summary', ALL],
    ['summaryBad', 'summary', { from: 'nope' }],
    ['summaryReversed', 'summary', { from: '2026-03-05', to: '2026-03-01' }],
    ['models', 'models', ALL],
    ['modelsDefault', 'models', {}],
    ['daily', 'daily', ALL],
    ['dailyTop1', 'daily', { from: ALL.from, to: ALL.to, topN: 1 }],
    ['dailyBad', 'daily', { topN: 99 }],
    ['sessions', 'sessions', ALL],
    ['sessionsPage', 'sessions', { from: ALL.from, to: ALL.to, sort: 'output', dir: 'asc', limit: 2, offset: 1 }],
    ['sessionsSlug', 'sessions', { from: ALL.from, to: ALL.to, slug: 'proj-b' }],
    ['sessionsDefault', 'sessions', {}],
    ['sessionsBad', 'sessions', { sort: 'nope' }],
    ['context1', 'context', { sessionId: S1 }],
    ['context2', 'context', { sessionId: S2 }],
    ['contextUnknown', 'context', { sessionId: S9 }],
    ['contextBad', 'context', { sessionId: 'x' }],
    ['contextNone', 'context', undefined],
  ];
  // Every query asked at once (the Tokens tab asks four at once), then awaited.
  H.askAll = async () => {
    const promised = H.asks().map(([key, name, q]) => [key, t[name](q)]);
    const out = {};
    for (const [key, p] of promised) {
      assert.equal(typeof p.then, 'function', key + ' returns a Promise');
      out[key] = await p;
    }
    return out;
  };
  // The same queries run inline: createQueries on the store's own handle with
  // the deps the facade gives it.
  H.inlineAll = (ctx, now) => {
    const q = require(QUERIES).createQueries(t._handle(), {
      localDay: t.localDay, dayList: t.dayList, sessionInfo: ctx.sessionInfo, folderMeta: ctx.folderMeta, isRunning: ctx.isRunning,
      ctxDir: ctx.ctxDir, handoffsDir: ctx.handoffsDir, now,
    });
    const out = {};
    for (const [key, name, arg] of H.asks()) out[key] = q[name](arg);
    return out;
  };
  H.strip = (answers) => {
    const out = {};
    for (const key of Object.keys(answers)) {
      out[key] = Object.assign({}, answers[key]);
      delete out[key].scan;
    }
    return out;
  };
  H.hasTable = (name) => t._handle().prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get(name).n === 1;
  H.identity = () => String(fs.statSync(H.dbFile, { bigint: true }).ino);
  H.closedFlag = (made) => Atomics.load(made.signal, 1);
  return H;
}

async function settled(p, ms) {
  let done = false;
  p.then(() => { done = true; });
  await sleep(ms === undefined ? 0 : ms);
  return done;
}

// --------------------------------------------------------------- scenarios ----

const SCENARIOS = {
  // Real worker. All five queries through the worker equal the same queries
  // run inline, field for field; then the same store with a worker that cannot
  // start answers the same through the facade's fallback.
  async realEqualsInline(H) {
    const { t } = H;
    const workers = realQueryWorkers();
    const ctx = H.ctx({ createQueryWorker: workers.create, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    assert.ok(path.resolve(t._handle().name).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep));
    const seeded = H.seed();
    assert.equal(workers.made.length, 0, 'init starts no query worker: the first query does');
    assert.equal(t.status().queryMode, 'worker');

    const viaWorker = await H.askAll();
    assert.equal(workers.made.length, 1, 'one long-lived worker for every query');
    assert.equal(workers.made[0].workerPath, QW_PATH, 'without ctx.workerPath: workers/query-tokens.js beside token-usage.js');
    assert.deepEqual(Object.keys(workers.made[0].workerData).sort(), ['ctxDir', 'dbPath', 'handoffsDir', 'signal']);
    assert.equal(workers.made[0].workerData.dbPath, H.dbFile);
    for (const key of Object.keys(viaWorker)) {
      assert.equal(viaWorker[key].scan.state, 'ok', key);
      assert.equal(viaWorker[key].scan.queryMode, 'worker', key + ' was answered by the worker');
      assert.equal(viaWorker[key].scan.files, 5, key);
      assert.equal(viaWorker[key].scan.reasonCode, null, key);
    }

    // Field for field against the inline path.
    const inline = H.inlineAll(ctx, () => NOW);
    assert.deepStrictEqual(H.strip(viaWorker), inline);

    // And the answers are right, not merely equal.
    const all = viaWorker.summaryAll;
    assert.equal(all.error, undefined);
    assert.equal(all.totals.responses, seeded.rows.length);
    for (const k of ['input', 'output', 'cache_write', 'cache_read']) assert.equal(all.totals[k], seeded.sum(k), k);
    assert.equal(all.totals.unfinalized, 1);
    assert.equal(all.byKind.subagent.responses, 2);
    assert.equal(all.byKind.workflow.output, 1500);
    assert.deepEqual(all.weighted.unpricedModels, ['mystery-model-9']);
    const recent = viaWorker.summaryDefault;
    assert.deepEqual(recent.range, { from: t.localDay(NOW - 29 * 86400000), to: t.localDay(NOW) },
      'the default range is counted from the store\'s clock, which the worker is sent with each query');
    assert.equal(recent.totals.responses, seeded.rows.length - 1, 'the December row is outside the last 30 days');
    assert.match(viaWorker.summaryBad.error, /^bad request: from must be a calendar day/);
    assert.match(viaWorker.summaryReversed.error, /^bad request: from is after to/);
    assert.match(viaWorker.dailyBad.error, /^bad request: topN/);
    assert.match(viaWorker.sessionsBad.error, /^bad request: sort/);
    assert.match(viaWorker.contextBad.error, /^bad request: sessionId/);
    assert.match(viaWorker.contextNone.error, /^bad request: expected an object/);
    assert.equal(viaWorker.models.models.reduce((a, m) => a + m.output, 0), seeded.sum('output'));
    assert.ok(viaWorker.models.models.some((m) => m.model === 'claude-haiku-4-5'), 'the dated alias is normalised');
    assert.equal(viaWorker.daily.days.reduce((a, d) => a + d.total.output, 0), seeded.sum('output'));
    assert.equal(viaWorker.dailyTop1.projects.length, 1);
    assert.equal(viaWorker.dailyTop1.other.slugs, 2);

    // What main adds after the worker has answered: titles, project paths and
    // labels, isRunning. A lookup that throws leaves the undecorated value.
    const byId = Object.fromEntries(viaWorker.sessions.rows.map((r) => [r.sessionId, r]));
    assert.deepEqual([byId[S1].title, byId[S1].projectPath, byId[S1].isRunning], ['First', 'C:/work/alpha', false]);
    assert.deepEqual([byId[S2].title, byId[S2].projectPath, byId[S2].isRunning], [null, 'proj-b', false]);
    assert.deepEqual([byId[S3].title, byId[S3].projectPath, byId[S3].isRunning], [null, 'proj-c', true]);
    assert.equal(byId[S1].compactions, 2);
    assert.equal(byId[S1].workflow.workflows, 1);
    const projects = Object.fromEntries(viaWorker.daily.projects.map((p) => [p.slug, p]));
    assert.deepEqual([projects['proj-a'].projectPath, projects['proj-a'].label], ['C:/work/alpha', 'alpha']);
    assert.deepEqual([projects['proj-b'].projectPath, projects['proj-b'].label], ['proj-b', 'proj-b']);
    assert.equal(viaWorker.sessionsPage.rows.length, 2);
    assert.equal(viaWorker.sessionsPage.total, 3);
    assert.deepEqual(viaWorker.sessionsSlug.rows.map((r) => r.sessionId), [S2]);
    // The context query reads two folders; the worker got them from the store.
    const c1 = viaWorker.context1;
    assert.equal(c1.title, 'First');
    assert.deepEqual([c1.contextWindow, c1.contextWindowSource], [500000, 'sidecar']);
    assert.equal(c1.points.length, 4);
    assert.equal(c1.compactions.length, 2);
    assert.deepEqual(c1.handoffs.map((h) => h.path), ['C:/h/one.md', 'C:/h/two.md']);
    assert.equal(viaWorker.contextUnknown.points.length, 0);

    // The same store, with a query worker that cannot start: the facade runs
    // the same queries on its own connection and says so.
    const before = workers.made[0];
    assert.deepEqual(t.close(), { ok: true });
    assert.equal(H.closedFlag(before), 1, 'close() waited for the worker to close its connection');
    const ctx2 = H.ctx({ createQueryWorker: () => { throw new Error('worker file missing'); }, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx2), { ok: true, state: 'ok' });
    const viaFallback = await H.askAll();
    for (const key of Object.keys(viaFallback)) assert.equal(viaFallback[key].scan.queryMode, 'inline', key);
    assert.equal(t.status().queryMode, 'inline');
    assert.deepStrictEqual(H.strip(viaFallback), H.strip(viaWorker), 'inline answers equal the worker\'s');
    assert.deepEqual(ctx2.logs.filter((l) => l.includes('query worker is not available')),
      ['warn: [token-usage] the query worker is not available (worker file missing): token queries run in the main process']);
    assert.deepEqual(ctx.logs.filter((l) => !l.startsWith('info: ')), [], 'the worker path logged nothing at warn or error');
    assert.equal(ctx.logs.filter((l) => l === 'info: [token-usage] query worker ready').length, 1, 'and its hello is in the log, once per worker');
    t.close();
    return { queries: Object.keys(viaWorker).length, rows: seeded.rows.length };
  },

  // Real worker. Rebuild with the query worker's connection open really
  // replaces the database file, and queries work again afterwards.
  async realRebuild(H) {
    const { t } = H;
    const workers = realQueryWorkers();
    const ctx = H.ctx({ createQueryWorker: workers.create, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const seeded = H.seed();
    assert.equal((await t.summary(ALL)).totals.responses, seeded.rows.length);
    assert.equal(workers.made.length, 1);
    assert.equal(H.closedFlag(workers.made[0]), 0, 'the worker holds the file open');

    // A marker only a real delete removes: the fallback for a file that could
    // not be deleted drops the store's five tables in place and keeps this one.
    t._handle().exec('CREATE TABLE rebuild_marker (x)');
    assert.equal(H.hasTable('rebuild_marker'), true);
    // There is no scanner in this scenario, so the flag its `done` would set is
    // written here: a store whose first backfill never finished is deleted by a
    // rebuild, not kept (the last part of this scenario).
    const backfillFinished = () => t._handle().prepare("UPDATE meta SET value = '2026-10-03T00:00:00.000Z' WHERE key = 'backfill_done'").run();
    backfillFinished();
    const idBefore = H.identity();

    // One query is in flight when Rebuild is clicked.
    const inFlight = t.summary(ALL);
    assert.deepEqual(t.rescan(), { ok: true });
    assert.equal(H.closedFlag(workers.made[0]), 1, 'the old worker confirmed that its connection is closed');
    assert.equal(H.hasTable('rebuild_marker'), false, 'the file was deleted and created again, not emptied in place');
    assert.notEqual(H.identity(), idBefore, 'a new file on disk');
    assert.equal(t._handle().prepare('SELECT COUNT(*) AS n FROM responses').get().n, 0);
    assert.equal(workers.made.length, 2, 'the query worker is started again: the store stays open');

    // The old file was not deleted: it was renamed (which, on Windows, only
    // works because the worker's connection was confirmed closed first) and it
    // is complete, the rows that were still in the write-ahead log included.
    const keptFiles = () => fs.readdirSync(H.dirs.dataDir).filter((n) => n.startsWith('token-usage.db.before-rebuild-'));
    const keptCounts = (name) => {
      const old = new (require('better-sqlite3'))(path.join(H.dirs.dataDir, name), { readonly: true, fileMustExist: true });
      try {
        return {
          responses: old.prepare('SELECT COUNT(*) AS n FROM responses').get().n,
          marker: old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'rebuild_marker'").get().n,
          check: old.pragma('integrity_check', { simple: true }),
        };
      } finally {
        old.close();
      }
    };
    let kept = keptFiles();
    assert.equal(kept.length, 1, fs.readdirSync(H.dirs.dataDir).join(', '));
    assert.match(kept[0], /^token-usage\.db\.before-rebuild-\d{13}$/);
    assert.equal(String(fs.statSync(path.join(H.dirs.dataDir, kept[0]), { bigint: true }).ino), idBefore, 'the kept file IS the old store');
    assert.deepEqual(keptCounts(kept[0]), { responses: seeded.rows.length, marker: 1, check: 'ok' });

    const answered = await inFlight;
    assert.equal(answered.error, undefined, 'the query that was in flight is asked again of the new worker');
    assert.equal(answered.totals.responses, 0);
    assert.equal(answered.scan.queryMode, 'worker');

    // Queries work again, against the new file.
    const f = H.fileRow('proj-a/' + S1 + '.jsonl', 'main', 'proj-a', S1);
    H.apply(f, [H.cand('n1', f, { output: 42 }), H.cand('n2', f, { output: 8 })]);
    const after = await t.summary(ALL);
    assert.deepEqual([after.totals.responses, after.totals.output, after.scan.queryMode], [2, 50, 'worker']);
    assert.equal((await t.sessions(ALL)).rows[0].title, 'First');
    assert.equal(workers.made.length, 2);

    // Twice in a row, with no query between.
    backfillFinished();
    assert.deepEqual(t.rescan(), { ok: true });
    assert.equal(H.closedFlag(workers.made[1]), 1);
    assert.equal(workers.made.length, 3);
    assert.equal((await t.summary(ALL)).totals.responses, 0);
    kept = keptFiles();
    assert.equal(kept.length, 1, 'only the latest is kept: ' + kept.join(', '));
    assert.deepEqual(keptCounts(kept[0]), { responses: 2, marker: 0, check: 'ok' });

    // A third time, before the new store's first backfill has finished (its
    // flag is still empty): that store is really deleted, with the worker's
    // connection open on it, and the copy kept above is left as it is.
    H.apply(f, [H.cand('n3', f, { output: 1 })]);
    assert.equal((await t.summary(ALL)).totals.responses, 1);
    t._handle().exec('CREATE TABLE rebuild_marker (x)');
    const keptInode = String(fs.statSync(path.join(H.dirs.dataDir, kept[0]), { bigint: true }).ino);
    assert.deepEqual(t.rescan(), { ok: true });
    assert.equal(H.closedFlag(workers.made[2]), 1);
    assert.equal(workers.made.length, 4);
    assert.equal(H.hasTable('rebuild_marker'), false, 'deleted and created again, not emptied in place');
    assert.equal((await t.summary(ALL)).totals.responses, 0);
    const still = keptFiles().filter((n) => /^token-usage\.db\.before-rebuild-\d{13}$/.test(n));
    assert.deepEqual(still, kept, 'the kept copy is still the full one');
    assert.equal(String(fs.statSync(path.join(H.dirs.dataDir, still[0]), { bigint: true }).ino), keptInode);
    assert.deepEqual(keptCounts(still[0]), { responses: 2, marker: 0, check: 'ok' });
    assert.equal(ctx.logs.filter((l) => l.includes('had not finished its first backfill')).length, 1);
    assert.deepEqual(ctx.logs.filter((l) => l.startsWith('warn: ') || l.startsWith('error: ')), []);
    t.close();
    assert.equal(H.closedFlag(workers.made[3]), 1);
  },

  // Real worker. The kill switch, shutdown() and close() each close the
  // worker's connection: afterwards the file can be deleted.
  async realKillSwitch(H) {
    const { t } = H;
    const workers = realQueryWorkers();
    const ctx = H.ctx({ createQueryWorker: workers.create, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    H.seed();
    assert.equal((await t.summary(ALL)).scan.queryMode, 'worker');
    if (process.platform === 'win32') {
      assert.throws(() => fs.unlinkSync(H.dbFile), /EBUSY|EPERM|EACCES/, 'control: an open handle refuses the delete on Windows');
    }

    const inFlight = t.models(ALL);
    assert.deepEqual(t.disable(), { ok: true, state: 'disabled' });
    assert.equal(H.closedFlag(workers.made[0]), 1, 'disable() waited for the worker to close its connection');
    for (const sfx of ['', '-wal', '-shm']) {
      assert.doesNotThrow(() => { try { fs.unlinkSync(H.dbFile + sfx); } catch (err) { if (err.code !== 'ENOENT') throw err; } },
        'token-usage.db' + sfx + ' can be deleted once the store is off');
    }
    assert.equal(fs.existsSync(H.dbFile), false);
    const refused = await inFlight;
    assert.equal(refused.error, 'Token store unavailable: disabled by token-usage.off');
    assert.deepEqual([refused.scan.state, refused.scan.reasonCode, refused.scan.files], ['disabled', 'kill-switch', null]);
    assert.equal((await t.summary(ALL)).error, 'Token store unavailable: disabled by token-usage.off');
    assert.equal(workers.made.length, 1, 'no worker is started while the store is off');

    // Back on: a fresh store (the file was deleted), served by a new worker.
    assert.deepEqual(t.enable(), { ok: true, state: 'ok' });
    const fresh = await t.summary(ALL);
    assert.deepEqual([fresh.totals.responses, fresh.scan.queryMode, fresh.scan.reasonCode], [0, 'worker', null]);
    assert.equal(workers.made.length, 2);

    // shutdown(): the worker's connection is closed; the store stays readable
    // on its own connection until close().
    assert.deepEqual(t.shutdown(), { ok: true });
    assert.equal(H.closedFlag(workers.made[1]), 1, 'shutdown() waited for the worker to close its connection');
    const late = await t.summary(ALL);
    assert.deepEqual([late.error, late.totals.responses, late.scan.queryMode], [undefined, 0, 'inline']);
    assert.equal(workers.made.length, 2, 'no worker is started after shutdown');
    assert.deepEqual(t.close(), { ok: true });
    assert.doesNotThrow(() => fs.unlinkSync(H.dbFile), 'after close() nothing holds the file');
    assert.match((await t.summary(ALL)).error, /^Token store unavailable/);
  },

  // Real worker. A corrupt store is renamed away while the query worker has it
  // open: the rename really happens, and queries work on the new store.
  async realCorruptRename(H) {
    const { t } = H;
    const workers = realQueryWorkers();
    const ctx = H.ctx({ createQueryWorker: workers.create, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    H.seed();
    assert.equal((await t.summary(ALL)).scan.queryMode, 'worker');
    t._handle().exec('CREATE TABLE rename_marker (x)');

    // The failure is injected from inside the chunk transaction, carrying the
    // code better-sqlite3 reports for a corrupt file.
    const f = H.fileRow('proj-a/' + S1 + '.jsonl', 'main', 'proj-a', S1);
    const poisoned = H.cand('p1', f);
    Object.defineProperty(poisoned, 'ts_ms', { get() { throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }); } });
    const inFlight = t.summary(ALL);
    const r = t.applyChunk({ type: 'chunk', gen: t._gen(), rel_path: f.rel_path, seq: 0, last: true, fileRow: f,
      candidates: [poisoned], compactions: [], fullRescan: false, lines_skipped: 0 });
    assert.equal(r.error, 'database disk image is malformed');
    assert.equal(t.status().state, 'ok', 'recovered: ' + t.status().reason);
    assert.equal(H.closedFlag(workers.made[0]), 1, 'the worker confirmed its connection closed before the rename');

    const kept = fs.readdirSync(H.dirs.dataDir).filter((n) => /^token-usage\.db\.corrupt-\d+$/.test(n));
    assert.equal(kept.length, 1, 'the old file was renamed away: ' + fs.readdirSync(H.dirs.dataDir).join(', '));
    assert.equal(H.hasTable('rename_marker'), false, 'the store is a new file');
    const old = new (require('better-sqlite3'))(path.join(H.dirs.dataDir, kept[0]), { readonly: true });
    try {
      assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'rename_marker'").get().n, 1, 'and the renamed file is the old one');
    } finally {
      old.close();
    }
    const answered = await inFlight;
    assert.equal(answered.error, undefined);
    assert.deepEqual([answered.totals.responses, answered.scan.queryMode], [0, 'worker']);
    assert.equal(workers.made.length, 2, 'the query worker is started again on the new file');
    t.close();
  },

  // Real worker. Pages of the responses table are damaged ON DISK while the
  // store is open and idle, so only a query reads them (review C2). The worker's
  // answer carries the code, the store renames the file away and asks for a
  // backfill.
  async realCorruptQuery(H) {
    const { t } = H;
    const { EventEmitter } = require('events');
    const workers = realQueryWorkers();
    const scanners = [];
    const ctx = H.ctx({
      createQueryWorker: workers.create,
      workerPath: path.join(APP_DIR, 'workers', 'scan-tokens.js'),
      createWorker: (workerPath, workerData) => {
        const s = new EventEmitter();
        s.workerData = workerData;
        s.posted = [];
        s.postMessage = (m) => { s.posted.push(m); };
        s.terminate = () => Promise.resolve(0);
        scanners.push(s);
        return s;
      },
    });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const hello = (s) => s.emit('message', { type: 'hello', gen: s.workerData.gen, parseVersion: 1 });
    hello(scanners[0]);
    // Enough rows that the table has leaf pages of its own.
    const f = H.fileRow('proj-a/' + S1 + '.jsonl', 'main', 'proj-a', S1);
    for (let i = 0; i < 6; i++) {
      const rows = [];
      for (let j = 0; j < 500; j++) rows.push(H.cand('r' + i + '-' + j, f, { output: 1 }));
      H.apply(f, rows);
    }
    scanners[0].emit('message', { type: 'done', gen: t._gen(), mode: 'backfill', seen: [], missing: [] });
    for (let i = 0; i < 100 && t._handle().prepare("SELECT value FROM meta WHERE key = 'indexes_built'").get().value !== '1'; i++) await sleep(10);
    assert.equal((await t.summary(ALL)).totals.responses, 3000);
    assert.equal(workers.made.length, 1);

    // Fold the log into the main file, then overwrite every leaf page of the table.
    t._handle().pragma('wal_checkpoint(TRUNCATE)');
    const pageSize = t._handle().pragma('page_size', { simple: true });
    const leaves = t._handle().prepare("SELECT pageno FROM dbstat WHERE name = 'responses' AND pagetype = 'leaf'").all().map((r) => r.pageno);
    assert.ok(leaves.length > 10 && !leaves.includes(1), 'leaf pages: ' + leaves.length);
    const junk = Buffer.alloc(pageSize, 0xab);
    const fd = fs.openSync(H.dbFile, 'r+');
    try {
      for (const p of leaves) fs.writeSync(fd, junk, 0, pageSize, (p - 1) * pageSize);
    } finally {
      fs.closeSync(fd);
    }

    const g = t._gen();
    // What the Tokens tab asks when it loads: four at once.
    const answers = await Promise.all([t.summary(ALL), t.models(ALL), t.daily(ALL), t.sessions(ALL)]);
    const failed = answers.filter((a) => typeof a.error === 'string');
    assert.ok(failed.length >= 1, 'the query that read the damaged pages says so');
    for (const a of failed) {
      assert.match(a.error, /^query failed: .*malformed/);
      assert.match(a.code, /^SQLITE_CORRUPT/, 'the code crosses the thread boundary with the error');
    }
    for (const a of answers) if (a.error === undefined) assert.equal(a.totals ? a.totals.responses : 0, 0, 'or it was asked again of the new store');
    assert.equal(t.status().state, 'ok', 'recovered: ' + t.status().reason);
    assert.ok(t._gen() > g);
    const kept = fs.readdirSync(H.dirs.dataDir).filter((n) => /^token-usage\.db\.corrupt-\d+$/.test(n));
    assert.equal(kept.length, 1, 'one renamed file: ' + fs.readdirSync(H.dirs.dataDir).join(', '));
    assert.equal(H.closedFlag(workers.made[0]), 1, 'the worker confirmed its connection closed before the rename');
    assert.equal(t._handle().prepare('SELECT COUNT(*) AS n FROM responses').get().n, 0, 'a fresh store');
    assert.equal(scanners.length, 2, 'the scanner is started again');
    hello(scanners[1]);
    assert.deepEqual(scanners[1].posted.filter((m) => m.type === 'walk').map((m) => m.mode), ['backfill'], 'a backfill is requested');
    // Queries work again, against the new file.
    const after = await t.summary(ALL);
    assert.deepEqual([after.error, after.totals.responses, after.scan.queryMode, after.scan.reasonCode], [undefined, 0, 'worker', null]);
    t.close();
  },

  // Real worker. One that is killed is replaced, and the query it was working
  // on resolves to { error }.
  async realKilled(H) {
    const { t } = H;
    const workers = realQueryWorkers();
    const ctx = H.ctx({ createQueryWorker: workers.create, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const seeded = H.seed();
    assert.equal((await t.summary(ALL)).totals.responses, seeded.rows.length);

    const doomed = t.sessions(ALL);          // posted to the worker in this turn
    const exited = workers.made[0].w.terminate();
    const lost = await doomed;
    await exited;
    assert.match(lost.error, /^query worker stopped \(/);
    assert.equal(lost.scan.state, 'ok', 'a dead query worker does not turn the store off');
    assert.equal(workers.made.length, 1, 'the respawn waits for its backoff');

    // Asked during the backoff: it waits for the replacement.
    const waited = t.summary(ALL);
    assert.equal(await settled(waited, 100), false);
    const again = await waited;
    assert.equal(workers.made.length, 2, 'the worker was replaced');
    assert.deepEqual([again.error, again.totals.responses, again.scan.queryMode], [undefined, seeded.rows.length, 'worker']);
    assert.equal(ctx.logs.filter((l) => l.includes('query worker stopped')).length, 1);
    assert.equal(t.status().queryMode, 'worker');
    t.close();
  },

  // Real worker. A query asked while a backfill is being written resolves.
  async realDuringBackfill(H) {
    const { t } = H;
    const { EventEmitter } = require('events');
    const workers = realQueryWorkers();
    // A stub scanner, so the store is in a real backfill walk: chunks arrive
    // through the worker-message path while the queries are out.
    let scanner = null;
    const ctx = H.ctx({
      createQueryWorker: workers.create,
      workerPath: path.join(APP_DIR, 'workers', 'scan-tokens.js'),
      createWorker: (workerPath, workerData) => {
        scanner = new EventEmitter();
        scanner.workerData = workerData;
        scanner.postMessage = () => {};
        scanner.terminate = () => Promise.resolve(0);
        return scanner;
      },
    });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    scanner.emit('message', { type: 'hello', gen: scanner.workerData.gen, parseVersion: 1 });
    const first = await t.summary(Object.assign({ opened: true }, ALL));   // opens the tab: asks for the walk
    assert.equal(workers.made[0].workerPath, QW_PATH, 'with ctx.workerPath: query-tokens.js beside the scan worker');
    assert.equal(first.totals.responses, 0);
    assert.equal(t.status().phase, 'backfill');

    const total = 400;
    const asked = [];
    for (let i = 0; i < total; i++) {
      const sid = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
      const f = H.fileRow('proj-a/' + sid + '.jsonl', 'main', 'proj-a', sid, { birthtime_ms: 1000 + i });
      scanner.emit('message', { type: 'chunk', gen: t._gen(), rel_path: f.rel_path, seq: 0, last: true, fileRow: f,
        candidates: [H.cand('m' + i + 'a', f, { output: 1 }), H.cand('m' + i + 'b', f, { output: 1 })],
        compactions: [], fullRescan: false, lines_skipped: 0 });
      if (i % 40 === 0) {
        asked.push(t.summary(ALL), t.models(ALL), t.daily(ALL), t.sessions(ALL));
        await sleep(1);                       // let answers and writes interleave
      }
    }
    const answers = await Promise.all(asked);
    assert.equal(answers.length, 40);
    let last = 0;
    for (const a of answers) {
      assert.equal(a.error, undefined, JSON.stringify(a.error));
      assert.equal(a.scan.queryMode, 'worker');
      const n = a.totals ? a.totals.responses : null;
      if (n !== null) { assert.ok(n >= last && n <= total * 2, 'a summary sees a committed prefix: ' + n); last = n; }
    }
    scanner.emit('message', { type: 'done', gen: t._gen(), mode: 'backfill', seen: [], missing: [] });
    const end = await t.summary(ALL);
    assert.deepEqual([end.totals.responses, end.scan.phase, end.scan.files], [total * 2, 'idle', total]);
    assert.equal(workers.made.length, 1, 'index creation and 400 commits did not cost the worker');
    assert.deepEqual(ctx.logs.filter((l) => l.startsWith('warn: ') || l.startsWith('error: ')), []);
    t.close();
  },

  // Real worker. Garbage arguments: nothing throws, nothing rejects, the
  // worker survives, and each answer is what the inline path says.
  async realGarbage(H) {
    const { t } = H;
    const workers = realQueryWorkers();
    const ctx = H.ctx({ createQueryWorker: workers.create, clock: { now: () => NOW } });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    H.seed();
    const inline = require(QUERIES).createQueries(t._handle(), {
      localDay: t.localDay, dayList: t.dayList, sessionInfo: ctx.sessionInfo, folderMeta: ctx.folderMeta, isRunning: ctx.isRunning,
      ctxDir: ctx.ctxDir, handoffsDir: ctx.handoffsDir, now: () => NOW,
    });
    let calls = 0;
    for (const name of QUERY_NAMES) {
      for (const g of GARBAGE) {
        let p;
        assert.doesNotThrow(() => { p = t[name](g, g, g); }, name);
        assert.equal(typeof p.then, 'function');
        let v;
        try { v = await p; } catch (err) { assert.fail(name + ' rejected: ' + (err && err.message)); }
        assert.ok(v && typeof v === 'object' && v.scan && v.scan.state === 'ok', name + ' ' + String(typeof g));
        assert.equal(v.scan.queryMode, 'worker');
        const want = inline[name](g);
        delete v.scan;
        assert.deepStrictEqual(v, want, name + '(' + String(typeof g) + ') equals the inline answer');
        calls++;
      }
      assert.doesNotThrow(() => t[name]());
    }
    assert.equal(workers.made.length, 1, 'no garbage cost the worker');
    assert.equal(t.status().state, 'ok');
    assert.deepEqual(ctx.logs.filter((l) => l.startsWith('warn: ') || l.startsWith('error: ')), []);
    t.close();
    return { calls };
  },

  // The worker on its own, with no store around it: its hello, its answers,
  // its close, and the file it must never create or change.
  async realDirect(H) {
    const { t, dirs } = H;
    const { Worker } = require('worker_threads');
    const Database = require('better-sqlite3');
    const crypto = require('crypto');
    fs.mkdirSync(dirs.dataDir, { recursive: true });
    const start = (dbPath, raise) => {
      const signal = new Int32Array(new SharedArrayBuffer(8));
      if (raise) Atomics.store(signal, 0, 1);
      const w = new Worker(QW_PATH, { workerData: { dbPath, signal: signal.buffer } });
      const inbox = [];
      const waiters = [];
      w.on('message', (m) => { const next = waiters.shift(); if (next) next(m); else inbox.push(m); });
      const next = () => new Promise((resolve) => { if (inbox.length) resolve(inbox.shift()); else waiters.push(resolve); });
      return { w, signal, next };
    };

    // A store with the schema and one row.
    const good = path.join(dirs.dataDir, 'direct.db');
    const db = new Database(good);
    assert.deepEqual(t.createSchema(db), { ok: true });
    db.prepare("INSERT INTO files (rel_path, kind, slug, session_id, size, mtime_ms, birthtime_ms) VALUES ('p/s.jsonl', 'main', 'p', ?, 1, 1, 1)").run(S1);
    db.prepare("INSERT INTO responses (message_id, file_id, session_id, kind, slug, owner_birth_ms, model, ts_ms, local_day, input, output, cache_write, cache_read, finalized) " +
      "VALUES ('m1', 1, ?, 'main', 'p', 1, 'claude-opus-5-5', ?, ?, 3, 4, 5, 6, 1)").run(S1, D1, t.localDay(D1));
    db.close();
    const hash = () => crypto.createHash('sha1').update(fs.readFileSync(good)).digest('hex');
    const before = hash();

    const a = start(good);
    assert.deepEqual(await a.next(), { type: 'hello', ok: true });
    a.w.postMessage({ type: 'query', id: 7, name: 'summary', q: ALL, now: NOW });
    const res = await a.next();
    assert.deepEqual([res.type, res.id, res.result.totals.responses, res.result.totals.output], ['result', 7, 1, 4]);
    assert.equal(typeof res.ms, 'number');
    assert.equal('scan' in res.result, false, 'scan is the store\'s to add');
    a.w.postMessage({ type: 'query', id: 8, name: 'sessions', q: ALL, now: NOW });
    const row = (await a.next()).result.rows[0];
    assert.deepEqual([row.title, row.projectPath, row.isRunning], [null, 'p', false], 'no lookups in the worker: main fills these in');
    for (const name of ['nope', '__proto__', 'constructor', 42, undefined]) {
      a.w.postMessage({ type: 'query', id: 9, name, q: {} });
      assert.deepEqual((await a.next()).result, { error: 'bad request: unknown query' });
    }
    for (const junk of [null, 42, 'x', {}, { type: 'nope' }]) a.w.postMessage(junk);
    a.w.postMessage({ type: 'query', id: 10, name: 'context', q: { sessionId: S1 } });
    assert.equal((await a.next()).result.points.length, 1, 'junk on the channel is ignored and the worker lives on');
    if (process.platform === 'win32') {
      assert.throws(() => fs.unlinkSync(good), /EBUSY|EPERM|EACCES/, 'control: the worker\'s handle refuses the delete');
    }
    assert.equal(Atomics.load(a.signal, 1), 0);
    a.w.postMessage({ type: 'close' });
    assert.deepEqual(await a.next(), { type: 'closed' });
    assert.equal(Atomics.load(a.signal, 1), 1);
    a.w.postMessage({ type: 'query', id: 11, name: 'summary', q: ALL });
    assert.deepEqual((await a.next()).result, { error: 'query worker closed' });
    assert.equal(hash(), before, 'the worker changed nothing in the file');
    assert.doesNotThrow(() => fs.unlinkSync(good), 'the file can be deleted once the worker has closed');
    await a.w.terminate();

    // The closing flag alone (no message): the next query closes the connection.
    const again = path.join(dirs.dataDir, 'direct2.db');
    const db2 = new Database(again);
    t.createSchema(db2);
    db2.close();
    const b = start(again);
    assert.deepEqual(await b.next(), { type: 'hello', ok: true });
    Atomics.store(b.signal, 0, 1);
    b.w.postMessage({ type: 'query', id: 1, name: 'summary', q: ALL });
    assert.deepEqual((await b.next()).result, { error: 'query worker closed' });
    assert.equal(Atomics.load(b.signal, 1), 1);
    assert.doesNotThrow(() => fs.unlinkSync(again));
    await b.w.terminate();

    // A file that is not there: an error in the hello, and no file is created.
    const missing = path.join(dirs.dataDir, 'not-there.db');
    const c = start(missing);
    const helloC = await c.next();
    assert.deepEqual([helloC.type, helloC.ok, typeof helloC.error], ['hello', false, 'string']);
    assert.equal(fs.existsSync(missing), false, 'fileMustExist: the worker never creates the store');
    assert.equal(Atomics.load(c.signal, 1), 1, 'a worker that could not open holds nothing');
    c.w.postMessage({ type: 'query', id: 1, name: 'summary', q: ALL });
    assert.match((await c.next()).result.error, /query worker/);
    await c.w.terminate();

    // A database without the schema, and a file that is no database.
    const empty = path.join(dirs.dataDir, 'empty.db');
    const db3 = new Database(empty);
    db3.exec('CREATE TABLE x (y)');
    db3.close();
    const d = start(empty);
    assert.deepEqual(await d.next(), { type: 'hello', ok: false, error: 'the store has no schema yet' });
    await d.w.terminate();
    const junk = path.join(dirs.dataDir, 'junk.db');
    fs.writeFileSync(junk, 'this is not a database. '.repeat(400));
    const e = start(junk);
    const helloE = await e.next();
    assert.deepEqual([helloE.ok, typeof helloE.error], [false, 'string']);
    assert.equal(fs.readFileSync(junk, 'utf8'), 'this is not a database. '.repeat(400));
    await e.w.terminate();

    // Asked to close before it had opened anything.
    const f = start(empty, true);
    assert.deepEqual(await f.next(), { type: 'hello', ok: false, error: 'closed before it opened' });
    assert.equal(Atomics.load(f.signal, 1), 1);
    await f.w.terminate();
    return { missingError: helloC.error, junkError: helloE.error };
  },

  // Stub worker, fake clock. No answer after 30 s resolves to
  // { error: 'query timed out' } and the worker is replaced; respawns are
  // limited to 3 an hour; past that the queries run inline.
  async stubTimeout(H) {
    const { t } = H;
    const stubs = stubQueryWorkers();
    const clock = fakeClock();
    const ctx = H.ctx({ createQueryWorker: stubs.create, clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    const base = clock.count();
    assert.equal(stubs.made.length, 0);

    const p1 = t.summary({ from: '2026-01-01', to: '2026-01-31' });
    assert.equal(stubs.made.length, 1);
    const w1 = stubs.last;
    assert.equal(w1.queries().length, 0, 'nothing is posted before the worker says hello');
    w1.hello();
    assert.deepEqual(w1.queries().map((m) => [m.name, m.q, m.now]), [['summary', { from: '2026-01-01', to: '2026-01-31' }, clock.now()]]);
    const p2 = t.sessions({ limit: 5, junk: () => {} });
    assert.deepEqual(w1.queries()[1].q, { limit: 5 }, 'only the known fields of a request are posted');
    clock.advance(20000);
    // An ordinary answer: decorated by main, with scan.
    w1.answer(w1.queries()[1].id, { range: {}, total: 1, rows: [{ sessionId: S1, slug: 'proj-a', title: null, projectPath: 'proj-a', isRunning: false }] });
    const r2 = await p2;
    assert.deepEqual(r2.rows, [{ sessionId: S1, slug: 'proj-a', title: 'First', projectPath: 'C:/work/alpha', isRunning: false }]);
    assert.deepEqual([r2.scan.state, r2.scan.queryMode], ['ok', 'worker']);

    const p3 = t.daily({});
    clock.advance(9999);
    assert.equal(await settled(p1), false, 'not before 30 s');
    assert.equal(w1.terminated, false);
    clock.advance(1);
    const r1 = await p1;
    assert.equal(r1.error, 'query timed out');
    assert.equal(r1.scan.state, 'ok');
    assert.equal(w1.terminated, true, 'the stuck worker is terminated');
    assert.equal(Atomics.load(w1.signal, 0), 1, 'and told to close its connection instead of starting another query');
    const r3 = await p3;
    assert.equal(r3.error, 'query worker replaced after a timeout', 'what sat behind the stuck query has no answer either');
    // A late answer from the replaced worker is ignored.
    assert.doesNotThrow(() => w1.answer(w1.queries()[0].id, { totals: {} }));
    assert.doesNotThrow(() => w1.emit('exit', 1));

    // Replaced after the backoff; a query asked meanwhile waits for it.
    const p4 = t.models({});
    assert.equal(stubs.made.length, 1);
    clock.advance(999);
    assert.equal(stubs.made.length, 1);
    clock.advance(1);
    assert.equal(stubs.made.length, 2, 'first respawn after 1 s');
    const w2 = stubs.last;
    assert.equal(w2.queries().length, 0);
    w2.hello();
    assert.deepEqual(w2.queries().map((m) => m.name), ['models']);
    w2.answer(w2.queries()[0].id, { models: [] });
    assert.deepEqual((await p4).models, []);

    // error then exit of the same worker: one respawn, not two.
    w2.emit('error', new Error('boom'));
    w2.emit('exit', 1);
    clock.advance(4999);
    assert.equal(stubs.made.length, 2);
    clock.advance(1);
    assert.equal(stubs.made.length, 3, 'second respawn after 5 s');
    stubs.last.hello();
    stubs.last.emit('exit', 1);
    clock.advance(14999);
    assert.equal(stubs.made.length, 3);
    clock.advance(1);
    assert.equal(stubs.made.length, 4, 'third respawn after 15 s');
    stubs.last.hello();
    assert.equal(t.status().queryMode, 'worker');

    // A fourth loss inside the hour: no more respawns, the queries run inline
    // on the store's own connection, and that is logged once.
    const p5 = t.summary({});
    stubs.last.emit('exit', 1);
    assert.match((await p5).error, /^query worker stopped/);
    clock.advance(3600000);
    assert.equal(stubs.made.length, 4, 'at most 3 respawns per hour');
    assert.equal(t.status().queryMode, 'inline');
    const inline = await t.summary({});
    assert.deepEqual([inline.error, inline.totals.responses, inline.scan.queryMode], [undefined, 0, 'inline']);
    await t.models({});
    assert.equal(ctx.logs.filter((l) => l.includes('query worker is not available')).length, 1, 'logged once');
    assert.equal(stubs.made.length, 4);

    // Rebuild reads the worker file again: the worker is given another try.
    assert.deepEqual(t.rescan(), { ok: true });
    assert.equal(stubs.made.length, 5);
    assert.equal(t.status().queryMode, 'worker');
    const p6 = t.summary({});
    stubs.last.hello();
    stubs.last.answer(stubs.last.queries()[0].id, { totals: { responses: 0 } });
    assert.equal((await p6).scan.queryMode, 'worker');

    // close(): the worker is closed and terminated, nothing is left armed.
    const p7 = t.summary({});
    const last = stubs.last;
    assert.deepEqual(t.close(), { ok: true });
    assert.deepEqual(last.posted[last.posted.length - 1], { type: 'close' });
    assert.equal(last.terminated, true);
    assert.match((await p7).error, /^Token store unavailable/);
    assert.equal(clock.count(), 0, 'no timer is left');
    assert.ok(base >= 0);
  },

  // Stub worker, fake clock. A query worker that cannot start: the facade
  // runs the queries inline, with the right answers, and logs it once.
  async stubCannotStart(H) {
    const { t } = H;
    const want = (ctx, clock) => H.strip({ a: require(QUERIES).createQueries(t._handle(), {
      localDay: t.localDay, dayList: t.dayList, sessionInfo: ctx.sessionInfo, folderMeta: ctx.folderMeta, isRunning: ctx.isRunning,
      ctxDir: ctx.ctxDir, handoffsDir: ctx.handoffsDir, now: () => clock.now(),
    }).sessions(ALL) }).a;
    const check = async (label, ctx, clock, p) => {
      const r = await p;
      assert.equal(r.scan.queryMode, 'inline', label);
      assert.equal(r.scan.state, 'ok', label);
      delete r.scan;
      assert.deepStrictEqual(r, want(ctx, clock), label + ': the inline answer is the right one');
      assert.equal(r.total, 3, label);
      assert.equal(t.status().queryMode, 'inline', label);
      assert.equal(ctx.logs.filter((l) => l.includes('query worker is not available')).length, 1, label + ': logged once');
      const again = await t.sessions(ALL);
      assert.equal(again.scan.queryMode, 'inline', label);
      assert.equal(ctx.logs.filter((l) => l.includes('query worker is not available')).length, 1, label + ': still once');
    };

    // (a) the worker cannot be created at all.
    let clock = fakeClock();
    let ctx = H.ctx({ createQueryWorker: () => { throw new Error('worker file missing'); }, clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    H.seed();
    await check('create throws', ctx, clock, t.sessions(ALL));
    assert.equal(clock.count() > 0, true);
    t.close();
    assert.equal(clock.count(), 0);

    // (b) createQueryWorker returns something that is not a worker.
    clock = fakeClock();
    ctx = H.ctx({ createQueryWorker: () => ({}), clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    await check('not a worker', ctx, clock, t.sessions(ALL));
    t.close();

    // (c) hello with an error.
    let stubs = stubQueryWorkers();
    clock = fakeClock();
    ctx = H.ctx({ createQueryWorker: stubs.create, clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    let p = t.sessions(ALL);
    assert.equal(await settled(p), false, 'waiting for the hello');
    stubs.last.hello({ ok: false, error: 'unable to open database file' });
    await check('hello with an error', ctx, clock, p);
    assert.equal(stubs.last.terminated, true);
    assert.equal(stubs.made.length, 1, 'not tried again per query');
    assert.ok(ctx.logs.some((l) => l.includes('unable to open database file')));
    t.close();

    // (d) no hello within 10 s.
    stubs = stubQueryWorkers();
    clock = fakeClock();
    ctx = H.ctx({ createQueryWorker: stubs.create, clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    p = t.sessions(ALL);
    clock.advance(9999);
    assert.equal(await settled(p), false, 'not before 10 s');
    clock.advance(1);
    await check('no hello within 10 s', ctx, clock, p);
    assert.equal(stubs.last.terminated, true);
    assert.doesNotThrow(() => stubs.last.hello(), 'a hello that arrives too late is ignored');
    assert.equal(t.status().queryMode, 'inline');
    t.close();

    // (e) the worker exits before its hello.
    stubs = stubQueryWorkers();
    clock = fakeClock();
    ctx = H.ctx({ createQueryWorker: stubs.create, clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    p = t.sessions(ALL);
    stubs.last.emit('error', Object.assign(new Error("Cannot find module 'better-sqlite3'"), { code: 'MODULE_NOT_FOUND' }));
    stubs.last.emit('exit', 1);
    await check('exit before hello', ctx, clock, p);
    clock.advance(3600000);
    assert.equal(stubs.made.length, 1, 'a worker that never started is not respawned');

    // A fresh init tries the worker again.
    t.close();
    stubs = stubQueryWorkers();
    clock = fakeClock();
    ctx = H.ctx({ createQueryWorker: stubs.create, clock });
    assert.deepEqual(t.init(ctx), { ok: true, state: 'ok' });
    assert.equal(t.status().queryMode, 'worker');
    p = t.sessions(ALL);
    stubs.last.hello();
    stubs.last.answer(stubs.last.queries()[0].id, { range: {}, total: 0, rows: [] });
    assert.equal((await p).scan.queryMode, 'worker');
    // A worker whose postMessage throws: an { error } for that query, no throw.
    stubs.last.postMessage = () => { throw new Error('channel closed'); };
    let r;
    assert.doesNotThrow(() => { p = t.summary(ALL); });
    r = await p;
    assert.match(r.error, /^query could not be sent: channel closed/);
    assert.equal(t.status().state, 'ok');
    // The waiting list is bounded: a renderer that never stops asking gets
    // { error } instead of 200 more timers.
    const deaf = stubs.last;
    deaf.postMessage = () => {};              // hears nothing from here on, 'close' included
    const many = [];
    for (let i = 0; i < 230; i++) many.push(t.models({}));
    const refused = await many[229];
    assert.match(refused.error, /^Token store busy/);
    assert.equal(await settled(many[0]), false);

    // A worker that never confirms its close: the store waits a bounded time
    // (5 s), goes on, says so once, and still does not throw.
    const started = Date.now();
    let closed;
    assert.doesNotThrow(() => { closed = t.close(); });
    const waitedMs = Date.now() - started;
    assert.deepEqual(closed, { ok: true });
    assert.ok(waitedMs >= 4500 && waitedMs < 9000, 'close() waited ' + waitedMs + ' ms for the confirmation');
    assert.equal(deaf.terminated, true);
    assert.equal(ctx.logs.filter((l) => l.includes('did not confirm that its connection is closed')).length, 1);
    assert.equal(t._handle(), null);
    for (const m of many) assert.equal(typeof (await m).error, 'string');
    assert.equal(clock.count(), 0);
    return { unconfirmedCloseMs: waitedMs };
  },

  // The decoration step on its own, timed for a 200-row sessions page.
  async decorate(H) {
    const { decorateResult } = require(QUERIES);
    const rows = [];
    for (let i = 0; i < 200; i++) {
      rows.push({ sessionId: 'sid-' + i, slug: 'proj-' + (i % 12), projectPath: 'proj-' + (i % 12), title: null, isRunning: false });
    }
    const calls = { sessionInfo: 0, folderMeta: 0, isRunning: 0 };
    const lookups = {
      sessionInfo: (id) => { calls.sessionInfo++; return { title: 'Title of ' + id }; },
      folderMeta: (slug) => { calls.folderMeta++; return { projectPath: 'C:/work/' + slug }; },
      isRunning: (id) => { calls.isRunning++; return id === 'sid-7'; },
    };
    const page = { range: {}, total: 200, rows };
    const out = decorateResult('sessions', page, lookups);
    assert.equal(out, page);
    assert.deepEqual(calls, { sessionInfo: 200, folderMeta: 12, isRunning: 200 }, 'one folder lookup per project, not per row');
    assert.deepEqual(rows[7], { sessionId: 'sid-7', slug: 'proj-7', projectPath: 'C:/work/proj-7', title: 'Title of sid-7', isRunning: true });
    // The median of 51 runs: a single run can land on a garbage collection.
    const times = [];
    for (let i = 0; i < 51; i++) {
      const copy = structuredClone(page);
      const started = process.hrtime.bigint();
      decorateResult('sessions', copy, lookups);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return { ms: times[25], worstMs: times[50] };
  },
};

// --------------------------------------------------------------- child main ----

function childMain() {
  const name = process.env.TOKEN_USAGE_SCENARIO;
  const fn = SCENARIOS[name];
  // The store's own timers are unref'd (they must not keep a process alive),
  // so a query that is waiting for a respawn holds nothing open. The app's
  // event loop never empties; here this interval stands in for it.
  setInterval(() => {}, 1000);
  Promise.resolve()
    .then(() => {
      assert.equal(typeof fn, 'function', 'unknown scenario ' + name);
      return fn(makeHarness());
    })
    .then((out) => {
      fs.writeSync(1, '\nRESULT ' + JSON.stringify({ out: out === undefined ? null : out }) + '\n');
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
  const electronBin = require('electron');     // under plain node: the path to the binary

  function run(name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-qw-'));
    const dataDir = path.join(root, 'data');
    assert.ok(path.resolve(dataDir).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep));
    try {
      const r = spawnSync(electronBin, [__filename], {
        cwd: APP_DIR,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir, TOKEN_USAGE_SCENARIO: name },
        encoding: 'utf8',
        timeout: 120000,
      });
      assert.equal(r.status, 0, 'scenario ' + name + ' failed\n' + r.stderr + '\n' + r.stdout);
      const line = r.stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
      assert.ok(line, 'scenario ' + name + ' printed no result\n' + r.stdout + r.stderr);
      return JSON.parse(line.slice(7)).out;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const titles = {
    realEqualsInline: 'all five queries through the worker equal the same queries run inline, field for field; scan.queryMode says which',
    realRebuild: 'Rebuild with the query worker open really replaces the database file; queries work again afterwards',
    realKillSwitch: 'the kill switch, shutdown() and close() close the worker\'s connection: the file can be deleted afterwards',
    realCorruptRename: 'a corrupt store is renamed away although the query worker had it open, and the worker is started again',
    realCorruptQuery: 'pages damaged on disk that only a query reads: the worker answers with the code, the store renames the file and backfills',
    realKilled: 'a query worker that is killed is replaced, and the query it was working on resolves to { error }',
    realDuringBackfill: 'queries asked while a backfill is being written resolve, each seeing a committed state',
    realGarbage: 'nothing rejects for garbage arguments, and each answer equals the inline answer',
    realDirect: 'the worker itself: hello, answers, read-only, close confirmed in shared memory, errors in the hello',
    stubTimeout: 'no answer after 30 s resolves to "query timed out" and the worker is replaced; 3 respawns an hour, then inline',
    stubCannotStart: 'a query worker that cannot start (throws, hello with an error, no hello in 10 s, exit) gives queryMode inline and correct results',
  };
  for (const name of Object.keys(titles)) {
    test(titles[name], () => { run(name); });
  }

  test('decorateResult fills 200 session rows with one folder lookup per project', () => {
    const out = run('decorate');
    assert.ok(out.ms >= 0 && out.ms < 5, 'decorating 200 rows took ' + out.ms + ' ms (median of 51)');
  });
}

if (process.env.TOKEN_USAGE_SCENARIO) childMain();
else parentMain();
