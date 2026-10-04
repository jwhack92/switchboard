'use strict';
// Token store: the derived database ~/.switchboard/token-usage.db, its write
// path, the scan scheduler, the one long-lived scanner worker and the facade
// main.js calls. Reload class B (a change here needs an app restart), so it is
// kept dumb: no parsing happens in this file, the worker does all of it.
//
// The one rule that shapes everything below: this module can never stop the
// app. main.js has no uncaughtException handler and calls noteChanged() from a
// watcher callback with no try/catch, so
//   - nothing does I/O or loads better-sqlite3 at require time,
//   - every export is wrapped and answers { error } instead of throwing,
//   - every worker handler and every timer callback is wrapped the same way,
//   - a failure on the write path turns the store off (state 'disabled');
//     it never propagates.
// The store is derived data: a corrupt file is renamed away and rebuilt, a
// schema or parser change deletes the file and rebuilds. It never migrates and
// never refuses to start.
//
// It does not require electron, the parser, or (at load time) the queries
// module: log, broadcast, the worker and the clock arrive through init(ctx).

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;

const DB_FILE = 'token-usage.db';
const OFF_FILE = 'token-usage.off';

const QUIET_MS = 3000;                  // flush after 3 s without a new event ...
const MAX_WAIT_MS = 10000;              // ... or 10 s after the first pending event
const CATCHUP_EVERY_MS = 10 * 60 * 1000;
const CATCHUP_ON_OPEN_MS = 60 * 1000;   // Tokens tab opened: walk if the last one is older
const DEFERRED_START_MS = 10000;        // zone recompute + startup walk, after init
const PENDING_MAX = 10000;
const TZ_BATCH = 5000;
const BROADCAST_MIN_MS = 1000;
const RESPAWN_WINDOW_MS = 60 * 60 * 1000;
const RESPAWN_MAX = 3;
const RESPAWN_DELAYS_MS = [5000, 30000, 120000];
const WORKER_SILENT_MS = 10 * 60 * 1000;
const CHANGED_SESSIONS_MAX = 500;
const KINDS = new Set(['main', 'subagent', 'workflow']);
const OFF_REASON = 'disabled by ' + OFF_FILE;

// ---------------------------------------------------------------- schema ----

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('main','subagent','workflow')),
  slug          TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  agent_id      TEXT,
  wf_id         TEXT,
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  birthtime_ms  INTEGER NOT NULL,
  head_hash     TEXT,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  tail_hash     TEXT,
  lines_skipped INTEGER NOT NULL DEFAULT 0,
  last_scan_ms  INTEGER,
  missing_since INTEGER,
  scan_error    TEXT
);

CREATE TABLE IF NOT EXISTS responses (
  message_id      TEXT PRIMARY KEY,
  file_id         INTEGER NOT NULL,
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  wf_id           TEXT,
  agent_id        TEXT,
  owner_birth_ms  INTEGER NOT NULL,
  model           TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL,
  local_day       TEXT NOT NULL,
  input           INTEGER NOT NULL,
  output          INTEGER NOT NULL,
  cache_write     INTEGER NOT NULL,
  cache_write_5m  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h  INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL,
  thinking        INTEGER,
  finalized       INTEGER NOT NULL,
  stop_reason     TEXT
);

CREATE TABLE IF NOT EXISTS sightings (
  message_id  TEXT NOT NULL,
  file_id     INTEGER NOT NULL,
  PRIMARY KEY (message_id, file_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS compactions (
  uuid        TEXT PRIMARY KEY,
  file_id     INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  slug        TEXT NOT NULL,
  ts_ms       INTEGER NOT NULL,
  trigger     TEXT,
  pre_tokens  INTEGER,
  post_tokens INTEGER
);
`;

// Created only after the first backfill: a bulk load without seven secondary
// indexes is cheaper (design 2.3).
const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_resp_session_ts ON responses (session_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_resp_day_slug   ON responses (local_day, slug);
CREATE INDEX IF NOT EXISTS idx_resp_ts         ON responses (ts_ms);
CREATE INDEX IF NOT EXISTS idx_resp_model      ON responses (model);
CREATE INDEX IF NOT EXISTS idx_resp_file       ON responses (file_id);
CREATE INDEX IF NOT EXISTS idx_sight_file      ON sightings (file_id);
CREATE INDEX IF NOT EXISTS idx_comp_session    ON compactions (session_id, ts_ms);
`;

const DROP_SQL = `
DROP TABLE IF EXISTS responses;
DROP TABLE IF EXISTS sightings;
DROP TABLE IF EXISTS compactions;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS meta;
`;

// The counter rule (design 1.4, with the ts_ms tie-break that makes the stored
// timestamp independent of scan order) and the ownership rule (1.5: an
// earlier-born main file takes the row over). The two are independent: one
// statement may move the owner while keeping the counters, or the reverse.
const BETTER = `(
  (responses.finalized = 0 AND excluded.finalized = 1)
  OR (responses.finalized = excluded.finalized
      AND (excluded.output > responses.output
           OR (excluded.output = responses.output AND excluded.ts_ms > responses.ts_ms))))`;
const TAKEOVER = `(excluded.kind = 'main' AND responses.kind = 'main'
  AND excluded.owner_birth_ms < responses.owner_birth_ms)`;

const COUNTER_COLS = ['model', 'ts_ms', 'local_day', 'input', 'output', 'cache_write',
  'cache_write_5m', 'cache_write_1h', 'cache_read', 'thinking', 'finalized', 'stop_reason'];
const OWNER_COLS = ['file_id', 'session_id', 'kind', 'slug', 'wf_id', 'agent_id', 'owner_birth_ms'];
const RESPONSE_COLS = ['message_id'].concat(OWNER_COLS, COUNTER_COLS);

const UPSERT_SQL =
  'INSERT INTO responses (' + RESPONSE_COLS.join(', ') + ')\n' +
  'VALUES (' + RESPONSE_COLS.map((c) => '@' + c).join(', ') + ')\n' +
  'ON CONFLICT(message_id) DO UPDATE SET\n' +
  COUNTER_COLS.map((c) => '  ' + c + ' = CASE WHEN ' + BETTER + ' THEN excluded.' + c + ' ELSE responses.' + c + ' END')
    .concat(OWNER_COLS.map((c) => '  ' + c + ' = CASE WHEN ' + TAKEOVER + ' THEN excluded.' + c + ' ELSE responses.' + c + ' END'))
    .join(',\n') +
  '\nWHERE ' + BETTER + ' OR ' + TAKEOVER;

function createSchema(db) { db.exec(TABLES_SQL); }
function createIndexes(db) { db.exec(INDEXES_SQL); }

// ------------------------------------------------------------- day helpers ----

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function fmtDay(d) {
  return String(d.getFullYear()).padStart(4, '0') + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// LOCAL getters on purpose (design 1.6, decisions.md:52): the day is this
// machine's local day. UTC bucketing moves 28% of tokens to another day.
function localDay(tsMs) {
  if (typeof tsMs !== 'number' || !Number.isFinite(tsMs)) return null;
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return null;
  return fmtDay(d);
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_LIST_MAX = 3660;   // ten years; a guard against a runaway range, not a product limit

// CALENDAR stepping, new Date(y, m, d + i), never + 86,400,000 ms: across a DST
// change ms stepping repeats one day and drops another (design 1.6).
function dayList(fromDay, toDay) {
  const a = typeof fromDay === 'string' ? DAY_RE.exec(fromDay) : null;
  const b = typeof toDay === 'string' ? DAY_RE.exec(toDay) : null;
  if (!a || !b) return [];
  const y = Number(a[1]);
  const m = Number(a[2]) - 1;
  const d = Number(a[3]);
  const out = [];
  for (let i = 0; i < DAY_LIST_MAX; i++) {
    const day = fmtDay(new Date(y, m, d + i));
    if (day > toDay) break;
    out.push(day);
  }
  return out;
}

function currentZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'; } catch { return 'unknown'; }
}

// ------------------------------------------------------------ module state ----

const REAL_CLOCK = {
  now: () => Date.now(),
  // unref: a pending flush or the 10-minute catch-up must not keep a process alive.
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; },
  clearTimeout: (t) => clearTimeout(t),
};

let Database = null;          // better-sqlite3, loaded inside init only
let ctx = null;
let log = null;
let clock = REAL_CLOCK;
let state = 'uninit';         // 'uninit' | 'ok' | 'disabled'
let lastError = null;         // why the store is disabled
let scannerError = null;      // store works, scanning does not (shown as scan.reason)
let dataDir = null;
let dbPath = null;
let db = null;
let S = null;                 // prepared statements for the open handle
let queries = null;           // createQueries(db, ...) for the open handle
let gen = 0;                  // bumped on every reopen, delete, corrupt-rename and Rebuild
let stopped = false;          // shutdown() was called: no more scanning
let corruptRecovered = false; // one corruption recovery per init, then disabled

let worker = null;
let workerReady = false;      // hello seen
let parseVersion = null;
let lastWorkerMsgMs = 0;
let respawnTimes = [];
let walk = null;              // { mode, startedMs } while a walk is running
let walkWanted = false;
let rescanRunning = false;
let phase = 'idle';
let progressDone = 0;
let progressTotal = 0;
let lastWalkMs = -Infinity;
let tzPending = false;

const pending = new Set();          // rel paths waiting for the next flush
const cascadePending = new Set();   // the subset queued by the 3.3 cascade
const cycleRescanned = new Set();   // file ids fully rescanned in this cascade cycle
const passes = new Map();           // rel_path -> { next, fileId, fullRescan }
const changedSessions = new Set();
const seenLogs = new Set();
let catchupNeeded = false;

let quietTimer = null;
let maxTimer = null;
let deferredTimer = null;
let catchupTimer = null;
let respawnTimer = null;
let broadcastTimer = null;
let tzTimer = null;
let lastBroadcastMs = -Infinity;

// ------------------------------------------------------- guards and logging ----

function errMsg(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

function logAt(level, msg) {
  try {
    const fn = log && log[level];
    if (typeof fn === 'function') fn.call(log, msg);
  } catch { /* a broken logger must not become our failure */ }
}

// Once per distinct message: a failing statement would otherwise log on every
// watcher event.
function logOnce(level, msg) {
  if (seenLogs.has(msg)) return;
  if (seenLogs.size >= 200) seenLogs.clear();
  seenLogs.add(msg);
  logAt(level, msg);
}

function isCorrupt(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB') || code.startsWith('SQLITE_IOERR');
}

function unavailable() {
  return { error: 'Token store unavailable: ' + (lastError || 'not initialised') };
}

function fail(where, err, writePath) {
  const msg = errMsg(err);
  logOnce('error', '[token-usage] ' + where + ' failed: ' + msg);
  // A corrupt store is recovered wherever it shows itself (a query included);
  // any other failure turns the store off only when it came from the write path.
  if (state === 'ok' && isCorrupt(err)) recoverCorrupt(msg);
  else if (writePath) disableWith(msg);
  return { error: msg };
}

// For the pure helpers handed to tests and to the queries module: they work on
// a handle or a value the caller owns, so their failure says nothing about the
// store and must not touch its state.
function plain(fn) {
  return function guardedHelper() {
    try { return fn.apply(null, arguments); } catch (err) { return { error: errMsg(err) }; }
  };
}

function guard(name, fn, writePath) {
  return function guarded() {
    try {
      return fn.apply(null, arguments);
    } catch (err) {
      try { return fail(name, err, writePath); } catch (err2) { return { error: errMsg(err2) }; }
    }
  };
}

// For worker handlers and timer callbacks: nothing may escape into the event loop.
function safely(name, fn) {
  try {
    fn();
  } catch (err) {
    try { fail(name, err, true); } catch { /* nothing may escape */ }
  }
}

function later(ms, name, fn) {
  return clock.setTimeout(() => safely(name, fn), ms);
}

function cancel(t) {
  if (t === null || t === undefined) return;
  try { clock.clearTimeout(t); } catch { /* ignore */ }
}

function iso(ms) {
  try { return new Date(ms).toISOString(); } catch { return ''; }
}

// ----------------------------------------------------------------- opening ----

function getMeta(key) {
  const row = S.getMeta.get(key);
  return row && typeof row.value === 'string' ? row.value : null;
}

function setMeta(key, value) { S.setMeta.run(key, value); }

function closeDbQuiet() {
  const handle = db;
  db = null;
  S = null;
  queries = null;
  if (handle) { try { handle.close(); } catch { /* already closed or broken */ } }
}

function applyPragmas() {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');   // derived data: a crash costs at most a rescan
}

function prepareMeta() {
  S = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };
}

function prepareAll() {
  prepareMeta();
  S.fileByPath = db.prepare('SELECT * FROM files WHERE rel_path = ?');
  // ON CONFLICT DO UPDATE, never INSERT OR REPLACE: REPLACE assigns a new id and
  // orphans every row that points at the old one. The first pass of a new file
  // gets a placeholder (size 0, no hashes, offset 0); the real values land with
  // the last chunk only, so a quit between chunks never leaves a row that looks
  // fully scanned.
  S.insertFile = db.prepare(
    'INSERT INTO files (rel_path, kind, slug, session_id, agent_id, wf_id, size, mtime_ms, birthtime_ms)\n' +
    'VALUES (@rel_path, @kind, @slug, @session_id, @agent_id, @wf_id, 0, 0, @birthtime_ms)\n' +
    'ON CONFLICT(rel_path) DO UPDATE SET missing_since = NULL');
  S.finishFile = db.prepare(
    'UPDATE files SET size = @size, mtime_ms = @mtime_ms, birthtime_ms = @birthtime_ms, head_hash = @head_hash,\n' +
    '  indexed_bytes = @indexed_bytes, tail_hash = @tail_hash,\n' +
    '  lines_skipped = CASE WHEN @replace = 1 THEN @lines_skipped ELSE lines_skipped + @lines_skipped END,\n' +
    '  last_scan_ms = @now, scan_error = NULL, missing_since = NULL\n' +
    'WHERE id = @id');
  S.setScanError = db.prepare('UPDATE files SET scan_error = ? WHERE rel_path = ?');
  S.markMissing = db.prepare('UPDATE files SET missing_since = COALESCE(missing_since, ?) WHERE rel_path = ?');
  S.upsert = db.prepare(UPSERT_SQL);
  S.sighting = db.prepare('INSERT OR IGNORE INTO sightings (message_id, file_id) VALUES (?, ?)');
  S.compaction = db.prepare(
    'INSERT OR IGNORE INTO compactions (uuid, file_id, session_id, slug, ts_ms, trigger, pre_tokens, post_tokens)\n' +
    'VALUES (@uuid, @file_id, @session_id, @slug, @ts_ms, @trigger, @pre_tokens, @post_tokens)');
  S.cascadeAffected = db.prepare(
    'SELECT DISTINCT f.id AS id, f.rel_path AS rel_path FROM responses r\n' +
    'JOIN sightings s ON s.message_id = r.message_id\n' +
    'JOIN files f ON f.id = s.file_id\n' +
    'WHERE r.file_id = ? AND s.file_id != ?');
  S.delResponses = db.prepare('DELETE FROM responses WHERE file_id = ?');
  S.delSightings = db.prepare('DELETE FROM sightings WHERE file_id = ?');
  S.delCompactions = db.prepare('DELETE FROM compactions WHERE file_id = ?');
  S.resetFile = db.prepare('UPDATE files SET indexed_bytes = 0, head_hash = NULL, tail_hash = NULL WHERE id = ?');
  S.known = db.prepare('SELECT rel_path, size, mtime_ms, head_hash, indexed_bytes, tail_hash, scan_error FROM files');
  S.fileStats = db.prepare(
    'SELECT COUNT(scan_error) AS errs, COUNT(missing_since) AS missing,\n' +
    '  COALESCE(SUM(lines_skipped), 0) AS skipped, MAX(last_scan_ms) AS lastScan FROM files');
  S.tzBatch = db.prepare('SELECT rowid AS rid, ts_ms FROM responses WHERE rowid > ? ORDER BY rowid LIMIT ?');
  S.tzUpdate = db.prepare('UPDATE responses SET local_day = ? WHERE rowid = ?');

  S.applyTx = db.transaction(applyChunkRows);
  S.tzTx = db.transaction((rows) => {
    for (const r of rows) {
      const day = localDay(r.ts_ms);
      if (day) S.tzUpdate.run(day, r.rid);
    }
  });
  S.missingTx = db.transaction((rels, now) => {
    for (const rel of rels) S.markMissing.run(now, rel);
  });
}

function stampFresh() {
  setMeta('schema_version', String(SCHEMA_VERSION));
  setMeta('parse_version', '');       // filled from the worker's hello
  setMeta('tz', currentZone());
  setMeta('backfill_done', '');       // '' = a full backfill has to run
  setMeta('backfill_started', '');
  setMeta('last_catchup', '');
  setMeta('indexes_built', '');
}

function removeDbFiles() {
  for (const sfx of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + sfx); } catch { /* not there, or held open: handled by the DROP below */ }
  }
}

// Corrupt store: keep the evidence under another name, never delete it.
function quarantine() {
  const stamp = Date.now();
  for (const sfx of ['', '-wal', '-shm']) {
    try { fs.renameSync(dbPath + sfx, dbPath + '.corrupt-' + stamp + sfx); } catch { /* each one on its own */ }
  }
}

// Delete and rebuild (schema or parser change, Rebuild). Deleting is cheaper
// than DROP on a 60 MB file; the DROP is only the fallback for a file that could
// not be deleted, so a rebuild can never be refused.
function wipeAndReopen() {
  closeDbQuiet();
  gen++;
  removeDbFiles();
  db = new Database(dbPath);
  applyPragmas();
  db.exec(DROP_SQL);
  createSchema(db);
  prepareMeta();
  stampFresh();
}

function openOnce() {
  if (!Database) Database = require('better-sqlite3');
  db = new Database(dbPath);
  // No quick_check here: it reads the whole file on the main thread. A corrupt
  // file shows itself at the first statement that fails, now or later.
  applyPragmas();
  createSchema(db);
  prepareMeta();
  const version = getMeta('schema_version');
  if (version === null && db.prepare('SELECT COUNT(*) AS n FROM meta').get().n === 0) {
    stampFresh();                                   // a file we have just created
  } else if (version !== String(SCHEMA_VERSION)) {
    logAt('info', '[token-usage] schema ' + version + ' -> ' + SCHEMA_VERSION + ': rebuilding the store');
    wipeAndReopen();
  }
  if (ctx && ctx.appVersion !== undefined && ctx.appVersion !== null) setMeta('app_version', String(ctx.appVersion));
  const zone = getMeta('tz');
  if (zone === null || zone === '') setMeta('tz', currentZone());
  else tzPending = zone !== currentZone();          // recomputed on the deferred path, never inline
  if (getMeta('indexes_built') === '1') createIndexes(db);
  prepareAll();
}

// Steps 3-5 of the open sequence, with step 4: a corrupt file is renamed away
// and the open retried ONCE.
function openStore() {
  for (let attempt = 0; ; attempt++) {
    try {
      openOnce();
      return;
    } catch (err) {
      closeDbQuiet();
      if (!isCorrupt(err) || attempt > 0) {
        if (isCorrupt(err)) corruptRecovered = true;   // the one retry is spent
        throw err;
      }
      logOnce('error', '[token-usage] store is corrupt (' + errMsg(err) + '): renaming it and starting again');
      quarantine();
      gen++;
    }
  }
}

function resolveDataDir(c) {
  // Same rule as db.js:8-10, copied not imported (db.js opens its database at
  // require time). Resolved here, inside init, never at require time.
  if (typeof c.dataDir === 'string' && c.dataDir) return path.resolve(c.dataDir);
  return process.env.SWITCHBOARD_DATA_DIR
    ? path.resolve(process.env.SWITCHBOARD_DATA_DIR)
    : path.join(os.homedir(), '.switchboard');
}

function makeClock(c) {
  const given = c && typeof c === 'object' ? c : {};
  return {
    now: typeof given.now === 'function' ? () => given.now() : REAL_CLOCK.now,
    setTimeout: typeof given.setTimeout === 'function' ? (fn, ms) => given.setTimeout(fn, ms) : REAL_CLOCK.setTimeout,
    clearTimeout: typeof given.clearTimeout === 'function' ? (t) => given.clearTimeout(t) : REAL_CLOCK.clearTimeout,
  };
}

function initImpl(c) {
  if (!c || typeof c !== 'object') return { error: 'bad request: init needs a ctx object' };
  if (typeof c.projectsDir !== 'string' || !c.projectsDir) return { error: 'bad request: ctx.projectsDir is required' };
  if (state === 'ok' && db) return { ok: true, state: 'ok' };   // a second init changes nothing

  stopScanner();
  closeDbQuiet();
  ctx = c;
  log = c.log || null;
  clock = makeClock(c.clock);
  dataDir = resolveDataDir(c);
  dbPath = path.join(dataDir, DB_FILE);
  state = 'disabled';
  lastError = 'starting';
  scannerError = null;
  stopped = false;
  corruptRecovered = false;
  catchupNeeded = false;
  rescanRunning = false;
  walkWanted = false;
  tzPending = false;
  respawnTimes = [];
  lastWalkMs = -Infinity;
  gen++;

  // 1. Kill switch first: with the flag file present nothing is opened at all.
  if (fs.existsSync(path.join(dataDir, OFF_FILE))) {
    lastError = OFF_REASON;
    return { ok: false, state: 'disabled', error: unavailable().error };
  }
  // 2-5.
  fs.mkdirSync(dataDir, { recursive: true });
  openStore();
  state = 'ok';
  lastError = null;

  spawnWorker();
  // 6. Deferred: the zone recompute, then the startup walk. Not inline, so the
  // first window's own start-up work is not competing with it.
  deferredTimer = later(DEFERRED_START_MS, 'deferred start', deferredStart);
  armCatchupTimer();
  return { ok: true, state: 'ok' };
}

// ------------------------------------------------------- stopping, recovery ----

function clearFlushTimers() {
  cancel(quietTimer); quietTimer = null;
  cancel(maxTimer); maxTimer = null;
}

function terminateWorker() {
  const w = worker;
  worker = null;            // cleared first, so the exit event of this worker is ignored
  workerReady = false;
  if (!w) return;
  try {
    const p = w.terminate();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already gone */ }
}

// Drop everything in flight: used before the store is deleted, renamed or closed.
function dropInFlight() {
  clearFlushTimers();
  pending.clear();
  cascadePending.clear();
  cycleRescanned.clear();
  passes.clear();
  catchupNeeded = false;
  cancel(respawnTimer); respawnTimer = null;
  terminateWorker();
  walk = null;
  phase = 'idle';
  progressDone = 0;
  progressTotal = 0;
}

function stopScanner() {
  dropInFlight();
  cancel(deferredTimer); deferredTimer = null;
  cancel(catchupTimer); catchupTimer = null;
  cancel(broadcastTimer); broadcastTimer = null;
  cancel(tzTimer); tzTimer = null;
  changedSessions.clear();
  walkWanted = false;
  rescanRunning = false;
}

function disableWith(reason) {
  try { stopScanner(); } catch { /* keep going */ }
  try { closeDbQuiet(); } catch { /* keep going */ }
  state = 'disabled';
  lastError = reason || 'failed';
}

// Step 4 at run time: rename the corrupt file, bump the generation so chunks
// scanned against the old file are dropped, reopen empty and backfill. Once per
// init; a second corruption turns the store off.
function recoverCorrupt(msg) {
  try {
    if (corruptRecovered || !ctx || !dbPath) { disableWith(msg); return; }
    corruptRecovered = true;
    dropInFlight();
    closeDbQuiet();
    quarantine();
    gen++;
    openStore();
    rescanRunning = false;
    walkWanted = true;
    spawnWorker();
  } catch (err) {
    disableWith(errMsg(err));
  }
}

function shutdownImpl() {
  stopped = true;
  stopScanner();
  return { ok: true };
}

function closeImpl() {
  stopped = true;
  stopScanner();
  closeDbQuiet();
  if (state === 'ok') { state = 'disabled'; lastError = 'closed'; }
  return { ok: true };
}

function disableImpl() {
  if (!ctx || !dataDir) return unavailable();   // before init there is no folder to write the flag into
  stopped = true;
  stopScanner();
  closeDbQuiet();
  state = 'disabled';
  lastError = OFF_REASON;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, OFF_FILE), 'Token analytics disabled ' + iso(Date.now()) + '\n');
  return { ok: true, state: 'disabled' };
}

function enableImpl() {
  if (!ctx || !dataDir) return unavailable();
  try {
    fs.unlinkSync(path.join(dataDir, OFF_FILE));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (state === 'ok' && db && !stopped) return { ok: true, state: 'ok' };
  closeImpl();
  const r = initImpl(ctx);
  if (r && r.error) return r;
  return { ok: true, state: state === 'ok' ? 'ok' : 'disabled' };
}

// Rebuild (design 3.4): bump gen, clear pending and timers, stop the worker,
// delete and reopen, respawn, ask for a backfill walk.
function rescanImpl() {
  if (state !== 'ok' || !db) return unavailable();
  if (stopped) return { error: 'Token store unavailable: shut down' };
  if (rescanRunning) return { error: 'rescan already running' };
  gen++;
  dropInFlight();
  wipeAndReopen();
  prepareAll();
  tzPending = false;
  lastWalkMs = -Infinity;
  rescanRunning = true;
  walkWanted = true;
  if (!spawnWorker()) rescanRunning = false;   // nothing will ever report 'done'
  scheduleBroadcast();
  return { ok: true };
}

// ------------------------------------------------------------------ worker ----

function hasWorkerConfig() {
  return !!ctx && (typeof ctx.createWorker === 'function' || (typeof ctx.workerPath === 'string' && ctx.workerPath !== ''));
}

function spawnWorker() {
  if (worker || state !== 'ok' || stopped) return false;
  if (!hasWorkerConfig()) { scannerError = 'no scanner worker configured'; return false; }
  let w = null;
  try {
    const data = { projectsDir: ctx.projectsDir, gen };
    if (typeof ctx.createWorker === 'function') {
      w = ctx.createWorker(ctx.workerPath, data);
    } else {
      const { Worker } = require('worker_threads');
      w = new Worker(ctx.workerPath, { workerData: data });
    }
    if (!w || typeof w.on !== 'function' || typeof w.postMessage !== 'function') throw new Error('no worker was created');
    worker = w;
    workerReady = false;
    lastWorkerMsgMs = clock.now();
    w.on('message', (m) => safely('worker message', () => onWorkerMessage(w, m)));
    w.on('error', (e) => safely('worker error', () => onWorkerGone(w, 'error: ' + errMsg(e))));
    w.on('exit', (code) => safely('worker exit', () => onWorkerGone(w, 'exit code ' + code)));
    return true;
  } catch (err) {
    // A scanner that cannot start costs the live numbers, not the store.
    if (worker === w) { worker = null; workerReady = false; }
    logOnce('error', '[token-usage] scanner worker failed to start: ' + errMsg(err));
    scannerError = 'scanner failed to start: ' + errMsg(err);
    scheduleRespawn();
    return false;
  }
}

// error and exit both land here; the identity check makes the second one, and
// the exit of a worker we terminated on purpose, a no-op.
function onWorkerGone(w, why) {
  if (w !== worker) return;
  worker = null;
  workerReady = false;
  try {
    const p = w.terminate();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already gone */ }
  logAt('warn', '[token-usage] scanner worker stopped (' + why + ')');
  walk = null;
  phase = 'idle';
  passes.clear();           // the offsets of unfinished passes were never committed
  rescanRunning = false;
  walkWanted = true;        // whatever was in flight is picked up by a walk
  scheduleRespawn();
  scheduleBroadcast();
}

// Backoff, at most 3 respawns in any hour. Past that the scanner stays down
// until the window has moved on (the 10-minute tick tries again).
function scheduleRespawn() {
  if (respawnTimer !== null || stopped || state !== 'ok' || !hasWorkerConfig()) return;
  const now = clock.now();
  respawnTimes = respawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS);
  if (respawnTimes.length >= RESPAWN_MAX) {
    scannerError = 'scanner stopped: the worker exited more than ' + RESPAWN_MAX + ' times in an hour';
    logOnce('error', '[token-usage] ' + scannerError);
    return;
  }
  const delay = RESPAWN_DELAYS_MS[respawnTimes.length];
  respawnTimes.push(now);
  respawnTimer = later(delay, 'worker respawn', () => {
    respawnTimer = null;
    if (!worker) spawnWorker();
  });
}

function post(msg) {
  if (!worker) return false;
  try {
    worker.postMessage(msg);
    return true;
  } catch (err) {
    logOnce('warn', '[token-usage] could not post to the scanner worker: ' + errMsg(err));
    return false;
  }
}

function onWorkerMessage(w, msg) {
  if (w !== worker || !msg || typeof msg !== 'object') return;
  lastWorkerMsgMs = clock.now();
  if (msg.type === 'hello') { onHello(msg); return; }
  if (msg.type === 'chunk') { applyChunkImpl(msg); return; }
  if (msg.gen !== gen) return;      // progress and done of an older generation
  if (msg.type === 'progress') {
    if (msg.warn) logOnce('warn', '[token-usage] scanner: ' + String(msg.warn));
    if (Number.isFinite(msg.done)) progressDone = msg.done;
    if (Number.isFinite(msg.total)) progressTotal = msg.total;
    scheduleBroadcast();
    return;
  }
  if (msg.type === 'done') onDone(msg);
}

function onHello(msg) {
  const pv = Number.isInteger(msg.parseVersion) ? msg.parseVersion
    : Number.isInteger(msg.parse_version) ? msg.parse_version : null;
  if (pv === null) {
    logOnce('warn', '[token-usage] scanner hello carried no parse version');
  } else {
    const stored = getMeta('parse_version');
    if (stored !== null && stored !== '' && stored !== String(pv)) {
      // The accounting rules changed: rebuild, never refuse. The rebuild starts
      // a new worker whose hello finds an empty parse_version and sets it.
      logAt('info', '[token-usage] parser ' + stored + ' -> ' + pv + ': rebuilding the store');
      rescanRunning = false;
      rescanImpl();
      return;
    }
    if (stored !== String(pv)) setMeta('parse_version', String(pv));
    parseVersion = pv;
  }
  workerReady = true;
  scannerError = null;
  if (walkWanted) requestWalk();
  if (pending.size > 0 || catchupNeeded) armFlush();
}

// A reset or failed row must not be skipped by the catch-up walk's "same size
// and mtime" shortcut, so its size is sent as -1 (never equal to a real size).
// The hashes and offset stay as stored, so the worker's resume gate still
// decides resume vs full rescan.
function knownFiles() {
  return S.known.all().map((r) => ({
    rel_path: r.rel_path,
    size: (r.head_hash === null || r.scan_error !== null) ? -1 : r.size,
    mtime_ms: r.mtime_ms,
    head_hash: r.head_hash,
    indexed_bytes: r.indexed_bytes,
    tail_hash: r.tail_hash,
  }));
}

function requestWalk() {
  if (state !== 'ok' || stopped || !db) return false;
  if (!worker || !workerReady || walk) { walkWanted = true; return false; }
  const mode = getMeta('backfill_done') ? 'catchup' : 'backfill';
  const now = clock.now();
  cycleRescanned.clear();   // a walk is a new root event for the cascade guard
  if (!post({ type: 'walk', gen, mode, known: knownFiles() })) { walkWanted = true; return false; }
  walk = { mode, startedMs: now };
  walkWanted = false;
  lastWalkMs = now;
  phase = mode;
  progressDone = 0;
  progressTotal = 0;
  if (mode === 'backfill' && !getMeta('backfill_started')) setMeta('backfill_started', iso(Date.now()));
  scheduleBroadcast();
  return true;
}

function onDone(msg) {
  const mode = walk ? walk.mode : (msg.mode === 'backfill' ? 'backfill' : 'catchup');
  // "Gone" means ENOENT and nothing else: the worker's list is checked again
  // here, so an EACCES or EBUSY can never mark a file missing.
  const gone = [];
  if (Array.isArray(msg.missing)) {
    for (const raw of msg.missing) {
      const rel = normRel(raw);
      if (rel && statCode(rel) === 'ENOENT') gone.push(rel);
    }
  }
  if (gone.length > 0) S.missingTx(gone, clock.now());
  const stamp = iso(Date.now());
  setMeta('last_catchup', stamp);
  if (mode === 'backfill') setMeta('backfill_done', stamp);
  if (getMeta('indexes_built') !== '1') {
    createIndexes(db);
    setMeta('indexes_built', '1');
  }
  walk = null;
  phase = 'idle';
  rescanRunning = false;
  lastWalkMs = clock.now();
  scheduleBroadcast();
  if (walkWanted) requestWalk();
}

// --------------------------------------------------------------- write path ----

function normRel(p) {
  if (typeof p !== 'string' || p === '' || p.length > 1024 || p.indexOf('\0') !== -1) return null;
  const rel = p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (rel === '' || rel[0] === '/' || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return rel;
}

function statCode(rel) {
  try {
    fs.statSync(path.join(ctx.projectsDir, rel));
    return null;
  } catch (err) {
    return err && typeof err.code === 'string' ? err.code : 'EUNKNOWN';
  }
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function count(v) { return isNum(v) && v >= 0 ? Math.floor(v) : null; }
function textOrNull(v) { return typeof v === 'string' && v !== '' ? v : null; }

function validFileRow(fr) {
  return !!fr && typeof fr === 'object' && KINDS.has(fr.kind)
    && typeof fr.slug === 'string' && fr.slug !== ''
    && typeof fr.session_id === 'string' && fr.session_id !== ''
    && isNum(fr.size) && isNum(fr.mtime_ms) && isNum(fr.birthtime_ms) && isNum(fr.indexed_bytes);
}

// A candidate that cannot be stored is skipped, not thrown: one bad row must
// not cost the rest of the chunk.
function responseParams(c, fileId) {
  if (!c || typeof c !== 'object') return null;
  const day = localDay(c.ts_ms);
  const input = count(c.input);
  const output = count(c.output);
  const cacheWrite = count(c.cache_write);
  const cacheRead = count(c.cache_read);
  const birth = isNum(c.owner_birth_ms) ? Math.floor(c.owner_birth_ms) : null;
  if (typeof c.message_id !== 'string' || c.message_id === '') return null;
  if (typeof c.session_id !== 'string' || c.session_id === '') return null;
  if (typeof c.slug !== 'string' || c.slug === '') return null;
  if (typeof c.model !== 'string' || c.model === '') return null;
  if (!KINDS.has(c.kind) || day === null || birth === null) return null;
  if (input === null || output === null || cacheWrite === null || cacheRead === null) return null;
  return {
    message_id: c.message_id,
    file_id: fileId,
    session_id: c.session_id,
    kind: c.kind,
    slug: c.slug,
    wf_id: textOrNull(c.wf_id),
    agent_id: textOrNull(c.agent_id),
    owner_birth_ms: birth,
    model: c.model,
    ts_ms: Math.floor(c.ts_ms),
    local_day: day,                     // stamped here, in the main process (contract D3)
    input,
    output,
    cache_write: cacheWrite,
    cache_write_5m: count(c.cache_write_5m) || 0,
    cache_write_1h: count(c.cache_write_1h) || 0,
    cache_read: cacheRead,
    thinking: count(c.thinking),
    finalized: c.finalized ? 1 : 0,
    stop_reason: textOrNull(c.stop_reason),
  };
}

function compactionParams(c, fileId) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.uuid !== 'string' || c.uuid === '') return null;
  if (typeof c.session_id !== 'string' || c.session_id === '') return null;
  if (typeof c.slug !== 'string' || c.slug === '' || !isNum(c.ts_ms)) return null;
  return {
    uuid: c.uuid,
    file_id: fileId,
    session_id: c.session_id,
    slug: c.slug,
    ts_ms: Math.floor(c.ts_ms),
    trigger: textOrNull(c.trigger),
    pre_tokens: count(c.pre_tokens),
    post_tokens: count(c.post_tokens),
  };
}

// Full rescan of file F (design 3.3). The responses F owns may also sit in a
// continuation that is unchanged on disk and would never be scanned again, so
// every other file that sighted them is reset and queued. Returns the paths to
// queue. Guard against a ping-pong between two files that each own rows the
// other sighted: a file already fully rescanned in this cycle is left alone.
function cascade(fileId) {
  const affected = S.cascadeAffected.all(fileId, fileId);
  S.delResponses.run(fileId);
  S.delSightings.run(fileId);
  S.delCompactions.run(fileId);
  // F's own stored offset describes rows that no longer exist: reset it too, so
  // a quit before the last chunk can never resume past the deleted bytes.
  S.resetFile.run(fileId);
  const queue = [];
  for (const a of affected) {
    if (cycleRescanned.has(a.id)) {
      logOnce('warn', '[token-usage] cascade: ' + a.rel_path + ' was already rescanned in this cycle; not queued again');
      continue;
    }
    S.resetFile.run(a.id);
    queue.push(a.rel_path);
  }
  return queue;
}

// One chunk = one transaction (better-sqlite3 transactions are synchronous, so
// BEGIN is never held across an event-loop turn; the handle also serves queries).
function applyChunkRows(a) {
  const out = { fileId: null, fullRescan: false, queue: [], written: 0, rejected: 0, sessions: [] };
  if (a.seq === 0) {
    const before = a.before;
    S.insertFile.run({
      rel_path: a.rel,
      kind: a.fileRow.kind,
      slug: a.fileRow.slug,
      session_id: a.fileRow.session_id,
      agent_id: textOrNull(a.fileRow.agent_id),
      wf_id: textOrNull(a.fileRow.wf_id),
      birthtime_ms: Math.floor(a.fileRow.birthtime_ms),
    });
    out.fileId = before ? before.id : S.fileByPath.get(a.rel).id;
    out.fullRescan = a.fullRescan;
    if (a.fullRescan && before) out.queue = cascade(out.fileId);
  } else {
    out.fileId = a.pass.fileId;
    out.fullRescan = a.pass.fullRescan;
  }
  for (const c of a.candidates) {
    const p = responseParams(c, out.fileId);
    if (!p) { out.rejected++; continue; }
    S.upsert.run(p);
    S.sighting.run(p.message_id, out.fileId);   // every sighting, owner or not
    out.written++;
    out.sessions.push(p.session_id);
  }
  for (const c of a.compactions) {
    const p = compactionParams(c, out.fileId);
    if (!p) { out.rejected++; continue; }
    S.compaction.run(p);
  }
  if (a.last) {
    // The offset and the hashes are committed here and nowhere else.
    S.finishFile.run({
      id: out.fileId,
      size: Math.floor(a.fileRow.size),
      mtime_ms: Math.floor(a.fileRow.mtime_ms),
      birthtime_ms: Math.floor(a.fileRow.birthtime_ms),
      head_hash: textOrNull(a.fileRow.head_hash),
      indexed_bytes: Math.floor(a.fileRow.indexed_bytes),
      tail_hash: textOrNull(a.fileRow.tail_hash),
      lines_skipped: count(a.linesSkipped) || 0,
      replace: out.fullRescan ? 1 : 0,    // a resumed pass adds, a full rescan replaces
      now: a.now,
    });
  }
  return out;
}

function ack(msg, dropped) {
  if (!worker) return;
  const m = { type: 'ack', gen, rel_path: msg.rel_path, seq: msg.seq };
  // An ack is sent for a dropped chunk too, so the worker's one-at-a-time flow
  // control cannot stall on it; the flag says the chunk was not stored.
  if (dropped) m.dropped = true;
  post(m);
}

function dropProtocol(msg, rel, why) {
  passes.delete(rel);       // the rest of this pass has no pass to continue, so it is dropped too
  S.setScanError.run('protocol', rel);
  logOnce('warn', '[token-usage] dropped a chunk for ' + rel + ': ' + why);
  ack(msg, true);
  return { dropped: 'protocol' };
}

// The exact path a worker 'chunk' message takes.
function applyChunkImpl(msg) {
  if (state !== 'ok' || !db) return unavailable();
  if (!msg || typeof msg !== 'object') return { error: 'bad request: a chunk must be an object' };
  // Stale generation: scanned against a store that has since been dropped or
  // rebuilt. Nothing at all is written (an offset written here would make the
  // new backfill resume past bytes it never counted).
  if (msg.gen !== gen) return { dropped: 'stale gen' };
  const fileRow = msg.fileRow && typeof msg.fileRow === 'object' ? msg.fileRow : null;
  const rel = normRel(typeof msg.rel_path === 'string' ? msg.rel_path : (fileRow ? fileRow.rel_path : null));
  if (!rel) return { error: 'bad request: a chunk needs rel_path' };

  if (msg.discarded === true) {
    // The file changed while it was being read: write nothing, retry at the next flush.
    passes.delete(rel);
    S.setScanError.run('changed during scan', rel);
    queuePath(rel);
    ack(msg, false);
    return { ok: true, discarded: true };
  }

  const seq = msg.seq;
  const last = msg.last === true;
  const pass = passes.get(rel) || null;
  if (!Number.isInteger(seq) || seq < 0) return dropProtocol(msg, rel, 'bad seq');
  // seq 0 always starts a new pass (an abandoned one committed no offset).
  if (seq > 0 && (!pass || pass.next !== seq)) return dropProtocol(msg, rel, 'seq ' + seq + ' out of order');
  if ((seq === 0 || last) && !validFileRow(fileRow)) return dropProtocol(msg, rel, 'no usable fileRow');

  // The cascade reset this file after the worker had picked the row it resumed
  // from (a walk works from the `known` list it was handed at its start).
  // Finishing such a pass would write the offset back and undo the reset, and
  // the copies this file holds would never be re-applied. Refuse it and queue
  // the path: the next scan request carries the reset row and comes back as a
  // full rescan.
  const stored = seq === 0 ? (S.fileByPath.get(rel) || null) : null;
  if (stored && stored.head_hash === null && stored.last_scan_ms !== null && msg.fullRescan !== true) {
    passes.delete(rel);
    queuePath(rel);
    ack(msg, true);
    return { dropped: 'stale row' };
  }

  const res = S.applyTx({
    rel,
    before: stored,
    seq,
    last,
    pass,
    fileRow,
    fullRescan: msg.fullRescan === true,
    candidates: Array.isArray(msg.candidates) ? msg.candidates : [],
    compactions: Array.isArray(msg.compactions) ? msg.compactions : [],
    linesSkipped: msg.lines_skipped,
    now: clock.now(),
  });

  // Committed. Only now does the in-memory state move.
  if (last) passes.delete(rel);
  else passes.set(rel, { next: seq + 1, fileId: res.fileId, fullRescan: res.fullRescan });
  if (seq === 0 && res.fullRescan) cycleRescanned.add(res.fileId);
  for (const q of res.queue) {
    cascadePending.add(q);
    queuePath(q);
  }
  if (res.rejected > 0) logOnce('warn', '[token-usage] skipped unusable rows in a chunk for ' + rel);
  for (const id of res.sessions) {
    if (changedSessions.size >= CHANGED_SESSIONS_MAX) break;
    changedSessions.add(id);
  }
  ack(msg, false);
  scheduleBroadcast();
  return { ok: true, fileId: res.fileId, written: res.written, rejected: res.rejected };
}

// ---------------------------------------------------------------- scheduler ----

// Quiet 3 s OR 10 s after the first pending event, whichever comes first. A
// plain re-armed debounce has no maximum wait and starves under exactly the
// load the tab is for (design 3.5).
function armFlush() {
  cancel(quietTimer);
  quietTimer = later(QUIET_MS, 'flush', flushImpl);
  if (maxTimer === null) maxTimer = later(MAX_WAIT_MS, 'flush', flushImpl);
}

function queuePath(rel) {
  if (pending.size >= PENDING_MAX && !pending.has(rel)) {
    // Bounded: drop the set and let the next flush do a catch-up walk instead.
    pending.clear();
    cascadePending.clear();
    catchupNeeded = true;
  } else {
    pending.add(rel);
  }
  armFlush();
}

function noteChangedImpl(relFilename) {
  if (state !== 'ok' || stopped) return unavailable();   // also every call made before init
  const rel = normRel(relFilename);
  // The worker classifies paths properly (classifyPath lives in the parser,
  // which the main side never loads); this only keeps obvious non-transcripts out.
  if (!rel || !rel.endsWith('.jsonl') || rel.indexOf('/') === -1) return { ok: true, queued: false };
  queuePath(rel);
  return { ok: true, queued: true };
}

function flushImpl() {
  clearFlushTimers();
  if (state !== 'ok' || !db) return unavailable();
  if (stopped) return { error: 'Token store unavailable: shut down' };
  if (catchupNeeded) {
    catchupNeeded = false;
    requestWalk();
  }
  if (pending.size === 0) return { ok: true, scanned: 0, missing: 0 };
  if (!worker || !workerReady) {
    // Nothing is parsed on the main thread. The set is bounded and is flushed
    // when the worker says hello.
    return { ok: true, scanned: 0, missing: 0, waiting: true };
  }

  // One cascade cycle rescans a file at most once: the cycle ends at the first
  // flush that carries no cascade-queued path.
  let carriesCascade = false;
  for (const rel of pending) {
    if (cascadePending.has(rel)) { carriesCascade = true; break; }
  }
  if (!carriesCascade) cycleRescanned.clear();

  const batch = Array.from(pending);
  pending.clear();
  cascadePending.clear();
  const files = [];
  const gone = [];
  for (const rel of batch) {
    const code = statCode(rel);
    if (code === 'ENOENT') { gone.push(rel); continue; }   // ENOENT only; decision: keep the rows, mark missing
    if (code !== null) {
      logOnce('warn', '[token-usage] cannot stat ' + rel + ' (' + code + '); left for the next walk');
      continue;
    }
    files.push({ rel_path: rel, prev: S.fileByPath.get(rel) || null });
  }
  if (gone.length > 0) {
    S.missingTx(gone, clock.now());
    scheduleBroadcast();
  }
  if (files.length > 0 && !post({ type: 'scan', gen, files })) {
    for (const f of files) pending.add(f.rel_path);   // kept for the next attempt
    return { ok: true, scanned: 0, missing: gone.length, waiting: true };
  }
  return { ok: true, scanned: files.length, missing: gone.length };
}

function armCatchupTimer() {
  cancel(catchupTimer);
  catchupTimer = later(CATCHUP_EVERY_MS, 'catch-up', catchupTick);
}

// Every 10 minutes: this is what recovers a dropped watcher event or a dead watcher.
function catchupTick() {
  catchupTimer = null;
  if (state !== 'ok' || stopped) return;
  armCatchupTimer();
  if (!hasWorkerConfig()) return;
  if (!worker) { scheduleRespawn(); return; }
  if (walk && clock.now() - lastWorkerMsgMs > WORKER_SILENT_MS) {
    onWorkerGone(worker, 'no message for 10 minutes during a walk');
    return;
  }
  if (!walk) requestWalk();
}

function deferredStart() {
  deferredTimer = null;
  if (state !== 'ok' || stopped || !db) return;
  if (tzPending) tzStep(0);
  else requestWalk();
}

// The machine's zone changed since the rows were stamped: recompute local_day
// in JS, 5,000 rows per transaction, one batch per timer turn. meta.tz moves
// only when the whole pass is done, so an interrupted pass starts over.
function tzStep(afterRowid) {
  tzTimer = null;
  if (state !== 'ok' || !db) return;
  const rows = S.tzBatch.all(afterRowid, TZ_BATCH);
  if (rows.length > 0) S.tzTx(rows);
  if (rows.length < TZ_BATCH) {
    setMeta('tz', currentZone());
    tzPending = false;
    scheduleBroadcast();
    if (!stopped) requestWalk();
    return;
  }
  const next = rows[rows.length - 1].rid;
  tzTimer = later(0, 'zone recompute', () => tzStep(next));
}

// At most one token-stats-changed per second.
function scheduleBroadcast() {
  if (broadcastTimer !== null) return;
  const wait = lastBroadcastMs + BROADCAST_MIN_MS - clock.now();
  if (!(wait > 0)) { sendBroadcast(); return; }
  broadcastTimer = later(wait, 'broadcast', () => {
    broadcastTimer = null;
    sendBroadcast();
  });
}

function sendBroadcast() {
  lastBroadcastMs = clock.now();
  const ids = Array.from(changedSessions);
  changedSessions.clear();
  if (!ctx || typeof ctx.broadcast !== 'function') return;
  try {
    ctx.broadcast('token-stats-changed', { phase, done: progressDone, total: progressTotal, changedSessions: ids });
  } catch (err) {
    logOnce('warn', '[token-usage] broadcast failed: ' + errMsg(err));
  }
}

// ---------------------------------------------------------- status, queries ----

function pricesVersion() {
  try {
    const table = require('./token-prices').loadPriceTable();
    return table && typeof table.version === 'string' ? table.version : null;
  } catch {
    return null;
  }
}

// The `scan` object of design section 4.
function scanObject() {
  const ok = state === 'ok' && !!db && !!S;
  const o = {
    state: ok ? 'ok' : 'disabled',
    reason: ok ? scannerError : (lastError || 'not initialised'),
    phase,
    done: progressDone,
    total: progressTotal,
    backfillDone: null,
    lastScanMs: null,
    lastCatchupMs: null,
    filesWithErrors: 0,
    filesMissing: 0,
    linesSkipped: 0,
    parseVersion,
    pricesVersion: pricesVersion(),
  };
  if (!ok) return o;
  const f = S.fileStats.get();
  o.filesWithErrors = f.errs || 0;
  o.filesMissing = f.missing || 0;
  o.linesSkipped = f.skipped || 0;
  o.lastScanMs = f.lastScan === null || f.lastScan === undefined ? null : f.lastScan;
  o.backfillDone = getMeta('backfill_done') || null;
  const lastCatchup = Date.parse(getMeta('last_catchup') || '');
  o.lastCatchupMs = Number.isFinite(lastCatchup) ? lastCatchup : null;
  return o;
}

function runQuery(name, q) {
  if (state !== 'ok' || !db) return Object.assign(unavailable(), { scan: scanObject() });
  if (!queries) {
    // Lazy and inside the guard: a missing or broken queries module costs the
    // Tokens tab an { error }, never the app.
    const mod = require('./token-usage-queries');
    queries = mod.createQueries(db, {
      localDay,
      dayList,
      sessionInfo: ctx.sessionInfo,
      folderMeta: ctx.folderMeta,
      isRunning: ctx.isRunning,
      ctxDir: ctx.ctxDir,
      handoffsDir: ctx.handoffsDir,
      now: () => clock.now(),
    });
  }
  const fn = queries ? queries[name] : null;
  if (typeof fn !== 'function') return { error: 'Token store unavailable: no ' + name + ' query', scan: scanObject() };
  const res = fn.call(queries, q);
  const out = res && typeof res === 'object' ? Object.assign({}, res) : { error: 'Token store unavailable: bad ' + name + ' result' };
  out.scan = scanObject();
  return out;
}

function summaryImpl(q) {
  // "Tokens tab opened": a catch-up walk if the last one is older than 60 s.
  if (state === 'ok' && !stopped && !walk && clock.now() - lastWalkMs > CATCHUP_ON_OPEN_MS) {
    try { requestWalk(); } catch (err) { logOnce('warn', '[token-usage] catch-up on open failed: ' + errMsg(err)); }
  }
  return runQuery('summary', q);
}

// ------------------------------------------------------------------ exports ----

module.exports = {
  SCHEMA_VERSION,
  // Lifecycle. The third argument marks the write path: a failure there turns
  // the store off (state 'disabled') instead of repeating on every event.
  init: guard('init', initImpl, true),
  noteChanged: guard('noteChanged', noteChangedImpl, false),
  flush: guard('flush', flushImpl, true),
  rescan: guard('rescan', rescanImpl, true),
  disable: guard('disable', disableImpl, true),
  enable: guard('enable', enableImpl, true),
  shutdown: guard('shutdown', shutdownImpl, false),
  close: guard('close', closeImpl, false),
  status: guard('status', scanObject, false),
  // Queries (each: the design section 4 shape plus `scan`).
  summary: guard('summary', summaryImpl, false),
  models: guard('models', (q) => runQuery('models', q), false),
  daily: guard('daily', (q) => runQuery('daily', q), false),
  sessions: guard('sessions', (q) => runQuery('sessions', q), false),
  context: guard('context', (q) => runQuery('context', q), false),
  // For tests and for the queries module's tests.
  createSchema: plain((handle) => { createSchema(handle); return { ok: true }; }),
  createIndexes: plain((handle) => { createIndexes(handle); return { ok: true }; }),
  localDay: plain(localDay),
  dayList: plain(dayList),
  applyChunk: guard('applyChunk', applyChunkImpl, true),
  _handle: () => db,
  _gen: () => gen,
};
