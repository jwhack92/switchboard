// Tests for token-usage-queries.js (design section 4, 5, 7.3; build contract 6.4).
//
// This file has two halves. Under `node --test` it is the PARENT: it spawns
// the Electron binary as Node (better-sqlite3 is compiled for Electron's ABI,
// see test/db-schema-reconcile.test.js:9-20) with this same file as the script
// and TQ_CHILD set. The CHILD half seeds a database in a temp dir with plain
// INSERTs, runs the queries and writes what it saw to result.json; the parent
// then checks it against sums it computes itself from the seed rows, with the
// price ratios written out here rather than taken from token-prices.js.
//
// The real ~/.switchboard is never opened: the child only opens the folder in
// SWITCHBOARD_DATA_DIR and refuses to run unless that is under os.tmpdir().

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

const S1 = '11111111-1111-4111-8111-111111111111'; // original session, project alpha
const S2 = '22222222-2222-4222-8222-222222222222'; // continuation of S1 (copied history)
const S3 = '33333333-3333-4333-8333-333333333333'; // project beta: fable, unfinalised, unknown model
const S4 = '44444444-4444-4444-8444-444444444444'; // project gamma: rows on both sides of the range
const S5 = '55555555-5555-4555-8555-555555555555'; // project delta: 5,000 responses (down-sampling)
const S6 = '66666666-6666-4666-8666-666666666666'; // project epsilon: one small row
const S7 = '77777777-7777-4777-8777-777777777777'; // project zeta: one small row
const NOBODY = '99999999-9999-4999-8999-999999999999';

const SLUG_A = 'C--proj-alpha';
const SLUG_B = 'C--proj-beta';
const SLUG_C = 'C--proj-gamma';
const SLUG_D = 'C--proj-delta';
const SLUG_E = 'C--proj-epsilon';
const SLUG_F = 'C--proj-zeta';

// Noon on 2026-10-03 in America/Los_Angeles, so "today" is 2026-10-03 there and
// the default range is 2026-09-04 .. 2026-10-03.
const NOW_ISO = '2026-10-03T19:00:00Z';
const TZ_ROW_ISO = '2026-10-04T03:30:00Z'; // design 7.3: 2026-10-03 in Los Angeles

if (process.env.TQ_CHILD) {
  runChild(process.env.TQ_CHILD);
} else {
  runParent();
}

// ---------------------------------------------------------------- child ----

function openTempDb(name) {
  const dataDir = process.env.SWITCHBOARD_DATA_DIR;
  if (!dataDir) throw new Error('SWITCHBOARD_DATA_DIR is not set');
  const resolved = fs.realpathSync(path.resolve(dataDir));
  const tmp = fs.realpathSync(os.tmpdir());
  // Build contract rule 5: never a database outside the temp folder.
  if (!(resolved.toLowerCase() + path.sep).startsWith(tmp.toLowerCase() + path.sep)) {
    throw new Error('refusing to open a database outside os.tmpdir(): ' + resolved);
  }
  const Database = require('better-sqlite3');
  return { Database, file: path.join(resolved, name), dir: resolved };
}

function seedRow(id, sid, kind, slug, model, iso, input, output, w5, w1, read, extra) {
  return Object.assign({
    message_id: id, file_id: 1, session_id: sid, kind, slug, wf_id: null, agent_id: null,
    owner_birth_ms: 1000, model, ts_ms: Date.parse(iso),
    input, output, cache_write: w5 + w1, cache_write_5m: w5, cache_write_1h: w1, cache_read: read,
    thinking: null, finalized: 1, stop_reason: 'end_turn',
  }, extra || {});
}

function buildSeed() {
  const OPUS = 'claude-opus-5-5';
  const rows = [
    // S1, the original. m1-m3 are also in S2's file (copied history): they are
    // stored once, here, and S2's file only has a sighting of them.
    seedRow('m1', S1, 'main', SLUG_A, OPUS, '2026-09-10T18:00:00Z', 100, 200, 400, 600, 5000, { thinking: 20 }),
    seedRow('m2', S1, 'main', SLUG_A, OPUS, '2026-09-10T18:05:00Z', 10, 50, 0, 0, 6100),
    seedRow('m3', S1, 'main', SLUG_A, OPUS, '2026-09-11T02:00:00Z', 5, 500, 300, 0, 6400, { thinking: 7 }),
    seedRow('m4', S1, 'main', SLUG_A, OPUS, '2026-09-20T18:00:00Z', 7, 70, 0, 20, 9000),
    // S2, the continuation: only its own responses.
    seedRow('n1', S2, 'main', SLUG_A, OPUS, '2026-09-21T18:00:00Z', 3, 30, 10, 0, 9500, { file_id: 2, owner_birth_ms: 2000 }),
    seedRow('n2', S2, 'main', SLUG_A, OPUS, '2026-09-22T18:00:00Z', 4, 40, 0, 0, 9600, { file_id: 2, owner_birth_ms: 2000 }),
    // S1's subagents: the dated id and the alias of one model.
    seedRow('sa1', S1, 'subagent', SLUG_A, 'claude-haiku-4-5-20251001', '2026-09-10T18:10:00Z', 50, 60, 70, 0, 80, { file_id: 3, agent_id: 'a1' }),
    seedRow('sa2', S1, 'subagent', SLUG_A, 'claude-haiku-4-5', '2026-09-10T18:11:00Z', 1, 2, 0, 0, 3, { file_id: 3, agent_id: 'a1' }),
    seedRow('sa3', S1, 'subagent', SLUG_A, 'claude-haiku-4-5', '2026-09-10T18:12:00Z', 11, 12, 0, 13, 14, { file_id: 4, agent_id: 'a2' }),
    // S1's workflow agents: two workflows, agent id x1 used in both.
    seedRow('w1', S1, 'workflow', SLUG_A, 'claude-sonnet-5', '2026-09-12T18:00:00Z', 20, 21, 22, 0, 23, { file_id: 5, wf_id: 'wf-1', agent_id: 'x1' }),
    seedRow('w2', S1, 'workflow', SLUG_A, 'claude-sonnet-5', '2026-09-12T18:01:00Z', 30, 31, 0, 0, 33, { file_id: 6, wf_id: 'wf-1', agent_id: 'x2' }),
    seedRow('w3', S1, 'workflow', SLUG_A, 'claude-sonnet-5', '2026-09-12T18:02:00Z', 40, 41, 20, 22, 43, { file_id: 7, wf_id: 'wf-2', agent_id: 'x1' }),
    // S3: another price row, a response that never finalised, an unknown model.
    seedRow('f1', S3, 'main', SLUG_B, 'claude-fable-5-1', '2026-10-01T18:00:00Z', 1000, 2000, 0, 3000, 400000, { file_id: 8 }),
    seedRow('f2', S3, 'main', SLUG_B, 'claude-fable-5-1', '2026-10-01T18:01:00Z', 9, 1, 0, 0, 403000, { file_id: 8, finalized: 0, stop_reason: null }),
    seedRow('f3', S3, 'main', SLUG_B, 'mystery-model-9', '2026-10-02T18:00:00Z', 100, 100, 100, 0, 1000, { file_id: 8 }),
    // S4: the range boundary under America/Los_Angeles (UTC-7 on these dates).
    seedRow('b0', S4, 'main', SLUG_C, OPUS, '2026-09-04T06:59:59Z', 1000000, 1000000, 0, 0, 1000000, { file_id: 9 }), // 09-03 23:59:59 local
    seedRow('b1', S4, 'main', SLUG_C, OPUS, '2026-09-04T07:00:00Z', 15, 16, 17, 0, 18, { file_id: 9 }),             // 09-04 00:00:00 local
    seedRow('b2', S4, 'main', SLUG_C, OPUS, TZ_ROW_ISO, 25, 26, 0, 27, 28, { file_id: 9 }),                         // 10-03 20:30 local
    seedRow('b3', S4, 'main', SLUG_C, OPUS, '2026-10-04T07:00:00Z', 2000000, 2000000, 0, 0, 2000000, { file_id: 9 }), // 10-04 00:00 local
    seedRow('e1', S6, 'main', SLUG_E, OPUS, '2026-09-15T18:00:00Z', 1, 1, 0, 0, 0, { file_id: 11 }),
    seedRow('z1', S7, 'main', SLUG_F, OPUS, '2026-09-15T18:00:00Z', 2, 2, 0, 0, 0, { file_id: 12 }),
  ];
  // S5: 5,000 responses a minute apart from 2026-08-01, all before the default
  // range: a sawtooth that jumps up every 700 responses and then falls, with
  // one global peak.
  const base = Date.parse('2026-08-01T00:00:00Z');
  for (let i = 0; i < 5000; i++) {
    const read = i === 3333 ? 999999 : (699 - (i % 700)) * 100 + 1;
    const r = seedRow('big' + String(i).padStart(4, '0'), S5, 'main', SLUG_D, OPUS, '2026-08-01T00:00:00Z', 1, 1, 0, 0, read, { file_id: 10 });
    r.ts_ms = base + i * 60000;
    rows.push(r);
  }
  return rows;
}

function seedDatabase(db, rows, localDay) {
  const insFile = db.prepare(`INSERT INTO files (id, rel_path, kind, slug, session_id, agent_id, wf_id, size, mtime_ms, birthtime_ms, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
  const files = [
    [1, SLUG_A + '/' + S1 + '.jsonl', 'main', SLUG_A, S1, null, null, 1000, null],
    [2, SLUG_A + '/' + S2 + '.jsonl', 'main', SLUG_A, S2, null, null, 2000, null],
    [3, SLUG_A + '/' + S1 + '/subagents/agent-a1.jsonl', 'subagent', SLUG_A, S1, 'a1', null, 1100, null],
    [4, SLUG_A + '/' + S1 + '/subagents/agent-a2.jsonl', 'subagent', SLUG_A, S1, 'a2', null, 1200, null],
    [5, SLUG_A + '/' + S1 + '/workflows/wf-1/agent-x1.jsonl', 'workflow', SLUG_A, S1, 'x1', 'wf-1', 1300, null],
    [6, SLUG_A + '/' + S1 + '/workflows/wf-1/agent-x2.jsonl', 'workflow', SLUG_A, S1, 'x2', 'wf-1', 1400, null],
    [7, SLUG_A + '/' + S1 + '/workflows/wf-2/agent-x1.jsonl', 'workflow', SLUG_A, S1, 'x1', 'wf-2', 1500, null],
    [8, SLUG_B + '/' + S3 + '.jsonl', 'main', SLUG_B, S3, null, null, 3000, null],
    // Gone from disk: "Keep them, marked missing". Its rows must still count.
    [9, SLUG_C + '/' + S4 + '.jsonl', 'main', SLUG_C, S4, null, null, 4000, 1790000000000],
    [10, SLUG_D + '/' + S5 + '.jsonl', 'main', SLUG_D, S5, null, null, 5000, null],
    [11, SLUG_E + '/' + S6 + '.jsonl', 'main', SLUG_E, S6, null, null, 6000, null],
    [12, SLUG_F + '/' + S7 + '.jsonl', 'main', SLUG_F, S7, null, null, 7000, null],
  ];
  const insResp = db.prepare(`INSERT INTO responses (message_id, file_id, session_id, kind, slug, wf_id, agent_id,
      owner_birth_ms, model, ts_ms, local_day, input, output, cache_write, cache_write_5m, cache_write_1h, cache_read,
      thinking, finalized, stop_reason)
    VALUES (@message_id, @file_id, @session_id, @kind, @slug, @wf_id, @agent_id,
      @owner_birth_ms, @model, @ts_ms, @local_day, @input, @output, @cache_write, @cache_write_5m, @cache_write_1h, @cache_read,
      @thinking, @finalized, @stop_reason)`);
  const insSight = db.prepare('INSERT INTO sightings (message_id, file_id) VALUES (?, ?)');
  const insComp = db.prepare(`INSERT INTO compactions (uuid, file_id, session_id, slug, ts_ms, trigger, pre_tokens, post_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const f of files) insFile.run(...f);
    for (const r of rows) {
      r.local_day = localDay(r.ts_ms);
      insResp.run(r);
      insSight.run(r.message_id, r.file_id);
    }
    // The copied prefix: S2's file (2) also carries m1-m3.
    for (const id of ['m1', 'm2', 'm3']) insSight.run(id, 2);
    insComp.run('c1', 1, S1, SLUG_A, Date.parse('2026-09-10T19:00:00Z'), 'auto', 6705, 800);
    insComp.run('c2', 1, S1, SLUG_A, Date.parse('2026-08-01T00:00:00Z'), 'manual', 5000, 400);
    insComp.run('c3', 8, S3, SLUG_B, Date.parse('2026-10-01T18:00:30Z'), 'auto', 404000, 30000);
    insComp.run('c4', 9, S4, SLUG_C, Date.parse('2026-10-04T03:40:00Z'), 'auto', null, null); // 10-03 local: in range
    insComp.run('c5', 9, S4, SLUG_C, Date.parse('2026-10-04T07:30:00Z'), 'auto', 9, 1);       // 10-04 local: out
  })();
}

function writeCtxFiles(dir) {
  const ctxDir = path.join(dir, 'claude-ctx');
  const handoffsDir = path.join(dir, 'handoffs');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.mkdirSync(path.join(handoffsDir, 'latest'), { recursive: true });
  fs.writeFileSync(path.join(ctxDir, S1 + '.json'), JSON.stringify({ context_window_size: 500000, total_input_tokens: 9027 }));
  // Epoch seconds as a float: what the hook writes.
  fs.writeFileSync(path.join(ctxDir, S1 + '.state.json'), JSON.stringify({
    written_at: 1790000000.5, written_tokens: 9027, handoff_path: 'C:/x/h1.md', pending: false,
  }));
  fs.writeFileSync(path.join(ctxDir, S3 + '.state.json'), '{ this is not json');
  fs.writeFileSync(path.join(handoffsDir, 'latest', SLUG_A + '.json'), JSON.stringify({
    slug: SLUG_A,
    entries: [
      // The same write as the state file (1 s later): one mark, not two.
      { session_id: S1, path: 'C:/x/h1.md', written_at: 1790000001.0, tokens: 9100, consumed_by: S2 },
      { session_id: S1, path: 'C:/x/h0.md', written_at: '2026-09-15T12:00:00.000Z', tokens: 7000, consumed_by: null },
      { session_id: S1, path: 'C:/x/hm.md', written_at: 1789000000000, tokens: 6000 },
      { session_id: S2, path: 'C:/x/h2.md', written_at: 1790100000, tokens: 9700, consumed_by: null },
      { session_id: S1, path: 'C:/x/bad.md', written_at: 'not a date', tokens: 1 },
      { session_id: S1, path: 'C:/x/none.md', tokens: 1 },
      null,
      'junk',
    ],
  }));
  return { ctxDir, handoffsDir };
}

function runChild(mode) {
  const { createQueries } = require(path.join(APP_DIR, 'token-usage-queries.js'));
  const store = require(path.join(APP_DIR, 'token-usage.js'));
  const out = { mode, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };

  if (mode === 'tz') {
    const t = openTempDb('token-usage.db');
    let db = new t.Database(t.file);
    store.createSchema(db);
    const ts = Date.parse(TZ_ROW_ISO);
    const row = seedRow('tz1', S4, 'main', SLUG_C, 'claude-opus-5-5', TZ_ROW_ISO, 25, 26, 0, 27, 28);
    seedDatabase(db, [row], store.localDay);
    db.close();
    db = new t.Database(t.file, { readonly: true });
    const q = createQueries(db, { localDay: store.localDay, dayList: store.dayList, now: () => Date.parse(NOW_ISO) });
    out.localDay = store.localDay(ts);
    out.on03 = q.summary({ from: '2026-10-03', to: '2026-10-03' });
    out.on04 = q.summary({ from: '2026-10-04', to: '2026-10-04' });
    out.daily = q.daily({ from: '2026-10-03', to: '2026-10-04' });
    db.close();
    fs.writeFileSync(path.join(t.dir, 'result.json'), JSON.stringify(out));
    return;
  }

  // mode === 'main'
  const t = openTempDb('token-usage.db');
  let db = new t.Database(t.file);
  store.createSchema(db);
  store.createIndexes(db);
  const seed = buildSeed();
  seedDatabase(db, seed, store.localDay);
  db.close();
  // Read-only handle: any statement that writes would fail, so a passing run
  // also shows the queries only read.
  db = new t.Database(t.file, { readonly: true });
  out.readonly = db.readonly === true;
  const dirs = writeCtxFiles(t.dir);

  const depCalls = { sessionInfo: 0, folderMeta: 0, isRunning: 0 };
  const deps = {
    localDay: store.localDay,
    dayList: store.dayList,
    now: () => Date.parse(NOW_ISO),
    ctxDir: dirs.ctxDir,
    handoffsDir: dirs.handoffsDir,
    sessionInfo: (id) => {
      depCalls.sessionInfo++;
      if (id === S1) return { title: 'Alpha original' };
      if (id === S3) throw new Error('sessionInfo blew up');
      return null;
    },
    folderMeta: (slug) => {
      depCalls.folderMeta++;
      if (slug === SLUG_A) return { projectPath: 'C:\\proj\\alpha' };
      if (slug === SLUG_C) throw new Error('folderMeta blew up');
      return null;
    },
    isRunning: (id) => {
      depCalls.isRunning++;
      return id === S2;
    },
  };
  const q = createQueries(db, deps);
  const ALL = { from: '2026-01-01', to: '2026-12-31' };
  const BEFORE = { from: '2026-01-01', to: '2026-09-03' };
  const AFTER = { from: '2026-10-04', to: '2026-12-31' };

  out.seed = seed;
  out.summary = { def: q.summary(), empty: q.summary({}), nul: q.summary(null), all: q.summary(ALL), before: q.summary(BEFORE), after: q.summary(AFTER) };
  out.models = { def: q.models(), all: q.models(ALL), before: q.models(BEFORE), after: q.models(AFTER) };
  out.daily = {
    def: q.daily(),
    top2: q.daily({ topN: 2 }),
    top12all: q.daily({ from: ALL.from, to: ALL.to, topN: 12 }),
    all: q.daily(ALL),
    dst: q.daily({ from: '2026-10-30', to: '2026-11-03' }),
  };
  out.sessions = {
    def: q.sessions({ limit: 2000 }),
    all: q.sessions({ from: ALL.from, to: ALL.to, limit: 2000 }),
    before: q.sessions({ from: BEFORE.from, to: BEFORE.to, limit: 2000 }),
    after: q.sessions({ from: AFTER.from, to: AFTER.to, limit: 2000 }),
    byLastTs: q.sessions({ sort: 'last_ts' }),
    byOutput: q.sessions({ sort: 'output' }),
    byCacheRead: q.sessions({ sort: 'cache_read' }),
    byPeak: q.sessions({ sort: 'peak_ctx' }),
    byWeightedAsc: q.sessions({ sort: 'weighted', dir: 'asc' }),
    page: q.sessions({ limit: 2, offset: 1 }),
    pastEnd: q.sessions({ limit: 5, offset: 50 }),
    slugA: q.sessions({ slug: SLUG_A }),
    slugNone: q.sessions({ slug: 'C--no-such-project' }),
  };
  out.context = {
    s1: q.context({ sessionId: S1 }),
    s2: q.context({ sessionId: S2 }),
    s3: q.context({ sessionId: S3 }),
    s4: q.context({ sessionId: S4 }),
    s5: q.context({ sessionId: S5 }),
    nobody: q.context({ sessionId: NOBODY }),
  };
  out.depCalls = depCalls;

  const badCalls = {
    'summary string': () => q.summary('x'),
    'summary array': () => q.summary([]),
    'summary from short': () => q.summary({ from: '2026-1-1' }),
    'summary from impossible': () => q.summary({ from: '2026-02-30' }),
    'summary to number': () => q.summary({ to: 20261003 }),
    'summary from after to': () => q.summary({ from: '2026-10-03', to: '2026-10-01' }),
    'summary too long': () => q.summary({ from: '2000-01-01', to: '2026-10-03' }),
    'models from number': () => q.models({ from: 5 }),
    'models to junk': () => q.models({ to: "2026-10-03'; DROP TABLE responses; --" }),
    'daily topN 0': () => q.daily({ topN: 0 }),
    'daily topN 13': () => q.daily({ topN: 13 }),
    'daily topN 2.5': () => q.daily({ topN: 2.5 }),
    'daily topN string': () => q.daily({ topN: '6' }),
    'sessions sort sql': () => q.sessions({ sort: 'input; DROP TABLE responses' }),
    'sessions sort proto': () => q.sessions({ sort: 'constructor' }),
    'sessions limit 0': () => q.sessions({ limit: 0 }),
    'sessions limit 2001': () => q.sessions({ limit: 2001 }),
    'sessions limit 1.5': () => q.sessions({ limit: 1.5 }),
    'sessions offset -1': () => q.sessions({ offset: -1 }),
    'sessions slug empty': () => q.sessions({ slug: '' }),
    'sessions slug number': () => q.sessions({ slug: 7 }),
    'sessions dir': () => q.sessions({ dir: 'up' }),
    'context none': () => q.context(),
    'context empty': () => q.context({}),
    'context traversal': () => q.context({ sessionId: '../../x' }),
    'context number': () => q.context({ sessionId: 5 }),
    'context string': () => q.context('abc'),
  };
  out.bad = {};
  for (const name of Object.keys(badCalls)) {
    try {
      out.bad[name] = badCalls[name]();
    } catch (err) {
      out.bad[name] = { threw: String(err && err.message) };
    }
  }
  out.rowsAfterBadCalls = db.prepare('SELECT COUNT(*) AS n FROM responses').get().n;
  db.close();

  // An empty store: every aggregate must come back as 0, not NULL.
  const emptyFile = path.join(t.dir, 'empty.db');
  let empty = new t.Database(emptyFile);
  store.createSchema(empty);
  empty.close();
  empty = new t.Database(emptyFile, { readonly: true });
  const eq = createQueries(empty, { localDay: store.localDay, dayList: store.dayList, now: deps.now, ctxDir: dirs.ctxDir, handoffsDir: dirs.handoffsDir });
  out.emptyDb = {
    summary: eq.summary(),
    models: eq.models(),
    daily: eq.daily(),
    sessions: eq.sessions(),
    context: eq.context({ sessionId: NOBODY }),
  };
  empty.close();

  fs.writeFileSync(path.join(t.dir, 'result.json'), JSON.stringify(out));
}

// --------------------------------------------------------------- parent ----

function runParent() {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { spawnSync } = require('child_process');
  // Under plain node, require('electron') returns the path to the binary.
  const electronBin = require('electron');

  function runChildProcess(mode, tz) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-token-queries-'));
    try {
      // TZ goes in the child's environment, never a shell prefix (design 7.1).
      const r = spawnSync(electronBin, [__filename], {
        cwd: APP_DIR,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir, TQ_CHILD: mode, TZ: tz },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(r.status, 0, 'child (' + mode + ', ' + tz + ') failed:\n' + r.stderr + '\n' + r.stdout);
      return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // One child for the whole seeded scenario; the tests below read its result.
  let main = null;
  let mainError = null;
  try {
    main = runChildProcess('main', 'America/Los_Angeles');
  } catch (err) {
    mainError = err;
  }
  function M() {
    if (mainError) throw mainError;
    return main;
  }

  // The parent's own arithmetic. Ratios from design 5.1 / 5.2 (lines 775-779,
  // 805-814), written out here so a wrong table or a wrong formula in the
  // module shows up as a difference.
  const READ = { 'claude-opus-5-5': 0.05, 'claude-fable-5-1': 0.025 };
  const BASE_USD = { 'claude-opus-5-5': 4, 'claude-fable-5-1': 10, 'claude-haiku-4-5': 1, 'claude-sonnet-5': 2 };
  const KEYS = ['input', 'output', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'cache_read'];
  const normModel = (id) => id.replace(/-\d{8}$/, '');
  const weightedOf = (r) => r.input + 5 * r.output + 1.25 * r.cache_write_5m + 2 * r.cache_write_1h
    + (READ[normModel(r.model)] === undefined ? 0.1 : READ[normModel(r.model)]) * r.cache_read;

  function naive(rows) {
    const acc = { input: 0, output: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, responses: 0, unfinalized: 0, weighted: 0, usd: 0 };
    for (const r of rows) {
      for (const k of KEYS) acc[k] += r[k];
      acc.responses += 1;
      if (!r.finalized) acc.unfinalized += 1;
      const w = weightedOf(r);
      acc.weighted += w;
      const base = BASE_USD[normModel(r.model)];
      if (base !== undefined) acc.usd += w * base / 1e6;
    }
    return acc;
  }
  const inRange = (range) => (r) => r.local_day >= range.from && r.local_day <= range.to;
  const sumOf = (list, pick) => list.reduce((n, item) => n + pick(item), 0);
  const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || 'near') + ': ' + a + ' vs ' + b + ' (tolerance ' + tol + ')');
  const sessionCounter = (row, k) => row.main[k] + row.subagents[k] + row.workflow[k];

  const DEFAULT_RANGE = { from: '2026-09-04', to: '2026-10-03' };
  const RANGES = {
    def: DEFAULT_RANGE,
    all: { from: '2026-01-01', to: '2026-12-31' },
    before: { from: '2026-01-01', to: '2026-09-03' },
    after: { from: '2026-10-04', to: '2026-12-31' },
  };

  test('the seeded child ran under America/Los_Angeles against a read-only handle', () => {
    const m = M();
    assert.equal(m.tz, 'America/Los_Angeles');
    assert.equal(m.readonly, true);
    assert.equal(m.seed.length, 5021);
  });

  test('default range is the last 30 local days, and {} / null / undefined agree', () => {
    const m = M();
    assert.deepEqual(m.summary.def.range, DEFAULT_RANGE);
    assert.deepEqual(m.summary.empty, m.summary.def);
    assert.deepEqual(m.summary.nul, m.summary.def);
    assert.deepEqual(m.models.def.range, DEFAULT_RANGE);
    assert.deepEqual(m.daily.def.range, DEFAULT_RANGE);
    assert.deepEqual(m.sessions.def.range, DEFAULT_RANGE);
    for (const view of ['summary', 'models', 'daily', 'sessions']) {
      assert.equal('scan' in m[view].def, false, view + ' must not carry scan: the store adds it');
    }
  });

  // The money test, both directions: whichever way the rows are grouped, every
  // counter adds up to the same total, and that total is what a plain loop over
  // the seed rows gives. More would be double counting; less would be dropping.
  for (const name of ['def', 'all', 'before', 'after']) {
    test('sessions = models = days = summary = seed rows, every counter (' + name + ')', () => {
      const m = M();
      const range = RANGES[name];
      const expected = naive(m.seed.filter(inRange(range)));
      const s = m.summary[name];
      const mo = m.models[name];
      const se = m.sessions[name];
      assert.equal(se.total, se.rows.length, 'the sessions reply holds every session of the range');
      for (const k of KEYS) {
        assert.equal(s.totals[k], expected[k], 'summary ' + k);
        assert.equal(sumOf(mo.models, (x) => x[k]), expected[k], 'models ' + k);
        assert.equal(sumOf(se.rows, (x) => sessionCounter(x, k)), expected[k], 'sessions ' + k);
        assert.equal(sumOf(KINDSUM(s.byKind), (x) => x[k]), expected[k], 'byKind ' + k);
      }
      for (const k of ['responses', 'unfinalized']) {
        assert.equal(s.totals[k], expected[k], 'summary ' + k);
        assert.equal(sumOf(mo.models, (x) => x[k]), expected[k], 'models ' + k);
        assert.equal(sumOf(se.rows, (x) => sessionCounter(x, k)), expected[k], 'sessions ' + k);
      }
      assert.equal(sumOf(se.rows, (x) => x.unfinalized), expected.unfinalized, 'sessions unfinalized (row total)');
      for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
        assert.equal(mo.byType[k], expected[k], 'byType ' + k);
      }
      // Weighted is rounded to a whole token where it is returned: half a
      // token per addend at most.
      near(s.weighted.tokens, expected.weighted, 0.5, 'summary weighted');
      near(sumOf(mo.models, (x) => x.weighted), expected.weighted, mo.models.length, 'models weighted');
      near(sumOf(se.rows, (x) => x.weighted), expected.weighted, se.rows.length, 'sessions weighted');
      near(sumOf(se.rows, (x) => x.main.weighted + x.subagents.weighted + x.workflow.weighted), expected.weighted, 3 * se.rows.length, 'sessions weighted by kind');
      near(sumOf(KINDSUM(s.byKind), (x) => x.weighted), expected.weighted, 3, 'byKind weighted');
      assert.deepEqual(mo.weighted, s.weighted, 'the models reply carries the same weighted block');
    });
  }

  function KINDSUM(byKind) {
    return [byKind.main, byKind.subagent, byKind.workflow];
  }

  for (const name of ['def', 'all']) {
    test('days add up to the summary and each day adds up across its projects (' + name + ')', () => {
      const m = M();
      const range = RANGES[name];
      const expected = naive(m.seed.filter(inRange(range)));
      const d = name === 'def' ? m.daily.def : m.daily.all;
      for (const k of KEYS.concat(['responses', 'unfinalized'])) {
        assert.equal(sumOf(d.days, (x) => x.total[k]), expected[k], 'days ' + k);
        assert.equal(sumOf(d.projects, (x) => x[k]) + d.other[k], expected[k], 'projects + other ' + k);
      }
      near(sumOf(d.days, (x) => x.total.weighted), expected.weighted, d.days.length, 'days weighted');
      near(sumOf(d.projects, (x) => x.weighted) + d.other.weighted, expected.weighted, d.projects.length + 1, 'projects weighted');
      for (const day of d.days) {
        const parts = Object.values(day.bySlug);
        for (const k of KEYS) assert.equal(sumOf(parts, (x) => x[k]), day.total[k], day.day + ' ' + k);
        // And against the seed, day by day.
        const rows = m.seed.filter((r) => r.local_day === day.day);
        for (const k of KEYS) assert.equal(day.total[k], naive(rows)[k], day.day + ' vs seed ' + k);
      }
    });
  }

  test('range boundary: a row is in exactly one of before / default / after', () => {
    const m = M();
    const byId = Object.fromEntries(m.seed.filter((r) => r.session_id === S4).map((r) => [r.message_id, r]));
    assert.equal(byId.b0.local_day, '2026-09-03');
    assert.equal(byId.b1.local_day, '2026-09-04');
    assert.equal(byId.b2.local_day, '2026-10-03', 'design 7.3: 2026-10-04T03:30Z is 2026-10-03 in Los Angeles');
    assert.equal(byId.b3.local_day, '2026-10-04');
    for (const k of KEYS.concat(['responses'])) {
      assert.equal(m.summary.before.totals[k] + m.summary.def.totals[k] + m.summary.after.totals[k], m.summary.all.totals[k], k);
    }
    const s4 = m.sessions.def.rows.find((r) => r.sessionId === S4);
    assert.equal(s4.main.input, 15 + 25, 'only b1 and b2 are inside the default range');
    assert.equal(s4.main.responses, 2);
    assert.equal(s4.firstTs, Date.parse('2026-09-04T07:00:00Z'));
    assert.equal(s4.lastTs, Date.parse(TZ_ROW_ISO));
    assert.equal(m.sessions.after.rows.length, 1);
    assert.equal(m.sessions.after.rows[0].main.input, 2000000);
    // The file is marked missing in `files`; its rows count all the same.
    assert.equal(m.sessions.all.rows.find((r) => r.sessionId === S4).main.responses, 4);
  });

  test('copied history is counted once, on the original session', () => {
    const m = M();
    const s1 = m.sessions.def.rows.find((r) => r.sessionId === S1);
    const s2 = m.sessions.def.rows.find((r) => r.sessionId === S2);
    assert.equal(s1.main.responses, 4, 'm1-m4');
    assert.equal(s1.main.input, 100 + 10 + 5 + 7);
    assert.equal(s2.main.responses, 2, 'n1 and n2 only: the copied m1-m3 are not S2\'s');
    assert.equal(s2.main.input, 3 + 4);
    assert.equal(s2.main.cache_read, 9500 + 9600);
    assert.equal(s2.subagents.responses, 0);
    assert.equal(s2.workflow.responses, 0);
  });

  test('summary: byKind, unfinalised count, weighted, USD lower bound and the unpriced model', () => {
    const m = M();
    const s = m.summary.def;
    const rows = m.seed.filter(inRange(DEFAULT_RANGE));
    for (const kind of ['main', 'subagent', 'workflow']) {
      const expected = naive(rows.filter((r) => r.kind === kind));
      for (const k of KEYS.concat(['responses', 'unfinalized'])) assert.equal(s.byKind[kind][k], expected[k], kind + ' ' + k);
      near(s.byKind[kind].weighted, expected.weighted, 0.5, kind + ' weighted');
    }
    assert.equal(s.byKind.subagent.responses, 3);
    assert.equal(s.byKind.workflow.responses, 3);
    assert.equal(s.totals.unfinalized, 1, 'f2 never got a stop_reason and is still counted');
    assert.deepEqual(s.weighted.unpricedModels, ['mystery-model-9']);
    assert.equal(s.weighted.pricesVersion, '2026-09-25');
    near(s.weighted.usd, naive(rows).usd, 0.0001, 'usd counts the priced models only');
    assert.equal(Number.isInteger(s.weighted.tokens), true);
  });

  test('models: alias and dated id are one row, sorted by weighted, shares sum to 1', () => {
    const m = M();
    const list = m.models.def.models;
    const rows = m.seed.filter(inRange(DEFAULT_RANGE));
    assert.deepEqual(list.map((x) => x.model).sort(), ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5', 'mystery-model-9']);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].weighted >= list[i].weighted, 'sorted by weighted, descending');
    near(sumOf(list, (x) => x.share), 1, 1e-9, 'shares');
    for (const row of list) {
      const expected = naive(rows.filter((r) => normModel(r.model) === row.model));
      for (const k of KEYS.concat(['responses', 'unfinalized'])) assert.equal(row[k], expected[k], row.model + ' ' + k);
      near(row.weighted, expected.weighted, 0.5, row.model + ' weighted');
    }
    const haiku = list.find((x) => x.model === 'claude-haiku-4-5');
    assert.equal(haiku.responses, 3);
    assert.equal(haiku.label, 'Haiku 4.5');
    near(haiku.usd, haiku.weighted * 1 / 1e6, 1e-4, 'haiku usd');
    const opus = list.find((x) => x.model === 'claude-opus-5-5');
    assert.equal(opus.label, 'Opus 5.5');
    assert.equal(opus.thinking, 27, 'thinking is summed, NULL counting as 0');
    assert.equal(opus.priced, true);
    const mystery = list.find((x) => x.model === 'mystery-model-9');
    assert.equal(mystery.usd, null);
    assert.equal(mystery.priced, false);
    assert.equal(mystery.label, 'mystery-model-9');
    // Unknown model: the model-independent ratios, cache read at 0.1.
    assert.equal(mystery.weighted, 100 + 500 + 125 + 100);
    const fable = list.find((x) => x.model === 'claude-fable-5-1');
    assert.equal(fable.unfinalized, 1);
    assert.equal(fable.weighted, Math.round((1000 + 10000 + 6000 + 400000 * 0.025) + (9 + 5 + 403000 * 0.025)));
  });

  test('daily: every day present and zero-filled, top-N folded into __other__', () => {
    const m = M();
    const d = m.daily.top2;
    assert.equal(d.days.length, 30);
    assert.equal(d.days[0].day, '2026-09-04');
    assert.equal(d.days[29].day, '2026-10-03');
    assert.equal(new Set(d.days.map((x) => x.day)).size, 30);
    const quiet = d.days.find((x) => x.day === '2026-09-05');
    assert.deepEqual(quiet.total, { input: 0, output: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, weighted: 0, responses: 0, unfinalized: 0 });
    assert.deepEqual(quiet.bySlug, {});

    assert.deepEqual(d.projects.map((x) => x.slug), [SLUG_B, SLUG_A], 'ranked by weighted over the range');
    assert.equal(d.other.slugs, 3, 'gamma, epsilon and zeta are folded');
    const seen = new Set();
    for (const day of d.days) for (const slug of Object.keys(day.bySlug)) seen.add(slug);
    assert.deepEqual([...seen].sort(), [SLUG_A, SLUG_B, '__other__'].sort());
    const sep15 = d.days.find((x) => x.day === '2026-09-15');
    assert.equal(sep15.bySlug.__other__.input, 3, 'epsilon (1) and zeta (2) share one bucket');
    const oct3 = d.days.find((x) => x.day === '2026-10-03');
    assert.equal(oct3.bySlug.__other__.input, 25, 'the 03:30Z row is on 2026-10-03');

    const alpha = d.projects.find((x) => x.slug === SLUG_A);
    assert.equal(alpha.projectPath, 'C:\\proj\\alpha');
    assert.equal(alpha.label, 'alpha');
    const beta = d.projects.find((x) => x.slug === SLUG_B);
    assert.equal(beta.projectPath, SLUG_B, 'no folder meta: the slug stands in');
    assert.equal(beta.label, SLUG_B);

    // Default topN is 6: five projects in range, nothing folded.
    assert.equal(m.daily.def.projects.length, 5);
    assert.equal(m.daily.def.other.slugs, 0);
    assert.equal(m.daily.def.other.weighted, 0);
    const gamma = m.daily.def.projects.find((x) => x.slug === SLUG_C);
    assert.equal(gamma.projectPath, SLUG_C, 'a folderMeta that throws falls back to the slug');
  });

  test('daily: colorIndex is unique in a reply and does not move with the range or topN', () => {
    const m = M();
    for (const d of [m.daily.def, m.daily.top2, m.daily.all, m.daily.top12all]) {
      const idx = d.projects.map((x) => x.colorIndex);
      assert.equal(new Set(idx).size, idx.length, 'unique');
      for (const i of idx) assert.ok(Number.isInteger(i) && i >= 0 && i < 8, 'inside the 8 colour palette');
    }
    const colorOf = (d, slug) => d.projects.find((x) => x.slug === slug).colorIndex;
    // Delta outranks everything in the all-time range, so the ranks differ
    // between these replies while each project keeps its slot.
    assert.notDeepEqual(m.daily.all.projects.map((x) => x.slug), m.daily.def.projects.map((x) => x.slug));
    const { assignColors } = require('../token-usage-queries');
    for (const slug of [SLUG_A, SLUG_B]) {
      assert.equal(colorOf(m.daily.top2, slug), colorOf(m.daily.def, slug), slug);
    }
    // The slot comes from the slug alone unless a higher-ranked project of the
    // same reply already holds it.
    const alone = (slug) => assignColors([slug]).get(slug);
    assert.equal(colorOf(m.daily.top2, SLUG_B), alone(SLUG_B));
    const ranked = [SLUG_A, SLUG_B, SLUG_C, SLUG_D, SLUG_E, SLUG_F];
    const colors = assignColors(ranked);
    assert.equal(new Set(colors.values()).size, 6);
    assert.equal(assignColors(Array.from({ length: 12 }, (_, i) => 'p' + i)).size, 12);
    assert.equal(new Set(assignColors(Array.from({ length: 12 }, (_, i) => 'p' + i)).values()).size, 12);
  });

  test('daily: a range across the 2026-11-01 DST change has five distinct days', () => {
    const m = M();
    assert.deepEqual(m.daily.dst.days.map((x) => x.day), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });

  test('sessions: main / subagents / workflow, agents, peak context, compactions, display fields', () => {
    const m = M();
    const rows = m.sessions.def.rows;
    assert.equal(m.sessions.def.total, 6, 'S1, S2, S3, S4, S6, S7 (S5 is before the range)');
    const s1 = rows.find((r) => r.sessionId === S1);
    assert.equal(s1.slug, SLUG_A);
    assert.equal(s1.title, 'Alpha original');
    assert.equal(s1.projectPath, 'C:\\proj\\alpha');
    assert.equal(s1.isRunning, false);
    assert.equal(s1.subagents.responses, 3);
    assert.equal(s1.subagents.agents, 2, 'a1 and a2');
    assert.equal(s1.subagents.input, 50 + 1 + 11);
    assert.equal(s1.workflow.responses, 3);
    assert.equal(s1.workflow.workflows, 2, 'wf-1 and wf-2');
    assert.equal(s1.workflow.agents, 3, 'x1 in wf-1, x2 in wf-1, x1 in wf-2');
    assert.equal(s1.workflow.output, 21 + 31 + 41);
    assert.equal(s1.peakContext, 7 + 20 + 9000, 'm4: input + cache_write + cache_read, main rows only');
    assert.equal(s1.compactions, 1, 'c1; c2 is before the range');
    assert.equal(s1.unfinalized, 0);
    assert.equal(s1.firstTs, Date.parse('2026-09-10T18:00:00Z'));
    assert.equal(s1.lastTs, Date.parse('2026-09-20T18:00:00Z'));
    assert.deepEqual(s1.models.slice().sort(), ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5']);
    assert.equal(s1.models[0], 'claude-opus-5-5', 'models are listed by weight');
    near(s1.weighted, naive(m.seed.filter((r) => r.session_id === S1)).weighted, 0.5, 'S1 weighted');
    // All of S1, compaction c2 included, in the all-time range.
    assert.equal(m.sessions.all.rows.find((r) => r.sessionId === S1).compactions, 2);

    const s2 = rows.find((r) => r.sessionId === S2);
    assert.equal(s2.isRunning, true);
    assert.equal(s2.title, null);
    assert.equal(s2.peakContext, 4 + 0 + 9600);
    assert.equal(s2.compactions, 0);

    const s3 = rows.find((r) => r.sessionId === S3);
    assert.equal(s3.title, null, 'a sessionInfo that throws gives no title, not an error');
    assert.equal(s3.projectPath, SLUG_B);
    assert.equal(s3.unfinalized, 1);
    assert.equal(s3.compactions, 1);
    assert.equal(s3.peakContext, 1000 + 3000 + 400000);
    assert.deepEqual(s3.models, ['claude-fable-5-1', 'mystery-model-9']);

    const s4 = rows.find((r) => r.sessionId === S4);
    assert.equal(s4.projectPath, SLUG_C);
    assert.equal(s4.compactions, 1, 'c4 (03:40Z, 2026-10-03 local) is in range, c5 (2026-10-04 local) is not');
    for (const r of rows) assert.equal('scan' in r, false);
  });

  test('sessions: sort allowlist, direction, limit, offset, total, slug filter', () => {
    const m = M();
    const desc = (list, key) => {
      for (let i = 1; i < list.length; i++) assert.ok(key(list[i - 1]) >= key(list[i]), 'descending at ' + i);
    };
    desc(m.sessions.def.rows, (r) => r.weighted);
    assert.equal(m.sessions.def.rows[0].sessionId, S3);
    desc(m.sessions.byLastTs.rows, (r) => r.lastTs);
    assert.equal(m.sessions.byLastTs.rows[0].sessionId, S4);
    desc(m.sessions.byOutput.rows, (r) => r.main.output + r.subagents.output + r.workflow.output);
    desc(m.sessions.byCacheRead.rows, (r) => r.main.cache_read + r.subagents.cache_read + r.workflow.cache_read);
    desc(m.sessions.byPeak.rows, (r) => r.peakContext);
    assert.equal(m.sessions.byPeak.rows[0].sessionId, S3);
    assert.deepEqual(m.sessions.byWeightedAsc.rows.map((r) => r.sessionId), m.sessions.def.rows.map((r) => r.sessionId).reverse());

    assert.equal(m.sessions.page.total, 6, 'total is the count before paging');
    assert.deepEqual(m.sessions.page.rows.map((r) => r.sessionId), m.sessions.def.rows.slice(1, 3).map((r) => r.sessionId));
    assert.equal(m.sessions.pastEnd.total, 6);
    assert.deepEqual(m.sessions.pastEnd.rows, []);

    assert.equal(m.sessions.slugA.total, 2);
    assert.deepEqual(m.sessions.slugA.rows.map((r) => r.sessionId).sort(), [S1, S2]);
    assert.equal(m.sessions.slugNone.total, 0);
    assert.deepEqual(m.sessions.slugNone.rows, []);
  });

  test('context: own main responses in time order, compactions, sidecar window', () => {
    const m = M();
    const c = m.context.s1;
    assert.equal(c.sessionId, S1);
    assert.equal(c.slug, SLUG_A);
    assert.equal(c.title, 'Alpha original');
    assert.equal(c.model, 'claude-opus-5-5');
    assert.deepEqual(c.points.map((p) => p.mid), ['m1', 'm2', 'm3', 'm4'], 'main rows only, by ts_ms');
    assert.deepEqual(c.points.map((p) => p.ctx), [100 + 1000 + 5000, 10 + 6100, 5 + 300 + 6400, 7 + 20 + 9000]);
    assert.deepEqual(c.points.map((p) => p.out), [200, 50, 500, 70]);
    assert.deepEqual(c.points.map((p) => p.fin), [1, 1, 1, 1]);
    assert.equal(c.points[0].t, Date.parse('2026-09-10T18:00:00Z'));
    assert.equal(c.downsampled, false);
    assert.equal(c.totalPoints, 4);
    assert.deepEqual(c.compactions, [
      { t: Date.parse('2026-08-01T00:00:00Z'), trigger: 'manual', pre: 5000, post: 400 },
      { t: Date.parse('2026-09-10T19:00:00Z'), trigger: 'auto', pre: 6705, post: 800 },
    ]);
    assert.equal(c.contextWindow, 500000, 'the sidecar wins');
    assert.equal(c.contextWindowSource, 'sidecar');
    assert.equal('scan' in c, false);
  });

  test('context: a resumed session charts its own responses only', () => {
    const m = M();
    const c = m.context.s2;
    assert.deepEqual(c.points.map((p) => p.mid), ['n1', 'n2']);
    assert.equal(c.contextWindow, 1000000, 'no sidecar: opus family');
    assert.equal(c.contextWindowSource, 'model');
    assert.deepEqual(c.compactions, []);
    assert.deepEqual(c.handoffs, [{ t: 1790100000000, tokens: 9700, path: 'C:/x/h2.md', consumedBy: null }]);
  });

  test('context: handoffs from the state file and latest/<slug>.json, seconds, ms and ISO', () => {
    const m = M();
    assert.deepEqual(m.context.s1.handoffs, [
      { t: 1789000000000, tokens: 6000, path: 'C:/x/hm.md', consumedBy: null },                          // ms
      { t: Date.parse('2026-09-15T12:00:00.000Z'), tokens: 7000, path: 'C:/x/h0.md', consumedBy: null }, // ISO
      { t: 1790000000500, tokens: 9027, path: 'C:/x/h1.md', consumedBy: S2 },                            // seconds; both files, one mark
    ]);
  });

  test('context: missing or unreadable hook files are an empty list, never an error', () => {
    const m = M();
    assert.equal(m.context.s3.error, undefined);
    assert.deepEqual(m.context.s3.handoffs, [], 'the state file is not JSON and there is no latest file');
    assert.equal(m.context.s3.model, 'mystery-model-9', 'the last response\'s model');
    assert.equal(m.context.s3.contextWindow, 200000);
    assert.equal(m.context.s3.contextWindowSource, 'default');
    assert.deepEqual(m.context.s3.points.map((p) => p.fin), [1, 0, 1]);
    assert.deepEqual(m.context.s3.compactions, [{ t: Date.parse('2026-10-01T18:00:30Z'), trigger: 'auto', pre: 404000, post: 30000 }]);
    assert.deepEqual(m.context.s4.handoffs, [], 'no files at all');
    assert.equal(m.context.s4.points.length, 4, 'the chart is not ranged');
    assert.deepEqual(m.context.s4.compactions[0], { t: Date.parse('2026-10-04T03:40:00Z'), trigger: 'auto', pre: null, post: null });

    const n = m.context.nobody;
    assert.equal(n.error, undefined);
    assert.deepEqual(n.points, []);
    assert.deepEqual(n.compactions, []);
    assert.deepEqual(n.handoffs, []);
    assert.equal(n.slug, null);
    assert.equal(n.model, null);
    assert.equal(n.downsampled, false);
  });

  test('context: 5,000 responses come back as at most 2,000 points with the peak and the last point kept', () => {
    const m = M();
    const c = m.context.s5;
    assert.equal(c.downsampled, true);
    assert.equal(c.totalPoints, 5000);
    assert.ok(c.points.length <= 2000, 'points: ' + c.points.length);
    assert.ok(c.points.length >= 1900, 'a falling run keeps its first (largest) and its last point: ' + c.points.length);
    for (let i = 1; i < c.points.length; i++) assert.ok(c.points[i - 1].t < c.points[i].t, 'time order at ' + i);
    assert.equal(Math.max(...c.points.map((p) => p.ctx)), 1 + 999999, 'the global peak survives');
    assert.equal(c.points[c.points.length - 1].mid, 'big4999', 'the last response survives');
    assert.equal(c.points[0].mid.startsWith('big'), true);
    // Every sawtooth top (i % 700 === 0) is the largest of its run of five.
    const mids = new Set(c.points.map((p) => p.mid));
    for (const i of [0, 700, 1400, 2100, 2800, 3500, 4200, 4900]) assert.ok(mids.has('big' + String(i).padStart(4, '0')), 'peak ' + i);
  });

  test('bad arguments return { error: "bad request: ..." } and never throw', () => {
    const m = M();
    const names = Object.keys(m.bad);
    assert.equal(names.length, 27);
    for (const name of names) {
      const r = m.bad[name];
      assert.equal(r.threw, undefined, name + ' threw: ' + r.threw);
      assert.equal(typeof r.error, 'string', name + ' should be refused, got ' + JSON.stringify(r).slice(0, 200));
      assert.match(r.error, /^bad request: /, name);
      assert.deepEqual(Object.keys(r), ['error'], name);
    }
    assert.equal(m.rowsAfterBadCalls, 5021);
  });

  test('display lookups run for the returned page only', () => {
    const m = M();
    // 13 sessions calls in the child; none returns more than 7 rows, and the
    // context calls add one sessionInfo each. A lookup per session per call on
    // an unpaged list would be far above this.
    assert.ok(m.depCalls.sessionInfo <= 13 * 7 + 6, 'sessionInfo calls: ' + m.depCalls.sessionInfo);
    assert.ok(m.depCalls.isRunning <= 13 * 7, 'isRunning calls: ' + m.depCalls.isRunning);
    assert.equal(m.sessions.page.rows.length, 2);
  });

  test('an empty store gives zeros, not NULL, and thirty empty days', () => {
    const e = M().emptyDb;
    assert.deepEqual(e.summary.totals, { input: 0, output: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, responses: 0, unfinalized: 0 });
    assert.equal(e.summary.byKind.main.input, 0);
    assert.equal(e.summary.byKind.workflow.weighted, 0);
    assert.deepEqual(e.summary.weighted, { tokens: 0, usd: 0, unpricedModels: [], pricesVersion: '2026-09-25' });
    assert.deepEqual(e.models.models, []);
    assert.deepEqual(e.models.byType, { input: 0, output: 0, cache_write: 0, cache_read: 0 });
    assert.equal(e.daily.days.length, 30);
    assert.equal(sumOf(e.daily.days, (d) => d.total.weighted + d.total.input), 0);
    assert.deepEqual(e.daily.projects, []);
    assert.equal(e.daily.other.weighted, 0);
    assert.deepEqual(e.sessions, { range: DEFAULT_RANGE, total: 0, rows: [] });
    assert.deepEqual(e.context.points, []);
  });

  // Design 7.3: the same instant lands on a different local day by zone.
  for (const [tz, day] of [['America/Los_Angeles', '2026-10-03'], ['Pacific/Auckland', '2026-10-04'], ['UTC', '2026-10-04']]) {
    test('a row at 2026-10-04T03:30Z is on ' + day + ' under TZ=' + tz, () => {
      const r = runChildProcess('tz', tz);
      assert.equal(r.tz, tz);
      assert.equal(r.localDay, day);
      const other = day === '2026-10-03' ? 'on04' : 'on03';
      const same = day === '2026-10-03' ? 'on03' : 'on04';
      assert.equal(r[same].totals.input, 25);
      assert.equal(r[same].totals.responses, 1);
      assert.equal(r[other].totals.input, 0);
      assert.equal(r[other].totals.responses, 0);
      assert.deepEqual(r.daily.days.map((d) => [d.day, d.total.input]), day === '2026-10-03'
        ? [['2026-10-03', 25], ['2026-10-04', 0]]
        : [['2026-10-03', 0], ['2026-10-04', 25]]);
    });
  }

  // ---- plain Node: no database needed ----

  test('argument checks need no database, and a failing database is an error value, not a throw', () => {
    const { createQueries } = require('../token-usage-queries');
    const broken = { prepare() { throw new Error('database is closed'); } };
    const q = createQueries(broken, { now: () => Date.parse(NOW_ISO) });
    assert.match(q.summary({ from: 'yesterday' }).error, /^bad request: /);
    assert.match(q.context({ sessionId: 'nope' }).error, /^bad request: /);
    for (const name of ['summary', 'models', 'daily', 'sessions']) {
      const r = q[name]({ from: '2026-10-01', to: '2026-10-03' });
      assert.match(r.error, /^query failed: database is closed$/, name);
    }
    assert.match(q.context({ sessionId: S1 }).error, /^query failed: /);
    // No deps at all, and no db at all: still values, never a throw.
    const bare = createQueries(null);
    assert.equal(typeof bare.summary().error, 'string');
    assert.equal(typeof createQueries(undefined, 'junk').sessions({}).error, 'string');
  });

  test('downsamplePoints keeps each run\'s largest ctx and its last point', () => {
    const { downsamplePoints } = require('../token-usage-queries');
    const few = [{ ctx: 1 }, { ctx: 2 }];
    assert.deepEqual(downsamplePoints(few, 2000), { points: few, downsampled: false });
    const pts = Array.from({ length: 10 }, (_, i) => ({ i, ctx: [5, 9, 1, 2, 3, 3, 7, 8, 4, 6][i] }));
    const r = downsamplePoints(pts, 4); // two runs of five, two points each at most
    assert.equal(r.downsampled, true);
    assert.deepEqual(r.points.map((p) => p.i), [1, 4, 7, 9]);
    // The largest is also the last: one point for that run.
    const one = downsamplePoints([{ ctx: 1 }, { ctx: 2 }, { ctx: 3 }, { ctx: 1 }, { ctx: 1 }, { ctx: 9 }], 2);
    assert.deepEqual(one.points.map((p) => p.ctx), [9]);
    for (const n of [2001, 2500, 3999, 4000, 4001, 100000]) {
      const many = Array.from({ length: n }, (_, i) => ({ i, ctx: (i * 7919) % 1000 }));
      const out = downsamplePoints(many, 2000).points;
      assert.ok(out.length <= 2000, n + ' -> ' + out.length);
      assert.equal(out[out.length - 1].i, n - 1);
    }
  });

  test('writtenAtMs accepts seconds, milliseconds and ISO, and nothing else', () => {
    const { writtenAtMs } = require('../token-usage-queries');
    assert.equal(writtenAtMs(1791064773.515925), 1791064773516);
    assert.equal(writtenAtMs(1791064773516), 1791064773516);
    assert.equal(writtenAtMs('2026-10-03T19:14:46.014Z'), Date.parse('2026-10-03T19:14:46.014Z'));
    for (const v of [null, undefined, '', 'soon', 0, -5, NaN, Infinity, {}, [], true]) {
      assert.equal(writtenAtMs(v), null, String(v));
    }
  });

  test('model label and context window by model family', () => {
    const { modelLabel, contextWindowFor, dayNumber } = require('../token-usage-queries');
    assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
    assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
    assert.equal(modelLabel('unknown'), 'unknown');
    assert.equal(modelLabel(''), 'unknown');
    assert.deepEqual(contextWindowFor('claude-opus-5-5'), { size: 1000000, source: 'model' });
    assert.deepEqual(contextWindowFor('claude-sonnet-5'), { size: 1000000, source: 'model' });
    assert.deepEqual(contextWindowFor('claude-fable-5-1'), { size: 1000000, source: 'model' });
    assert.deepEqual(contextWindowFor('claude-haiku-4-5'), { size: 200000, source: 'model' });
    assert.deepEqual(contextWindowFor(null), { size: 200000, source: 'default' });
    assert.equal(dayNumber('1970-01-02'), 1);
    assert.equal(dayNumber('2026-02-29'), null);
    assert.equal(dayNumber('2028-02-29') - dayNumber('2028-02-28'), 1);
    assert.equal(dayNumber('2026-11-02') - dayNumber('2026-10-31'), 2, 'no DST in day arithmetic');
  });

  test('prices are injectable and read at query time', () => {
    const { createQueries } = require('../token-usage-queries');
    const rows = [{ kind: 'main', model: 'm', input: 10, output: 1, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, thinking: null, responses: 1, unfinalized: 0 }];
    const db = { prepare: () => ({ all: () => rows }) };
    let version = 'v1';
    let outputRatio = 5;
    const prices = {
      loadPriceTable: () => ({ version }),
      normalizeModel: (id) => id,
      weightsFor: () => ({ input: 1, output: outputRatio, write5m: 1.25, write1h: 2, read: 0.1, baseUsd: 2, priced: true }),
      weightedTokens: (r, w) => r.input * w.input + r.output * w.output,
      estimateUsd: (weighted, w) => weighted * w.baseUsd / 1e6,
    };
    const q = createQueries(db, { prices, now: () => Date.parse(NOW_ISO) });
    const a = q.summary({ from: '2026-10-01', to: '2026-10-03' });
    assert.equal(a.weighted.tokens, 15);
    assert.equal(a.weighted.pricesVersion, 'v1');
    version = 'v2';
    outputRatio = 10;
    const b = q.summary({ from: '2026-10-01', to: '2026-10-03' });
    assert.equal(b.weighted.tokens, 20, 'a price edit shows at the next query');
    assert.equal(b.weighted.pricesVersion, 'v2');
  });
}
