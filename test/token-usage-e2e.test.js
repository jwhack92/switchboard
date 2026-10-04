'use strict';
// The token pipeline end to end: the REAL worker thread, parser, store and
// queries together, over a transcript tree this test builds in a temp dir.
// Every other token test replaces at least one of those with a stub.
//
// better-sqlite3 is built for Electron's ABI, so each scenario runs in a child:
// this same file, started with the Electron binary as Node and
// TU_E2E_SCENARIO naming the scenario. The child gathers facts and writes them
// to result.json; the parent half (plain `node --test`) asserts on them.
//
// Build contract rule 5: the real ~/.switchboard is never opened. The child
// gets an explicit temp dataDir AND SWITCHBOARD_DATA_DIR naming the same
// folder, refuses to run unless that folder is under os.tmpdir(), and checks
// the file the store actually opened. The context query is given temp ctx and
// handoff folders, so the real hook folders are not read either.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const STORE = path.join(APP_DIR, 'token-usage.js');
const PARSER = path.join(APP_DIR, 'token-usage-parse.js');
const WORKER = path.join(APP_DIR, 'workers', 'scan-tokens.js');

const SLUG = 'C--e2e-project';
const SID_O = '11111111-1111-4111-8111-111111111111';   // the original session
const SID_C = '22222222-2222-4222-8222-222222222222';   // its continuation
const SID_D = '33333333-3333-4333-8333-333333333333';
const SID_E = '44444444-4444-4444-8444-444444444444';
const REL_O = `${SLUG}/${SID_O}.jsonl`;
const REL_C = `${SLUG}/${SID_C}.jsonl`;
const REL_S = `${SLUG}/${SID_O}/subagents/agent-a1.jsonl`;
const REL_W = `${SLUG}/${SID_O}/subagents/workflows/wf-001/agent-w1.jsonl`;
const REL_J = `${SLUG}/${SID_O}/subagents/workflows/wf-001/journal.jsonl`;   // not a transcript
const BOUNDARY = 'aaaaaaaa-0000-4000-8000-000000000001';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const HAIKU_NORM = 'claude-haiku-4-5';

const COUNTERS = ['input', 'output', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'cache_read'];

// ------------------------------------------------------------- the fixture ----
// One definition, used by the child to write the files and by the parent to
// state what the store must hold. Times are seconds after `base`.

function usageLine(base, sid, id, sec, c, stop, extra) {
  const x = extra || {};
  const usage = {
    input_tokens: c[0],
    output_tokens: c[1],
    cache_creation_input_tokens: c[2],
    cache_read_input_tokens: c[3],
  };
  if (x.split) usage.cache_creation = { ephemeral_5m_input_tokens: x.split[0], ephemeral_1h_input_tokens: x.split[1] };
  if (x.iterations) usage.iterations = x.iterations;
  return JSON.stringify({
    type: 'assistant',
    sessionId: sid,
    timestamp: new Date(base + sec * 1000).toISOString(),
    uuid: 'line-' + id + '-' + sec,
    message: { id, role: 'assistant', model: x.model || OPUS, stop_reason: stop || null, usage },
  });
}

function userLine(base, sid, sec, text) {
  return JSON.stringify({
    type: 'user', sessionId: sid, timestamp: new Date(base + sec * 1000).toISOString(),
    message: { role: 'user', content: text },
  });
}

// Built like the real shape: no "usage" bytes anywhere in the line.
function boundaryLine(base, sid, sec) {
  return JSON.stringify({
    type: 'system', subtype: 'compact_boundary', sessionId: sid, uuid: BOUNDARY,
    timestamp: new Date(base + sec * 1000).toISOString(), content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 500000, postTokens: 40000 },
  });
}

// The resume gate hashes the first 4,096 bytes. A file shorter than that gets
// a new head hash with every append and is read again from 0, so every file
// here starts with a line longer than the window: appends must RESUME.
const PAD = ' ' + 'lorem ipsum '.repeat(420);

function fixture(base) {
  const u = (sid, id, sec, c, stop, extra) => usageLine(base, sid, id, sec, c, stop, extra);
  const text = (lines) => lines.join('\n') + '\n';
  return {
    // The original: two finished responses, a compaction, and a third response
    // it only ever holds the streaming placeholder of.
    original: text([
      userLine(base, SID_O, 1, 'first prompt' + PAD),
      u(SID_O, 'msg_o1', 2, [10, 3, 100, 1000], null, { split: [100, 0] }),
      u(SID_O, 'msg_o1', 3, [10, 405, 100, 1000], 'end_turn', { split: [100, 0] }),
      u(SID_O, 'msg_o2', 10, [12, 8, 0, 2000], null),
      u(SID_O, 'msg_o2', 11, [12, 396, 0, 2000], 'tool_use'),
      boundaryLine(base, SID_O, 20),
      u(SID_O, 'msg_o3', 30, [14, 5, 50, 3000], null, { split: [50, 0] }),
      u(SID_O, 'msg_err', 31, [0, 0, 0, 0], 'stop_sequence', { model: '<synthetic>' }),
      u(SID_O, 'msg_zero', 32, [0, 0, 0, 0], 'end_turn'),
    ]),
    // The continuation: the original's history copied with ITS sessionId on
    // every line, the finished line of msg_o3 (which the original lacks), a
    // zeroed copy whose real-looking numbers sit only in usage.iterations, and
    // two responses of its own.
    continuation: text([
      userLine(base, SID_C, 1, 'first prompt' + PAD),
      u(SID_C, 'msg_o1', 3, [10, 405, 100, 1000], 'end_turn', { split: [100, 0] }),
      u(SID_C, 'msg_o2', 11, [12, 396, 0, 2000], 'tool_use'),
      boundaryLine(base, SID_C, 20),
      u(SID_C, 'msg_o3', 30, [14, 5, 50, 3000], null, { split: [50, 0] }),
      u(SID_C, 'msg_o3', 33, [14, 250, 50, 3000], 'end_turn', { split: [50, 0] }),
      u(SID_C, 'msg_o1', 34, [0, 0, 0, 0], 'end_turn', { iterations: [{ input_tokens: 9999, output_tokens: 9999 }] }),
      u(SID_C, 'msg_c1', 100, [20, 6, 10, 4000], null, { split: [10, 0] }),
      u(SID_C, 'msg_c1', 101, [20, 120, 10, 4000], 'end_turn', { split: [10, 0] }),
      // A main line whose own sessionId field is NOT this file's: for a main
      // file the path decides the session, never the line (design 1.5).
      u(SID_O, 'msg_c2', 110, [22, 60, 0, 4100], 'end_turn'),
    ]),
    subagent: text([
      userLine(base, SID_O, 39, 'do the task' + PAD),
      u(SID_O, 'msg_s1', 40, [5, 70, 200, 300], 'end_turn', { model: HAIKU, split: [0, 200] }),
      u(SID_O, 'msg_s2', 41, [6, 30, 0, 500], 'end_turn', { model: HAIKU }),
    ]),
    workflow: text([
      userLine(base, SID_O, 49, 'do the step' + PAD),
      // A split that does not add up to the counter is normalised to 5m = all.
      u(SID_O, 'msg_w1', 50, [7, 90, 300, 600], 'end_turn', { split: [1, 1] }),
      u(SID_O, 'msg_w2', 51, [8, 4, 0, 700], null),
    ]),
    journal: text([u(SID_O, 'msg_journal', 52, [1000, 1000, 1000, 1000], 'end_turn')]),
    appendContinuation: text([
      u(SID_C, 'msg_c3', 200, [30, 2, 0, 5000], null),
      u(SID_C, 'msg_c3', 201, [30, 77, 0, 5000], 'end_turn'),
    ]),
    appendSubagent: text([u(SID_O, 'msg_s3', 210, [9, 15, 0, 900], 'end_turn', { model: HAIKU })]),
    // The original rewritten: another first line (so the head hash moves),
    // msg_o2 and the compaction gone, one new response.
    originalRewritten: text([
      userLine(base, SID_O, 0, 'the file was rewritten' + PAD),
      u(SID_O, 'msg_o1', 3, [10, 405, 100, 1000], 'end_turn', { split: [100, 0] }),
      u(SID_O, 'msg_o3', 30, [14, 5, 50, 3000], null, { split: [50, 0] }),
      u(SID_O, 'msg_o4', 300, [40, 500, 0, 6000], 'end_turn'),
    ]),
  };
}

// What the store must hold, written out by hand from the rules of design
// section 1 (not derived from the code under test).
// [id, kind, session, file, input, output, cache_write, 5m, 1h, cache_read, finalized, sec, model]
function expectedRows(stage) {
  const rows = [
    ['msg_o1', 'main', SID_O, REL_O, 10, 405, 100, 100, 0, 1000, 1, 3, OPUS],
    ['msg_o2', 'main', SID_O, REL_O, 12, 396, 0, 0, 0, 2000, 1, 11, OPUS],
    // Owner: the earlier-born original. Counters: the finished line, which
    // only the continuation holds.
    ['msg_o3', 'main', SID_O, REL_O, 14, 250, 50, 50, 0, 3000, 1, 33, OPUS],
    ['msg_c1', 'main', SID_C, REL_C, 20, 120, 10, 10, 0, 4000, 1, 101, OPUS],
    ['msg_c2', 'main', SID_C, REL_C, 22, 60, 0, 0, 0, 4100, 1, 110, OPUS],
    ['msg_s1', 'subagent', SID_O, REL_S, 5, 70, 200, 0, 200, 300, 1, 40, HAIKU],
    ['msg_s2', 'subagent', SID_O, REL_S, 6, 30, 0, 0, 0, 500, 1, 41, HAIKU],
    ['msg_w1', 'workflow', SID_O, REL_W, 7, 90, 300, 300, 0, 600, 1, 50, OPUS],
    ['msg_w2', 'workflow', SID_O, REL_W, 8, 4, 0, 0, 0, 700, 0, 51, OPUS],
  ];
  if (stage >= 2) {
    rows.push(['msg_c3', 'main', SID_C, REL_C, 30, 77, 0, 0, 0, 5000, 1, 201, OPUS]);
    rows.push(['msg_s3', 'subagent', SID_O, REL_S, 9, 15, 0, 0, 0, 900, 1, 210, HAIKU]);
  }
  if (stage >= 3) {
    // The rewritten original no longer holds msg_o2: it now belongs to the
    // continuation, the only file that still carries it.
    const o2 = rows.find((r) => r[0] === 'msg_o2');
    o2[2] = SID_C;
    o2[3] = REL_C;
    rows.push(['msg_o4', 'main', SID_O, REL_O, 40, 500, 0, 0, 0, 6000, 1, 300, OPUS]);
  }
  return rows.map((r) => ({
    message_id: r[0], kind: r[1], session_id: r[2], file: r[3], input: r[4], output: r[5], cache_write: r[6],
    cache_write_5m: r[7], cache_write_1h: r[8], cache_read: r[9], finalized: r[10], sec: r[11], model: r[12],
  })).sort((a, b) => (a.message_id < b.message_id ? -1 : 1));
}

function expectedSightings(stage) {
  const s = [
    ['msg_o1', REL_O], ['msg_o1', REL_C], ['msg_o2', REL_O], ['msg_o2', REL_C], ['msg_o3', REL_O], ['msg_o3', REL_C],
    ['msg_c1', REL_C], ['msg_c2', REL_C], ['msg_s1', REL_S], ['msg_s2', REL_S], ['msg_w1', REL_W], ['msg_w2', REL_W],
  ];
  if (stage >= 2) s.push(['msg_c3', REL_C], ['msg_s3', REL_S]);
  if (stage >= 3) {
    s.splice(s.findIndex((x) => x[0] === 'msg_o2' && x[1] === REL_O), 1);
    s.push(['msg_o4', REL_O]);
  }
  return s.map((x) => x.join(' @ ')).sort();
}

// ---------------------------------------------------- the agreement fixture ----
// Sightings of shared ids, to be applied in several orders through the
// parser's pure decideUpsert and through the store's SQL upsert.

const T0 = Date.parse('2026-10-03T18:00:00Z');
const AG_FILES = {
  O: { rel: REL_O, kind: 'main', pathSession: SID_O, lineSession: SID_O, agent: null, wf: null, birth: 2000 },
  C: { rel: REL_C, kind: 'main', pathSession: SID_C, lineSession: SID_C, agent: null, wf: null, birth: 3000 },
  // Born before the "original": a restored older file that reaches the scanner late.
  D: { rel: `${SLUG}/${SID_D}.jsonl`, kind: 'main', pathSession: SID_D, lineSession: SID_D, agent: null, wf: null, birth: 1000 },
  // Same floored birth as O.
  E: { rel: `${SLUG}/${SID_E}.jsonl`, kind: 'main', pathSession: SID_E, lineSession: SID_E, agent: null, wf: null, birth: 2000 },
  S1: { rel: REL_S, kind: 'subagent', pathSession: SID_O, lineSession: SID_O, agent: 'agent-a1', wf: null, birth: 5000 },
  // A copied agent file under the continuation's folder, with another name;
  // its lines keep the original session's id.
  S2: { rel: `${SLUG}/${SID_C}/subagents/agent-b2.jsonl`, kind: 'subagent', pathSession: SID_C, lineSession: SID_O, agent: 'agent-b2', wf: null, birth: 6000 },
  W: { rel: REL_W, kind: 'workflow', pathSession: SID_O, lineSession: SID_O, agent: 'agent-w1', wf: 'wf-001', birth: 7000 },
};
// [file, id, finalized, output, seconds]
const AG_SIGHTINGS = [
  ['O', 'msg_A', 0, 5, 100],     // 0  placeholder
  ['O', 'msg_A', 1, 400, 200],   // 1  finished
  ['C', 'msg_A', 1, 400, 300],   // 2  same output, later time: wins the tie-break
  ['D', 'msg_A', 0, 7, 50],      // 3  earliest-born file: takes the owner, never the counters
  ['C', 'msg_A', 1, 390, 400],   // 4  finished with less output: never wins
  ['O', 'msg_B', 1, 100, 500],   // 5
  ['E', 'msg_B', 1, 100, 500],   // 6  equal in every deciding field, same birth: first seen stays
  ['S1', 'msg_G', 0, 3, 600],    // 7
  ['S2', 'msg_G', 1, 50, 700],   // 8
  ['W', 'msg_G', 1, 50, 650],    // 9
  ['S1', 'msg_H', 1, 20, 800],   // 10 an id seen in an agent file AND in main files
  ['C', 'msg_H', 1, 25, 810],    // 11
  ['D', 'msg_H', 0, 30, 790],    // 12
  ['O', 'msg_K', 0, 8, 900],     // 13 never finished anywhere
  ['C', 'msg_K', 0, 8, 950],     // 14
  ['D', 'msg_K', 0, 2, 990],     // 15
];
const AG_N = AG_SIGHTINGS.length;
const seq = (fn) => Array.from({ length: AG_N }, (_, i) => fn(i));
// A fixed list. No randomness: a failure must reproduce.
const AG_ORDERS = [
  ['as listed', seq((i) => i)],
  ['reversed', seq((i) => AG_N - 1 - i)],
  ['rotated by 5', seq((i) => (i + 5) % AG_N)],
  ['rotated by 11', seq((i) => (i + 11) % AG_N)],
  ['stride 3', seq((i) => (i * 3) % AG_N)],
  ['stride 5', seq((i) => (i * 5 + 2) % AG_N)],
  ['stride 7', seq((i) => (i * 7 + 9) % AG_N)],
  ['evens then odds', seq((i) => (i < AG_N / 2 ? i * 2 : (i - AG_N / 2) * 2 + 1))],
  ['odds then evens, backwards', seq((i) => (i < AG_N / 2 ? AG_N - 1 - i * 2 : AG_N - 2 - (i - AG_N / 2) * 2))],
  ['by file, as a walk would', [3, 12, 15, 0, 1, 5, 13, 6, 2, 4, 11, 14, 7, 10, 8, 9]],
  ['by file, agents first', [9, 8, 7, 10, 2, 4, 11, 14, 6, 0, 1, 5, 13, 3, 12, 15]],
];

function agCandidate(i) {
  const [fileKey, id, fin, output, sec] = AG_SIGHTINGS[i];
  const f = AG_FILES[fileKey];
  // Every other field differs per sighting, so "which line won" shows in the row.
  const cacheWrite = 1000 + i;
  return {
    message_id: id,
    session_id: f.kind === 'main' ? f.pathSession : f.lineSession,
    kind: f.kind,
    slug: SLUG,
    wf_id: f.wf,
    agent_id: f.agent,
    owner_birth_ms: f.birth,
    model: i % 2 ? OPUS : HAIKU,
    ts_ms: T0 + sec * 1000,
    input: 10 + i,
    output,
    cache_write: cacheWrite,
    cache_write_5m: cacheWrite - 1,
    cache_write_1h: 1,
    cache_read: 2000 + i * 7,
    thinking: fin ? i + 1 : null,
    finalized: fin,
    stop_reason: fin ? (i % 2 ? 'end_turn' : 'tool_use') : null,
  };
}

const AG_FIELDS = ['session_id', 'kind', 'slug', 'wf_id', 'agent_id', 'owner_birth_ms', 'file',
  'model', 'ts_ms', 'local_day', 'input', 'output', 'cache_write', 'cache_write_5m', 'cache_write_1h',
  'cache_read', 'thinking', 'finalized', 'stop_reason'];

// ============================================================ child half ======

function childDirs() {
  const raw = process.env.SWITCHBOARD_DATA_DIR;
  assert.ok(raw, 'SWITCHBOARD_DATA_DIR must be set for a database test');
  const dataDir = path.resolve(raw);
  const tmp = path.resolve(os.tmpdir());
  assert.ok(dataDir.toLowerCase().startsWith(tmp.toLowerCase() + path.sep),
    'refusing to open a database outside os.tmpdir(): ' + dataDir);
  const root = path.dirname(dataDir);
  return {
    root, dataDir,
    projectsDir: path.join(root, 'projects'),
    ctxDir: path.join(root, 'claude-ctx'),
    handoffsDir: path.join(root, 'handoffs'),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, fn, ms) {
  const end = Date.now() + (ms || 30000);
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
}

function assertInside(file, dir) {
  const f = path.resolve(file).toLowerCase();
  assert.ok(f.startsWith(path.resolve(dir).toLowerCase() + path.sep), 'the store opened ' + file + ', outside ' + dir);
}

function snapshot(db) {
  const all = (sql) => db.prepare(sql).all();
  const one = (sql) => db.prepare(sql).get();
  const sums = COUNTERS.map((c) => `COALESCE(SUM(${c}), 0) AS ${c}`).join(', ') + ', COUNT(*) AS responses';
  const grand = one(`SELECT ${sums} FROM responses`);
  const bySession = all(`SELECT session_id, ${sums} FROM responses GROUP BY session_id ORDER BY session_id`);
  const sessionSum = {};
  for (const k of Object.keys(grand)) sessionSum[k] = bySession.reduce((a, r) => a + r[k], 0);
  return {
    rows: all(`SELECT r.message_id, f.rel_path AS file, r.session_id, r.kind, r.slug, r.wf_id, r.agent_id,
        r.owner_birth_ms, r.model, r.ts_ms, r.local_day, r.input, r.output, r.cache_write, r.cache_write_5m,
        r.cache_write_1h, r.cache_read, r.thinking, r.finalized, r.stop_reason
      FROM responses r LEFT JOIN files f ON f.id = r.file_id ORDER BY r.message_id`),
    sightings: all(`SELECT s.message_id || ' @ ' || COALESCE(f.rel_path, '?') AS s
      FROM sightings s LEFT JOIN files f ON f.id = s.file_id ORDER BY 1`).map((r) => r.s),
    compactions: all(`SELECT c.uuid, f.rel_path AS file, c.session_id, c.slug, c.ts_ms, c.trigger, c.pre_tokens, c.post_tokens
      FROM compactions c LEFT JOIN files f ON f.id = c.file_id ORDER BY c.uuid`),
    files: all(`SELECT rel_path, kind, slug, session_id, agent_id, wf_id, size, indexed_bytes, birthtime_ms,
        head_hash IS NOT NULL AS hashed, scan_error, missing_since, lines_skipped
      FROM files ORDER BY rel_path`),
    invariants: {
      rows: one('SELECT COUNT(*) AS n FROM responses').n,
      distinctIds: one('SELECT COUNT(DISTINCT message_id) AS n FROM responses').n,
      grand,
      sessionSum,
      sessions: bySession.length,
      fileIdWithoutFile: one('SELECT COUNT(*) AS n FROM responses r WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = r.file_id)').n,
      ownerWithoutSighting: one(`SELECT COUNT(*) AS n FROM responses r WHERE NOT EXISTS
        (SELECT 1 FROM sightings s WHERE s.message_id = r.message_id AND s.file_id = r.file_id)`).n,
      sightingWithoutFile: one('SELECT COUNT(*) AS n FROM sightings s WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = s.file_id)').n,
      sightingWithoutRow: one('SELECT COUNT(*) AS n FROM sightings s WHERE NOT EXISTS (SELECT 1 FROM responses r WHERE r.message_id = s.message_id)').n,
      splitDiffers: one('SELECT COUNT(*) AS n FROM responses WHERE cache_write_5m + cache_write_1h <> cache_write').n,
      indexes: one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").n,
    },
  };
}

async function scenarioPipeline() {
  const dirs = childDirs();
  const base = Number(process.env.TU_E2E_BASE_MS);
  assert.ok(Number.isFinite(base), 'TU_E2E_BASE_MS must be set');
  const fx = fixture(base);
  const abs = (rel) => path.join(dirs.projectsDir, ...rel.split('/'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };

  // The original is born first; ownership goes by the floored birth time, so
  // the gap must be more than a millisecond.
  write(REL_O, fx.original);
  await sleep(40);
  write(REL_C, fx.continuation);
  write(REL_S, fx.subagent);
  write(REL_W, fx.workflow);
  write(REL_J, fx.journal);
  write(`${SLUG}/memory/notes.jsonl`, fx.journal);
  fs.mkdirSync(dirs.ctxDir, { recursive: true });
  fs.mkdirSync(dirs.handoffsDir, { recursive: true });

  const logs = [];
  const log = {};
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => logs.push(level + ': ' + m);
  const broadcasts = [];

  const t = require(STORE);
  const facts = { births: {} };
  // The real worker thread, started exactly as the store starts it (the 'walk'
  // scenario leaves that to the store itself); the wrapper only listens, so the
  // test can tell a resumed pass from a full rescan. Real timers throughout.
  let chunks = [];
  const takeChunks = () => { const c = chunks; chunks = []; return c; };
  const createWorker = (workerPath, workerData) => {
    const { Worker } = require('worker_threads');
    const w = new Worker(workerPath, { workerData });
    w.on('message', (m) => {
      if (m && m.type === 'chunk') {
        chunks.push({ rel: m.rel_path, seq: m.seq, last: m.last, full: m.fullRescan, from: m.resumed_from, n: m.candidates.length, discarded: m.discarded === true });
      }
    });
    return w;
  };
  facts.init = t.init({
    log,
    createWorker,
    broadcast: (channel, payload) => broadcasts.push({ channel, phase: payload && payload.phase }),
    projectsDir: dirs.projectsDir,
    dataDir: dirs.dataDir,
    appVersion: '0.0.0-e2e',
    workerPath: WORKER,
    ctxDir: dirs.ctxDir,
    handoffsDir: dirs.handoffsDir,
    sessionInfo: (id) => (id === SID_O ? { title: 'The original' } : null),
    folderMeta: (slug) => (slug === SLUG ? { projectPath: 'C:/e2e/project' } : null),
    isRunning: (id) => id === SID_C,
  });
  assert.deepEqual(facts.init, { ok: true, state: 'ok' });
  assertInside(t._handle().name, dirs.dataDir);

  const day = (ms) => t.localDay(ms);
  const range = { from: day(base - 2 * 86400000), to: day(Date.now() + 86400000) };
  facts.range = range;

  // The Tokens tab being opened starts the first walk without waiting for the
  // 10 s deferred start (it runs when the worker has said hello).
  facts.firstSummary = t.summary(range);
  await waitFor('the backfill', () => { const s = t.status(); return s.backfillDone && s.phase === 'idle'; });

  const queries = () => ({
    summary: t.summary(range),
    summaryDefault: t.summary(),
    models: t.models(range),
    daily: t.daily(range),
    sessions: t.sessions(range),
    sessionsByOutput: t.sessions({ from: range.from, to: range.to, sort: 'output', limit: 1 }),
    contextO: t.context({ sessionId: SID_O }),
    contextC: t.context({ sessionId: SID_C }),
  });
  facts.backfill = { status: t.status(), snap: snapshot(t._handle()), queries: queries(), chunks: takeChunks() };
  for (const rel of [REL_O, REL_C]) facts.births[rel] = Math.floor(fs.statSync(abs(rel)).birthtimeMs);

  // --- An append, picked up through noteChanged + flush ---
  const fileRow = (rel) => t._handle().prepare('SELECT * FROM files WHERE rel_path = ?').get(rel);
  const before = { c: fileRow(REL_C), s: fileRow(REL_S) };
  fs.appendFileSync(abs(REL_C), fx.appendContinuation);
  fs.appendFileSync(abs(REL_S), fx.appendSubagent);
  const sizeC = fs.statSync(abs(REL_C)).size;
  const sizeS = fs.statSync(abs(REL_S)).size;
  facts.append = {
    notes: [
      t.noteChanged(REL_C.replace(/\//g, '\\')),   // the watcher's separator on Windows
      t.noteChanged(REL_S),
      t.noteChanged(REL_J),                         // a .jsonl that is not a transcript
      t.noteChanged(`${SLUG}/memory/MEMORY.md`),
    ],
    flush: t.flush(),
  };
  await waitFor('the appended lines', () => fileRow(REL_C).indexed_bytes === sizeC && fileRow(REL_S).indexed_bytes === sizeS);
  facts.append.resumedFrom = { c: before.c.indexed_bytes, s: before.s.indexed_bytes };
  facts.append.sizes = { c: sizeC, s: sizeS };
  facts.append.sameFileIds = fileRow(REL_C).id === before.c.id && fileRow(REL_S).id === before.s.id;
  facts.append.chunks = takeChunks();
  facts.append.snap = snapshot(t._handle());
  facts.append.queries = queries();

  // --- The cascade: the original is rewritten ---
  const idO = fileRow(REL_O).id;
  fs.writeFileSync(abs(REL_O), fx.originalRewritten);
  const sizeO = fs.statSync(abs(REL_O)).size;
  assert.notEqual(sizeO, fileRow(REL_O).indexed_bytes, 'the rewrite must change the size');
  facts.cascade = { note: t.noteChanged(REL_O), flushOriginal: t.flush() };
  await waitFor('the rescan of the original', () => { const r = fileRow(REL_O); return r.head_hash !== null && r.indexed_bytes === sizeO; });
  // The same transaction that re-read the original reset the continuation.
  const reset = fileRow(REL_C);
  facts.cascade.continuationReset = { head_hash: reset.head_hash, indexed_bytes: reset.indexed_bytes };
  facts.cascade.sameOriginalId = fileRow(REL_O).id === idO;
  facts.cascade.flushContinuation = t.flush();
  await waitFor('the rescan of the continuation', () => { const r = fileRow(REL_C); return r.head_hash !== null && r.indexed_bytes === sizeC; });
  facts.cascade.flushAfter = t.flush();
  facts.cascade.chunks = takeChunks();
  facts.cascade.snap = snapshot(t._handle());
  facts.cascade.queries = queries();

  // --- A fresh rebuild of the same tree ---
  facts.rebuild = { rescan: t.rescan() };
  await waitFor('the rebuild', () => { const s = t.status(); return s.backfillDone && s.phase === 'idle'; });
  assertInside(t._handle().name, dirs.dataDir);
  facts.rebuild.chunks = takeChunks();
  facts.rebuild.snap = snapshot(t._handle());
  facts.rebuild.queries = queries();
  facts.rebuild.status = t.status();

  facts.shutdown = [t.shutdown(), t.close()];
  facts.afterClose = { handle: t._handle() === null, status: t.status().state, summary: t.summary(range) };
  facts.logs = logs.filter((l) => !l.startsWith('info: ') && !l.startsWith('debug: '));
  facts.broadcastChannels = Array.from(new Set(broadcasts.map((b) => b.channel)));
  facts.dbFiles = fs.readdirSync(dirs.dataDir).sort();
  return facts;
}

// The watcher missed both changes, so the 10-minute catch-up walk finds them:
// the original rewritten AND the continuation grown. The walk works from the
// list of rows it was handed at its start, so when it reaches the continuation
// it resumes from a row the original's rescan has, by then, reset. Storing
// that pass would write the offset back, and the copies the continuation holds
// would never be applied again.
async function scenarioWalk() {
  const dirs = childDirs();
  const base = Number(process.env.TU_E2E_BASE_MS);
  assert.ok(Number.isFinite(base), 'TU_E2E_BASE_MS must be set');
  const fx = fixture(base);
  const abs = (rel) => path.join(dirs.projectsDir, ...rel.split('/'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };
  write(REL_O, fx.original);
  await sleep(40);
  write(REL_C, fx.continuation);
  write(REL_S, fx.subagent);
  write(REL_W, fx.workflow);
  fs.mkdirSync(dirs.ctxDir, { recursive: true });
  fs.mkdirSync(dirs.handoffsDir, { recursive: true });

  const logs = [];
  const log = {};
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => logs.push(level + ': ' + m);
  // Real timers and the real worker; only "now" can be moved forward, which is
  // the one way to ask for a catch-up walk without waiting a minute.
  let skew = 0;
  const t = require(STORE);
  const facts = {};
  facts.init = t.init({
    log, projectsDir: dirs.projectsDir, dataDir: dirs.dataDir, workerPath: WORKER,
    ctxDir: dirs.ctxDir, handoffsDir: dirs.handoffsDir,
    clock: { now: () => Date.now() + skew },
  });
  assert.deepEqual(facts.init, { ok: true, state: 'ok' });
  assertInside(t._handle().name, dirs.dataDir);
  const range = { from: t.localDay(base - 2 * 86400000), to: t.localDay(Date.now() + 86400000) };
  const idle = () => { const s = t.status(); return s.backfillDone && s.phase === 'idle' ? s : null; };
  const fileRow = (rel) => t._handle().prepare('SELECT * FROM files WHERE rel_path = ?').get(rel);

  t.summary(range);
  const first = await waitFor('the backfill', idle);
  facts.before = snapshot(t._handle());

  fs.writeFileSync(abs(REL_O), fx.originalRewritten);
  fs.appendFileSync(abs(REL_C), fx.appendContinuation);
  const sizeC = fs.statSync(abs(REL_C)).size;
  await sleep(5);   // the walk's "done" stamp must differ from the backfill's

  skew += 61 * 1000;
  facts.summaryThatWalks = t.summary(range).scan.phase;
  const second = await waitFor('the catch-up walk', () => { const s = idle(); return s && s.lastCatchupMs !== first.lastCatchupMs ? s : null; });
  facts.walk = { done: second.done, total: second.total, filesWithErrors: second.filesWithErrors };
  // The continuation's resumed pass was refused: its row is still the reset one.
  const c = fileRow(REL_C);
  facts.continuationAfterWalk = { head_hash: c.head_hash, indexed_bytes: c.indexed_bytes, scan_error: c.scan_error };
  facts.afterWalk = snapshot(t._handle());
  facts.flush = t.flush();
  await waitFor('the rescan of the continuation', () => { const r = fileRow(REL_C); return r.head_hash !== null && r.indexed_bytes === sizeC; });
  facts.flushAfter = t.flush();
  facts.settled = snapshot(t._handle());

  facts.rescan = t.rescan();
  await waitFor('the rebuild', idle);
  facts.rebuilt = snapshot(t._handle());
  t.shutdown();
  t.close();
  facts.logs = logs.filter((l) => !l.startsWith('info: ') && !l.startsWith('debug: '));
  return facts;
}

async function scenarioAgreement() {
  const dirs = childDirs();
  fs.mkdirSync(dirs.projectsDir, { recursive: true });
  const t = require(STORE);
  const { decideUpsert } = require(PARSER);

  const logs = [];
  const log = {};
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => logs.push(level + ': ' + m);
  // No worker at all, and timers that never fire: every row in the store comes
  // from the applyChunk calls below.
  const init = t.init({
    log, projectsDir: dirs.projectsDir, dataDir: dirs.dataDir,
    clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => {} },
  });
  assert.deepEqual(init, { ok: true, state: 'ok' });
  assertInside(t._handle().name, dirs.dataDir);

  const out = { orders: [], logs: null };
  for (const [name, order] of AG_ORDERS) {
    assert.deepEqual(order.slice().sort((a, b) => a - b), seq((i) => i), name + ' is not a permutation');
    // An empty store for every order.
    const wiped = t.rescan();
    assert.deepEqual(wiped, { ok: true }, 'rescan: ' + JSON.stringify(wiped));
    const db = t._handle();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses').get().n, 0);

    const pure = new Map();
    const applied = [];
    for (const i of order) {
      const cand = agCandidate(i);
      const f = AG_FILES[AG_SIGHTINGS[i][0]];

      // (a) the parser's pure rule, on a row shaped like the store's.
      const asStored = Object.assign({}, cand, { local_day: t.localDay(cand.ts_ms), file_id: f.rel });
      pure.set(cand.message_id, decideUpsert(pure.get(cand.message_id), asStored).row);

      // (b) the store's SQL, through the path a worker chunk takes: one pass
      // of that file carrying this one sighting.
      const res = t.applyChunk({
        type: 'chunk', gen: t._gen(), rel_path: f.rel, seq: 0, last: true, fullRescan: false, lines_skipped: 0,
        fileRow: {
          rel_path: f.rel, kind: f.kind, slug: SLUG, session_id: f.pathSession, agent_id: f.agent, wf_id: f.wf,
          size: 1000 + i, mtime_ms: T0, birthtime_ms: f.birth, head_hash: 'v1:head-' + f.rel, indexed_bytes: 1000 + i,
          tail_hash: 'tail-' + i,
        },
        candidates: [cand],
        compactions: [],
      });
      applied.push(res && res.ok === true && res.written === 1 && res.rejected === 0 ? 1 : JSON.stringify(res));
    }

    const pick = (row) => { const o = {}; for (const k of AG_FIELDS) o[k] = row[k] === undefined ? null : row[k]; return o; };
    const pureRows = {};
    for (const [id, row] of pure) pureRows[id] = pick(Object.assign({}, row, { file: row.file_id }));
    const sqlRows = {};
    for (const row of db.prepare('SELECT r.*, f.rel_path AS file FROM responses r LEFT JOIN files f ON f.id = r.file_id').all()) {
      sqlRows[row.message_id] = pick(row);
    }
    out.orders.push({
      name, order, applied, pure: pureRows, sql: sqlRows,
      sightings: db.prepare(`SELECT s.message_id || ' @ ' || f.rel_path AS s FROM sightings s JOIN files f ON f.id = s.file_id ORDER BY 1`).all().map((r) => r.s),
      rows: db.prepare('SELECT COUNT(*) AS n FROM responses').get().n,
    });
  }
  t.close();
  out.logs = logs.filter((l) => l.startsWith('warn: ') || l.startsWith('error: '));
  return out;
}

if (process.env.TU_E2E_SCENARIO) {
  const scenarios = { pipeline: scenarioPipeline, walk: scenarioWalk, agreement: scenarioAgreement };
  const run = scenarios[process.env.TU_E2E_SCENARIO];
  Promise.resolve()
    .then(() => { assert.ok(run, 'unknown scenario ' + process.env.TU_E2E_SCENARIO); return run(); })
    .then((facts) => {
      fs.writeFileSync(path.join(path.dirname(path.resolve(process.env.SWITCHBOARD_DATA_DIR)), 'result.json'), JSON.stringify(facts));
      process.exit(0);
    }, (err) => {
      process.stderr.write((err && err.stack) || String(err));
      process.exit(1);
    });
  return;
}

// =========================================================== parent half ======

const test = require('node:test');
const { spawnSync } = require('child_process');
// Under plain node, require('electron') is the path of the binary.
const electronBin = require('electron');

const roots = [];
test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
});

const results = new Map();
function runScenario(name, env) {
  if (results.has(name)) return results.get(name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-e2e-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const r = spawnSync(electronBin, [__filename], {
    cwd: APP_DIR,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir, TU_E2E_SCENARIO: name }, env || {}),
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(r.status, 0, `scenario ${name} failed (status ${r.status}, signal ${r.signal})\n${r.stderr}\n${r.stdout}`);
  const facts = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  results.set(name, facts);
  return facts;
}

// Two hours ago, on a whole second: inside the default "last 30 local days".
const BASE = Math.floor(Date.now() / 1000) * 1000 - 2 * 3600 * 1000;
const pipeline = () => runScenario('pipeline', { TU_E2E_BASE_MS: String(BASE) });

function sumOf(rows, key, pred) {
  return rows.filter(pred || (() => true)).reduce((a, r) => a + (key === 'responses' ? 1 : key === 'unfinalized' ? (r.finalized ? 0 : 1) : r[key]), 0);
}
const KEYS = COUNTERS.concat(['responses', 'unfinalized']);
function totalsOf(rows, pred) {
  const o = {};
  for (const k of KEYS) o[k] = sumOf(rows, k, pred);
  return o;
}
function pickKeys(obj) {
  const o = {};
  for (const k of KEYS) o[k] = obj[k];
  return o;
}

function checkRows(snap, stage) {
  const want = expectedRows(stage);
  const got = snap.rows.map((r) => ({
    message_id: r.message_id, kind: r.kind, session_id: r.session_id, file: r.file, input: r.input, output: r.output,
    cache_write: r.cache_write, cache_write_5m: r.cache_write_5m, cache_write_1h: r.cache_write_1h,
    cache_read: r.cache_read, finalized: r.finalized, sec: (r.ts_ms - BASE) / 1000, model: r.model,
  }));
  assert.deepEqual(got, want);
  assert.deepEqual(snap.sightings, expectedSightings(stage));
}

// Design 7.3: the invariants that must hold after every write.
// `between`: the state after a cascade and before the flush that re-reads the
// other files. The four design invariants hold there too; "every sighting has
// a response" does not yet (the continuation still lists a response that was
// deleted with the original's rows, which is how the flush knows to restore it).
function checkInvariants(snap, label, between) {
  const inv = snap.invariants;
  assert.equal(inv.rows, inv.distinctIds, label + ': COUNT(*) = COUNT(DISTINCT message_id)');
  assert.deepEqual(inv.sessionSum, inv.grand, label + ': per-session sums = grand total for every counter');
  assert.equal(inv.fileIdWithoutFile, 0, label + ': every responses.file_id exists in files');
  assert.equal(inv.ownerWithoutSighting, 0, label + ': every owner row has its sighting');
  assert.equal(inv.sightingWithoutFile, 0, label + ': every sighting names a file');
  if (!between) assert.equal(inv.sightingWithoutRow, 0, label + ': every sighting has a response');
  assert.equal(inv.splitDiffers, 0, label + ': 5m + 1h = cache_write on every row');
}

// The five queries against the rows the store must hold at this stage.
function checkQueries(q, stage, label) {
  const rows = expectedRows(stage);
  const want = totalsOf(rows);
  for (const name of ['summary', 'models', 'daily', 'sessions', 'contextO', 'contextC']) {
    assert.equal(q[name].error, undefined, `${label}: ${name} answered ${JSON.stringify(q[name].error)}`);
    assert.equal(q[name].scan && q[name].scan.state, 'ok', `${label}: ${name} carries scan`);
  }

  // summary: totals and the split by kind.
  assert.deepEqual(q.summary.totals, want, label + ': summary totals');
  for (const kind of ['main', 'subagent', 'workflow']) {
    assert.deepEqual(pickKeys(q.summary.byKind[kind]), totalsOf(rows, (r) => r.kind === kind), `${label}: summary byKind.${kind}`);
  }
  assert.deepEqual(q.summaryDefault.totals, want, label + ': the default range (last 30 local days) holds the same rows');
  assert.equal(q.summary.weighted.pricesVersion, '2026-09-25');
  assert.deepEqual(q.summary.weighted.unpricedModels, []);
  assert.ok(q.summary.weighted.tokens > 0 && q.summary.weighted.usd > 0);

  // models: one row per normalised model, adding up to the summary.
  assert.deepEqual(q.models.models.map((m) => m.model).sort(), [HAIKU_NORM, OPUS]);
  for (const k of KEYS) {
    assert.equal(q.models.models.reduce((a, m) => a + m[k], 0), want[k], `${label}: models add up to the total ${k}`);
  }
  assert.deepEqual(pickKeys(q.models.models.find((m) => m.model === HAIKU_NORM)), totalsOf(rows, (r) => r.model === HAIKU));

  // daily: every day present, the days add up to the summary.
  for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
    assert.equal(q.daily.days.reduce((a, d) => a + d.total[k], 0), want[k], `${label}: days add up to the total ${k}`);
  }
  assert.equal(new Set(q.daily.days.map((d) => d.day)).size, q.daily.days.length);
  assert.equal(q.daily.days[0].day, q.daily.range.from);
  assert.equal(q.daily.days[q.daily.days.length - 1].day, q.daily.range.to);
  assert.deepEqual(q.daily.projects.map((p) => [p.slug, p.projectPath]), [[SLUG, 'C:/e2e/project']]);

  // sessions: copied history is counted once, under the session that owns it.
  assert.equal(q.sessions.total, 2);
  const byId = Object.fromEntries(q.sessions.rows.map((r) => [r.sessionId, r]));
  for (const sid of [SID_O, SID_C]) {
    const mine = (r) => r.session_id === sid;
    assert.deepEqual(pickKeys(byId[sid].main), totalsOf(rows, (r) => mine(r) && r.kind === 'main'), `${label}: sessions ${sid} main`);
    assert.deepEqual(pickKeys(byId[sid].subagents), totalsOf(rows, (r) => mine(r) && r.kind === 'subagent'), `${label}: sessions ${sid} subagents`);
    assert.deepEqual(pickKeys(byId[sid].workflow), totalsOf(rows, (r) => mine(r) && r.kind === 'workflow'), `${label}: sessions ${sid} workflow`);
  }
  for (const k of KEYS) {
    const added = q.sessions.rows.reduce((a, r) => a + r.main[k] + r.subagents[k] + r.workflow[k], 0);
    assert.equal(added, want[k], `${label}: sessions add up to the total ${k}`);
  }
  assert.equal(byId[SID_O].title, 'The original');
  assert.equal(byId[SID_O].projectPath, 'C:/e2e/project');
  assert.equal(byId[SID_O].isRunning, false);
  assert.equal(byId[SID_C].isRunning, true);
  assert.equal(byId[SID_O].subagents.agents, 1);
  assert.equal(byId[SID_O].workflow.agents, 1);
  assert.equal(byId[SID_O].workflow.workflows, 1);
  assert.equal(byId[SID_C].subagents.agents, 0);
  assert.equal(q.sessionsByOutput.rows.length, 1);
  assert.equal(q.sessionsByOutput.total, 2);

  // context: a session's OWN main responses, in time order.
  for (const [sid, ctx] of [[SID_O, q.contextO], [SID_C, q.contextC]]) {
    const own = rows.filter((r) => r.session_id === sid && r.kind === 'main').sort((a, b) => a.sec - b.sec);
    assert.deepEqual(ctx.points.map((p) => [p.mid, p.ctx, p.out, p.fin, (p.t - BASE) / 1000]),
      own.map((r) => [r.message_id, r.input + r.cache_write + r.cache_read, r.output, r.finalized, r.sec]),
      `${label}: context points of ${sid}`);
    assert.equal(ctx.downsampled, false);
    assert.deepEqual(ctx.handoffs, []);
    assert.equal(ctx.slug, SLUG);
  }
}

test('e2e backfill: the worker, parser and store turn a transcript tree into one row per response', () => {
  const f = pipeline();
  assert.equal(f.firstSummary.error, undefined);
  assert.equal(f.firstSummary.totals.responses, 0, 'nothing is counted before the first walk');
  const s = f.backfill.status;
  assert.equal(s.state, 'ok');
  assert.equal(s.reason, null);
  assert.equal(s.parseVersion, 1);
  assert.equal(s.filesWithErrors, 0);
  assert.equal(s.filesMissing, 0);
  assert.equal(s.linesSkipped, 0);
  assert.deepEqual([s.done, s.total], [4, 4], 'four transcripts walked; journal.jsonl and memory/ are not transcripts');

  // Main files oldest first, then subagent, then workflow files; one pass each.
  const chunk = (rel, full, from, n) => ({ rel, seq: 0, last: true, full, from, n, discarded: false });
  assert.deepEqual(f.backfill.chunks, [chunk(REL_O, false, 0, 3), chunk(REL_C, false, 0, 5), chunk(REL_S, false, 0, 2), chunk(REL_W, false, 0, 2)]);
  assert.deepEqual(f.rebuild.chunks, [chunk(REL_O, false, 0, 3), chunk(REL_C, false, 0, 6), chunk(REL_S, false, 0, 3), chunk(REL_W, false, 0, 2)]);

  checkRows(f.backfill.snap, 1);
  assert.ok(f.births[REL_O] < f.births[REL_C], 'the fixture needs the original to be born first');
  // Kind, session and agent come from the right place for each kind of file.
  const row = Object.fromEntries(f.backfill.snap.rows.map((r) => [r.message_id, r]));
  assert.equal(row.msg_o3.owner_birth_ms, f.births[REL_O]);
  assert.equal(row.msg_o3.stop_reason, 'end_turn');
  assert.deepEqual([row.msg_s1.agent_id, row.msg_s1.wf_id, row.msg_s1.slug], ['agent-a1', null, SLUG]);
  assert.deepEqual([row.msg_w1.agent_id, row.msg_w1.wf_id], ['agent-w1', 'wf-001']);
  assert.deepEqual([row.msg_o1.agent_id, row.msg_o1.wf_id], [null, null]);

  assert.deepEqual(f.backfill.snap.files.map((x) => [x.rel_path, x.kind, x.session_id, x.hashed, x.indexed_bytes === x.size, x.scan_error]), [
    [REL_O, 'main', SID_O, 1, true, null],
    [REL_S, 'subagent', SID_O, 1, true, null],
    [REL_W, 'workflow', SID_O, 1, true, null],
    [REL_C, 'main', SID_C, 1, true, null],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  // The boundary is in both main files with one uuid: stored once, for the original.
  assert.deepEqual(f.backfill.snap.compactions, [{
    uuid: BOUNDARY, file: REL_O, session_id: SID_O, slug: SLUG, ts_ms: BASE + 20000, trigger: 'auto', pre_tokens: 500000, post_tokens: 40000,
  }]);
  assert.equal(f.backfill.snap.invariants.indexes, 7, 'the indexes are built when the first walk ends');
});

test('e2e backfill: the design 7.3 invariants hold and the five queries agree with the rows', () => {
  const f = pipeline();
  checkInvariants(f.backfill.snap, 'backfill');
  assert.equal(f.backfill.snap.invariants.sessions, 2);
  checkQueries(f.backfill.queries, 1, 'backfill');
  const q = f.backfill.queries;
  const sessions = Object.fromEntries(q.sessions.rows.map((r) => [r.sessionId, r]));
  // The continuation is charged for its own two responses only.
  assert.equal(sessions[SID_C].main.responses, 2);
  assert.equal(sessions[SID_C].main.output, 180);
  assert.equal(sessions[SID_O].main.responses, 3);
  assert.equal(sessions[SID_O].compactions, 1);
  assert.equal(sessions[SID_C].compactions, 0);
  assert.equal(sessions[SID_O].unfinalized, 1);
  assert.equal(sessions[SID_O].peakContext, 14 + 50 + 3000);
  assert.deepEqual(q.contextO.compactions, [{ t: BASE + 20000, trigger: 'auto', pre: 500000, post: 40000 }]);
  assert.deepEqual(q.contextC.compactions, []);
  assert.equal(q.contextO.title, 'The original');
});

test('e2e append: noteChanged + flush resume both files and count only the new lines', () => {
  const f = pipeline();
  assert.deepEqual(f.append.notes, [
    { ok: true, queued: true }, { ok: true, queued: true }, { ok: true, queued: true }, { ok: true, queued: false },
  ]);
  // journal.jsonl is queued by the store (it never loads the parser) and
  // ignored by the worker; it never becomes a files row.
  assert.deepEqual(f.append.flush, { ok: true, scanned: 3, missing: 0 });
  assert.ok(f.append.sameFileIds, 'a resumed pass keeps the files row');
  assert.ok(f.append.resumedFrom.c > 4096 && f.append.resumedFrom.c < f.append.sizes.c);
  // RESUMED, not read again from 0: each pass starts at the stored offset and
  // carries only the one new response.
  assert.deepEqual(f.append.chunks, [
    { rel: REL_C, seq: 0, last: true, full: false, from: f.append.resumedFrom.c, n: 1, discarded: false },
    { rel: REL_S, seq: 0, last: true, full: false, from: f.append.resumedFrom.s, n: 1, discarded: false },
  ]);
  checkRows(f.append.snap, 2);
  assert.equal(f.append.snap.files.length, 4);
  assert.ok(f.append.snap.files.every((x) => x.hashed === 1 && x.indexed_bytes === x.size && x.scan_error === null && x.lines_skipped === 0));
  checkInvariants(f.append.snap, 'append');
  checkQueries(f.append.queries, 2, 'append');
  // Exactly the appended usage, nothing re-counted from the resumed prefix.
  const before = f.backfill.queries.summary.totals;
  const after = f.append.queries.summary.totals;
  assert.deepEqual(
    { input: after.input - before.input, output: after.output - before.output, cache_read: after.cache_read - before.cache_read, responses: after.responses - before.responses },
    { input: 30 + 9, output: 77 + 15, cache_read: 5000 + 900, responses: 2 });
});

test('e2e cascade: after the original is rewritten, a flush leaves the store equal to a fresh rebuild', () => {
  const f = pipeline();
  assert.deepEqual(f.cascade.note, { ok: true, queued: true });
  assert.deepEqual(f.cascade.flushOriginal, { ok: true, scanned: 1, missing: 0 });
  // Re-reading the original reset every other file that carried its responses ...
  assert.deepEqual(f.cascade.continuationReset, { head_hash: null, indexed_bytes: 0 });
  assert.ok(f.cascade.sameOriginalId, 'a full rescan keeps the files row');
  // ... and queued it: this flush is the one that re-applies the copies.
  assert.deepEqual(f.cascade.flushContinuation, { ok: true, scanned: 1, missing: 0 });
  assert.deepEqual(f.cascade.flushAfter, { ok: true, scanned: 0, missing: 0 }, 'the cascade stops after one round');
  // Both are full rescans: the original because its head changed, the
  // continuation because its row was reset.
  assert.deepEqual(f.cascade.chunks, [
    { rel: REL_O, seq: 0, last: true, full: true, from: 0, n: 3, discarded: false },
    { rel: REL_C, seq: 0, last: true, full: true, from: 0, n: 6, discarded: false },
  ]);

  checkRows(f.cascade.snap, 3);
  checkInvariants(f.cascade.snap, 'cascade');
  checkQueries(f.cascade.queries, 3, 'cascade');
  const row = Object.fromEntries(f.cascade.snap.rows.map((r) => [r.message_id, r]));
  // msg_o2 survived the rewrite only because the continuation was read again.
  assert.deepEqual([row.msg_o2.session_id, row.msg_o2.file, row.msg_o2.output], [SID_C, REL_C, 396]);
  assert.equal(row.msg_o2.owner_birth_ms, f.births[REL_C]);
  assert.deepEqual([row.msg_o3.session_id, row.msg_o3.output, row.msg_o3.finalized], [SID_O, 250, 1]);
  assert.deepEqual(f.cascade.snap.compactions.map((c) => [c.uuid, c.file, c.session_id]), [[BOUNDARY, REL_C, SID_C]]);

  // The acceptance of design 7.3: every row, sighting, compaction, file and
  // total equals what a rebuild from nothing gives for the same tree.
  assert.deepEqual(f.rebuild.rescan, { ok: true });
  assert.deepEqual(f.cascade.snap, f.rebuild.snap);
  checkInvariants(f.rebuild.snap, 'rebuild');
  checkQueries(f.rebuild.queries, 3, 'rebuild');
  const strip = (q) => JSON.parse(JSON.stringify(q, (k, v) => (k === 'scan' ? undefined : v)));
  assert.deepEqual(strip(f.cascade.queries), strip(f.rebuild.queries));
  assert.equal(f.rebuild.status.filesWithErrors, 0);
});

test('e2e: nothing was logged at warn or error, and the store closes cleanly', () => {
  const f = pipeline();
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.broadcastChannels, ['token-stats-changed']);
  assert.deepEqual(f.shutdown, [{ ok: true }, { ok: true }]);
  assert.equal(f.afterClose.handle, true);
  assert.equal(f.afterClose.status, 'disabled');
  assert.match(f.afterClose.summary.error, /^Token store unavailable/);
  assert.ok(f.dbFiles.includes('token-usage.db'));
  assert.ok(!f.dbFiles.includes('token-usage.off'));
  assert.ok(!f.dbFiles.some((n) => n.includes('.corrupt-')));
});

test('e2e catch-up walk across a cascade: a pass resumed from a row the cascade has reset is refused, and the next flush makes the store equal to a rebuild', () => {
  const f = runScenario('walk', { TU_E2E_BASE_MS: String(BASE) });
  assert.equal(f.summaryThatWalks, 'catchup', 'opening the tab more than a minute after the last walk starts one');
  assert.deepEqual(f.walk, { done: 4, total: 4, filesWithErrors: 0 });
  assert.deepEqual(f.continuationAfterWalk, { head_hash: null, indexed_bytes: 0, scan_error: null });
  // Between the walk and the flush the continuation's copies are not applied yet.
  const mid = Object.fromEntries(f.afterWalk.rows.map((r) => [r.message_id, r]));
  assert.equal(mid.msg_o2, undefined);
  assert.equal(mid.msg_c3, undefined, 'the refused pass wrote nothing');
  assert.deepEqual([mid.msg_o3.output, mid.msg_o3.finalized], [5, 0]);
  checkInvariants(f.afterWalk, 'after the walk', true);
  assert.equal(f.afterWalk.invariants.sightingWithoutRow, 1, 'msg_o2 is waiting for the flush');

  assert.deepEqual(f.flush, { ok: true, scanned: 1, missing: 0 });
  assert.deepEqual(f.flushAfter, { ok: true, scanned: 0, missing: 0 });
  const row = Object.fromEntries(f.settled.rows.map((r) => [r.message_id, r]));
  assert.deepEqual([row.msg_o2.session_id, row.msg_o2.file], [SID_C, REL_C]);
  assert.deepEqual([row.msg_o3.session_id, row.msg_o3.output, row.msg_o3.finalized], [SID_O, 250, 1]);
  assert.deepEqual([row.msg_c3.session_id, row.msg_c3.output], [SID_C, 77]);
  assert.deepEqual([row.msg_o4.session_id, row.msg_o4.output], [SID_O, 500]);
  assert.deepEqual(f.settled.rows.map((r) => r.message_id),
    ['msg_c1', 'msg_c2', 'msg_c3', 'msg_o1', 'msg_o2', 'msg_o3', 'msg_o4', 'msg_s1', 'msg_s2', 'msg_w1', 'msg_w2']);
  checkInvariants(f.settled, 'settled');
  assert.deepEqual(f.rescan, { ok: true });
  assert.deepEqual(f.settled, f.rebuilt, 'walk + flush must leave what a rebuild from nothing gives');
  assert.deepEqual(f.logs, []);
});

test('agreement: decideUpsert and the SQL upsert hold the same rows after every order of the same sightings', () => {
  const f = runScenario('agreement');
  assert.equal(f.orders.length, AG_ORDERS.length);
  assert.deepEqual(f.logs, []);
  const allSightings = Array.from(new Set(AG_SIGHTINGS.map(([file, id]) => id + ' @ ' + AG_FILES[file].rel))).sort();
  for (const o of f.orders) {
    assert.deepEqual(o.applied, seq(() => 1), `${o.name}: every sighting was written`);
    assert.equal(o.rows, 5, `${o.name}: one row per id`);
    // Counters, timestamps (ts_ms and local_day) and owners (session, kind,
    // slug, wf, agent, birth, file), field for field.
    assert.deepEqual(o.sql, o.pure, `${o.name}: the store's rows differ from decideUpsert's`);
    assert.deepEqual(o.sightings, allSightings, `${o.name}: every sighting is recorded, owner or not`);
  }
});

test('agreement: where design 1.4 / 1.5 promise an order-independent row, every order gives that row', () => {
  const f = runScenario('agreement');
  const first = f.orders[0];
  for (const o of f.orders) {
    // Ids seen only in main files with distinct births and a single best line.
    for (const id of ['msg_A', 'msg_K']) assert.deepEqual(o.sql[id], first.sql[id], `${o.name}: ${id} depends on the order`);
    // Counters never depend on the order when one line is strictly best, even
    // where the owner does (agent files, and an id seen in both kinds of file).
    for (const id of ['msg_G', 'msg_H']) {
      for (const k of ['ts_ms', 'local_day', 'input', 'output', 'cache_write', 'cache_read', 'finalized', 'model', 'stop_reason']) {
        assert.equal(o.sql[id][k], first.sql[id][k], `${o.name}: ${id}.${k} depends on the order`);
      }
    }
    // An agent row's session is the line's own sessionId, whichever copy of
    // the agent file inserted it.
    assert.equal(o.sql.msg_G.session_id, SID_O, `${o.name}: msg_G session`);
  }
  // msg_A: owner = the earliest-born main file (D), counters = the finished
  // line with the most output and, at equal output, the later time (sighting 2).
  const a = first.sql.msg_A;
  assert.deepEqual([a.file, a.session_id, a.owner_birth_ms, a.kind], [AG_FILES.D.rel, SID_D, 1000, 'main']);
  assert.deepEqual([a.finalized, a.output, a.ts_ms, a.input, a.cache_write, a.cache_read], [1, 400, T0 + 300000, 12, 1002, 2014]);
  // msg_K: never finished; the largest placeholder, then the later time (sighting 14).
  const k = first.sql.msg_K;
  assert.deepEqual([k.file, k.finalized, k.output, k.ts_ms, k.input], [AG_FILES.D.rel, 0, 8, T0 + 950000, 24]);
  // msg_G: finished, 50, the later of the two equal lines (sighting 8).
  assert.deepEqual([first.sql.msg_G.output, first.sql.msg_G.ts_ms, first.sql.msg_G.input], [50, T0 + 700000, 18]);
  // msg_H: the finished line with the most output (sighting 11).
  assert.deepEqual([first.sql.msg_H.output, first.sql.msg_H.input], [25, 21]);

  // The residual order-dependence the design names is real, and both sides
  // share it: which agent file inserted first, and which of two main files
  // born in the same millisecond.
  const owners = (id) => new Set(f.orders.map((o) => o.sql[id].file));
  assert.ok(owners('msg_G').size > 1, 'msg_G: agent ownership is first-insert');
  assert.ok(owners('msg_B').size > 1, 'msg_B: equal births keep the first owner');
  // An id seen in an agent file and in main files: no takeover across kinds.
  for (const o of f.orders) {
    const firstSeen = o.order.find((i) => AG_SIGHTINGS[i][1] === 'msg_H');
    const kindOfFirst = AG_FILES[AG_SIGHTINGS[firstSeen][0]].kind;
    if (kindOfFirst !== 'main') assert.equal(o.sql.msg_H.kind, kindOfFirst, `${o.name}: an agent-owned row was taken over`);
    else assert.equal(o.sql.msg_H.file, AG_FILES.D.rel, `${o.name}: among main files the earliest-born owns it`);
  }
});
