'use strict';
// Token store: the derived database ~/.switchboard/token-usage.db, its write
// path, the scan scheduler, the one long-lived scanner worker, the query worker
// and the facade main.js calls. Reload class B (a change here needs an app
// restart), so it is kept dumb: no parsing happens in this file (the scanner
// worker does all of it) and no query runs in this thread unless the query
// worker cannot be used.
//
// The one rule that shapes everything below: this module can never stop the
// app. main.js has no uncaughtException handler and calls noteChanged() from a
// watcher callback with no try/catch, so
//   - nothing does I/O or loads better-sqlite3 at require time,
//   - every export is wrapped and answers { error } instead of throwing,
//   - every worker handler and every timer callback is wrapped the same way,
//   - a failure on the write path turns the store off (state 'disabled');
//     it never propagates,
//   - the five queries return a Promise that always resolves, to the answer or
//     to { error, scan }; it never rejects.
// The store is derived data: a corrupt file is renamed away and rebuilt, a
// schema or parser change (or the Rebuild button) sets the file aside as
// token-usage.db.before-rebuild-<ms> and rebuilds. It never migrates and never
// refuses to start.
//
// It does not require electron, the parser, or (at load time) the queries
// module: log, broadcast, the worker and the clock arrive through init(ctx).
// The queries module and the price module ARE loaded by this process, lazily,
// at the first Tokens query (decorateResult, wireRequest, the inline fallback,
// scan.pricesVersion), and that copy is then as frozen as this file: an edit
// to either reaches the main process only with an app restart. The query
// worker loads its own copy of both at each spawn (see its header).

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;

const DB_FILE = 'token-usage.db';
const OFF_FILE = 'token-usage.off';
const KEPT_MARK = '.before-rebuild-';   // token-usage.db.before-rebuild-<epoch ms>: the store a rebuild replaced

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
const SCAN_HELLO_MS = 30000;            // no hello by then: the scanner did not start, it is replaced
const CHANGED_SESSIONS_MAX = 500;
const KINDS = new Set(['main', 'subagent', 'workflow']);
const OFF_REASON = 'disabled by ' + OFF_FILE;

// The query worker (workers/query-tokens.js).
const QUERY_TIMEOUT_MS = 30000;         // no answer by then: { error: 'query timed out' }, worker replaced
const QW_HELLO_MS = 10000;              // no hello by then: the worker cannot start, queries run inline
const QW_CLOSE_WAIT_MS = 5000;          // longest wait for "my connection is closed" before a delete or rename
// Shorter than the scanner's: a query that waits for the respawn has 30 s in all.
const QW_RESPAWN_DELAYS_MS = [1000, 5000, 15000];
const WAITING_MAX = 200;                // queries waiting for an answer; past that a new one is refused
const SIG_CLOSING = 0;                  // the two int32 shared with the query worker (see its header)
const SIG_CLOSED = 1;

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
// indexes is cheaper (design 2.3). One statement each, because after a backfill
// they are built one per timer turn (startIndexBuild): all seven in one call
// held the main thread for 1.1-1.4 s on the real-size store. The two the
// cascade's statements need come first, so a full rescan stops scanning the
// whole table as early as possible.
const INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_resp_file       ON responses (file_id)',
  'CREATE INDEX IF NOT EXISTS idx_sight_file      ON sightings (file_id)',
  'CREATE INDEX IF NOT EXISTS idx_resp_session_ts ON responses (session_id, ts_ms)',
  'CREATE INDEX IF NOT EXISTS idx_resp_day_slug   ON responses (local_day, slug)',
  'CREATE INDEX IF NOT EXISTS idx_resp_ts         ON responses (ts_ms)',
  'CREATE INDEX IF NOT EXISTS idx_resp_model      ON responses (model)',
  'CREATE INDEX IF NOT EXISTS idx_comp_session    ON compactions (session_id, ts_ms)',
];
const INDEXES_SQL = INDEX_STATEMENTS.join(';\n') + ';';

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
let unansweredSinceMs = null; // when the oldest walk or scan was posted that no worker message has followed
let respawnTimes = [];
let walk = null;              // { mode, startedMs, level } while a walk is running
let walkWanted = false;
let walkDoneSinceOpen = false; // a walk has finished since init: later catch-up walks log at debug
let rescanRunning = false;
let phase = 'idle';
let progressDone = 0;
let progressTotal = 0;
let lastWalkMs = -Infinity;
let tzPending = false;

// The query worker. Started by the first query, never by init: a store nobody
// looks at needs no second connection, and whatever a native module in a worker
// thread could do to this process cannot then happen at every app start.
let qw = null;                // { worker, signal, ready, helloTimer }
let qwUsed = false;           // a query has asked for it since init: start it again after a rebuild
let qwRespawnTimes = [];
let qwRespawnTimer = null;
let querySeq = 0;
let queryInline = false;      // latched: the worker cannot serve, queries run on this thread's handle
const waiting = new Map();    // id -> { id, name, q, resolve, timer, sentTo }

const pending = new Set();          // rel paths waiting for the next flush
const cascadePending = new Set();   // the subset queued by the 3.3 cascade
const cycleRescanned = new Set();   // file ids fully rescanned in this cascade cycle
const cycleExtraReset = new Set();  // file ids that have had their one extra reset in this cycle
const cycleQueuedBy = new Map();    // rel_path -> Set of the file ids whose full rescan queued it in this cycle
const passes = new Map();           // rel_path -> { next, fileId, fullRescan }
const changedSessions = new Set();
const seenLogs = new Set();
let catchupNeeded = false;

let quietTimer = null;
let maxTimer = null;
let deferredTimer = null;
let catchupTimer = null;
let respawnTimer = null;
let helloTimer = null;        // armed at every scanner spawn, cancelled by its hello
let broadcastTimer = null;
let tzTimer = null;
let indexTimer = null;        // the chain that builds the secondary indexes, one per timer turn
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

function isCorruptCode(code) {
  return typeof code === 'string'
    && (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB') || code.startsWith('SQLITE_IOERR'));
}

function isCorrupt(err) {
  return isCorruptCode(err ? err.code : null);
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

// The same for the read side (query worker handlers and timers): a failure
// there says nothing about the write path and must not turn the store off.
function reading(name, fn) {
  try {
    fn();
  } catch (err) {
    try { fail(name, err, false); } catch { /* nothing may escape */ }
  }
}

function laterReading(ms, name, fn) {
  return clock.setTimeout(() => reading(name, fn), ms);
}

// For the five queries: the call never throws and the Promise never rejects.
function guardQuery(name, fn) {
  return function guardedQuery() {
    let p;
    try {
      p = fn.apply(null, arguments);
    } catch (err) {
      p = queryFailure(name, err);
    }
    return Promise.resolve(p)
      .then(null, (err) => queryFailure(name, err))
      .then(null, (err) => ({ error: errMsg(err) }));
  };
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
  S.known = db.prepare('SELECT rel_path, size, mtime_ms, head_hash, indexed_bytes, tail_hash, scan_error, missing_since FROM files');
  S.fileStats = db.prepare(
    'SELECT COUNT(*) AS files, COUNT(scan_error) AS errs, COUNT(missing_since) AS missing,\n' +
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
  closeQueryWorker();       // its open handle would make every rename fail on Windows
  const stamp = Date.now();
  for (const sfx of ['', '-wal', '-shm']) {
    try { fs.renameSync(dbPath + sfx, dbPath + '.corrupt-' + stamp + sfx); } catch { /* each one on its own */ }
  }
}

// A rebuild mirrors what is on disk now, so the rows of transcripts that have
// since been deleted would be gone for good (decision: "Keep them, marked
// missing"). The store being replaced is therefore set aside as
// token-usage.db.before-rebuild-<epoch ms>, and only the latest one is kept.
// `complete` says the main file holds everything (the write-ahead log was
// folded in): a file renamed without its log would be kept incomplete. Returns
// false when the store was not kept; the caller then deletes it, as a rebuild
// always did, and the warn line here is the only trace.
function keepOldStore(complete) {
  const name = DB_FILE + KEPT_MARK + Date.now();
  let why = 'its write-ahead log could not be folded into the main file';
  let kept = false;
  if (complete) {
    try {
      // A log that is still there with bytes in it belongs to this file.
      if (fs.statSync(dbPath + '-wal').size > 0) complete = false;
    } catch { /* no log left: what a clean close leaves */ }
  }
  if (complete) {
    try {
      fs.renameSync(dbPath, path.join(dataDir, name));
      kept = true;
    } catch (err) {
      why = errMsg(err);
    }
  }
  if (!kept) {
    logAt('warn', '[token-usage] rebuild: the previous store could not be kept (' + why + '); it is deleted instead');
    return false;
  }
  logAt('info', '[token-usage] rebuild: the previous store is kept as ' + name);
  try {
    for (const other of fs.readdirSync(dataDir)) {
      if (!other.startsWith(DB_FILE + KEPT_MARK) || other === name) continue;
      try { fs.unlinkSync(path.join(dataDir, other)); } catch { /* tried again at the next rebuild */ }
    }
  } catch { /* the folder could not be listed: an older copy stays until the next rebuild */ }
  return true;
}

// Set aside and rebuild (schema or parser change, Rebuild). Renaming, like the
// delete it replaces, is cheaper than DROP on a 60 MB file; the delete is the
// fallback for a file that could not be kept, and the DROP for one that could
// not be deleted either, so a rebuild can never be refused.
function wipeAndReopen() {
  // First, and confirmed: on Windows the query worker's open handle makes the
  // rename fail, and a reader makes the checkpoint below wait out the busy timeout.
  const readerClosed = closeQueryWorker();
  // Only the latest copy is kept, so a store whose first backfill never
  // finished (the flag is still the '' stampFresh wrote) must not take the
  // place of the copy kept before it: that one is a full store, this one holds
  // part of what a walk was still reading. It is deleted, as a rebuild did
  // before copies were kept. A flag that cannot be read says nothing, and the
  // store is then kept as any other.
  let unfinished = false;
  try { unfinished = !!db && !!S && getMeta('backfill_done') === ''; } catch { /* unknown */ }
  let complete = false;
  if (db && readerClosed && !unfinished) {
    try {
      const r = db.pragma('wal_checkpoint(TRUNCATE)');
      complete = Array.isArray(r) && r.length > 0 && r[0].busy === 0;
    } catch { /* not complete: the store is deleted, not kept */ }
  }
  closeDbQuiet();
  gen++;
  if (unfinished) logAt('info', '[token-usage] rebuild: the store being replaced had not finished its first backfill; it is deleted, not kept');
  else keepOldStore(complete);
  removeDbFiles();          // the main file when it was not kept; what is left of its -wal and -shm either way
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
  closeQueryWorker();
  closeDbQuiet();
  // Queries still waiting belong to the store that has just been closed, and
  // their timers to the clock that is about to be replaced.
  failWaiting('Token store unavailable: restarting');
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
  walkDoneSinceOpen = false;
  tzPending = false;
  respawnTimes = [];
  lastWalkMs = -Infinity;
  qwUsed = false;
  qwRespawnTimes = [];
  queryInline = false;
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
  // The info lines (this one, a walk's start and end, the query worker's
  // hello) are what the log shows of a healthy store: without them "all is
  // well" and "init never ran" look the same.
  logAt('info', '[token-usage] opened ' + dbPath + ' schema ' + SCHEMA_VERSION + ', ' + fileCount() + ' files');

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
  unansweredSinceMs = null;
  cancel(helloTimer); helloTimer = null;
  if (!w) return;
  try {
    const p = w.terminate();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already gone */ }
}

// What the cascade guard remembers lives for one cycle (see cascade()).
function endCascadeCycle() {
  cycleRescanned.clear();
  cycleExtraReset.clear();
  cycleQueuedBy.clear();
}

// Drop everything in flight: used before the store is deleted, renamed or closed.
function dropInFlight() {
  clearFlushTimers();
  pending.clear();
  cascadePending.clear();
  endCascadeCycle();
  passes.clear();
  catchupNeeded = false;
  cancel(respawnTimer); respawnTimer = null;
  cancel(indexTimer); indexTimer = null;    // the store it was building for is about to go
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
  try { closeQueryWorker(); } catch { /* keep going */ }
  try { closeDbQuiet(); } catch { /* keep going */ }
  state = 'disabled';
  lastError = reason || 'failed';
  try { pumpQueries(); } catch { /* keep going */ }     // whoever is waiting is told now
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
    restartQueryWorker();
  } catch (err) {
    disableWith(errMsg(err));
  }
}

function shutdownImpl() {
  stopped = true;
  stopScanner();
  closeQueryWorker();
  pumpQueries();
  return { ok: true };
}

function closeImpl() {
  stopped = true;
  stopScanner();
  closeQueryWorker();
  closeDbQuiet();
  if (state === 'ok') { state = 'disabled'; lastError = 'closed'; }
  pumpQueries();
  return { ok: true };
}

function disableImpl() {
  if (!ctx || !dataDir) return unavailable();   // before init there is no folder to write the flag into
  stopped = true;
  stopScanner();
  closeQueryWorker();
  closeDbQuiet();
  state = 'disabled';
  lastError = OFF_REASON;
  pumpQueries();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, OFF_FILE), 'Token analytics disabled ' + iso(Date.now()) + '\n');
  // Not through the one-per-second limit: this is one click, and the scanner
  // that would have sent the next message has just been stopped. Another
  // window's Tokens tab learns from this that the store was switched.
  sendBroadcast();
  return { ok: true, state: 'disabled' };
}

// Also what the tab's "Try again" calls, with no confirm. So the flag file is
// removed ONLY when the store is off because of the kill switch (the confirmed
// Enable button). Off after a failure, a flag made by hand meanwhile stays:
// init then finds it and reports the kill switch, as reopenAfterFailure does.
function enableImpl() {
  if (!ctx || !dataDir) return unavailable();
  if (reasonCode() === 'kill-switch') {
    try {
      fs.unlinkSync(path.join(dataDir, OFF_FILE));
    } catch (err) {
      // Answered, not thrown: a throw here goes through the write-path guard
      // and would turn "off by the kill switch" into a failure, whose Try
      // again can only fail the same way while the flag is still there.
      if (!err || err.code !== 'ENOENT') {
        return { error: 'Token store unavailable: could not remove ' + OFF_FILE + ' (' + errMsg(err) + ')' };
      }
    }
  }
  if (state === 'ok' && db && !stopped) return { ok: true, state: 'ok' };
  closeImpl();
  let r;
  try {
    r = initImpl(ctx);
  } finally {
    // On, still off, or an init that threw (the guard answers that one and
    // turns the store off): every window's tab should look again. The message
    // carries no state, and a window that asks because of it is answered after
    // the guard has run, so it sees the final state either way.
    sendBroadcast();
  }
  if (r && r.error) return r;
  return { ok: true, state: state === 'ok' ? 'ok' : 'disabled' };
}

// 'kill-switch' | 'failure' | null. null is "on", and also the two off states
// that are neither: before init, and after close().
function reasonCode() {
  if (state === 'ok' && db) return null;
  if (lastError === OFF_REASON) return 'kill-switch';
  if (state === 'uninit' || lastError === 'closed' || !lastError) return null;
  return 'failure';
}

// "Try again": a store that is off because something failed (not because of
// the kill switch) is opened again from scratch. Returns null when it is open.
function reopenAfterFailure() {
  if (!ctx || !dataDir || reasonCode() !== 'failure') return unavailable();
  if (fs.existsSync(path.join(dataDir, OFF_FILE))) return unavailable();
  closeImpl();
  const r = initImpl(ctx);
  if (r && r.error) return r;
  if (state !== 'ok' || !db) return unavailable();
  return null;
}

// Rebuild (design 3.4): bump gen, clear pending and timers, stop the worker,
// delete and reopen, respawn, ask for a backfill walk.
function rescanImpl() {
  if (state !== 'ok' || !db) {
    const refused = reopenAfterFailure();
    if (refused) return refused;
  }
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
  // The worker file is read again at every spawn, so Rebuild is also the way
  // to try a query worker that could not start before.
  queryInline = false;
  qwRespawnTimes = [];
  restartQueryWorker();
  scheduleBroadcast();
  return { ok: true };
}

// ------------------------------------------------------------ query worker ----
//
// The five queries run in workers/query-tokens.js on its own READ-ONLY
// connection. What this file keeps:
//   - the list of queries waiting for an answer (each with a 30 s timer, so
//     every Promise resolves whatever happens to the worker);
//   - the worker's life: started by the first query, respawned with backoff at
//     most 3 times an hour, and CLOSED WITH CONFIRMATION before every path that
//     deletes, renames or closes the store (on Windows its open handle would
//     make the delete or the rename fail);
//   - the fallback: a worker that cannot start, or has used up its respawns,
//     leaves the queries running here on the store's own handle, as they did
//     before there was a worker. Slow for the terminals, but never dead.

function queryMode() {
  return state === 'ok' && !!db && !stopped && !queryInline ? 'worker' : 'inline';
}

function queryWorkerPath() {
  if (ctx && typeof ctx.workerPath === 'string' && ctx.workerPath !== '') {
    return path.join(path.dirname(ctx.workerPath), 'query-tokens.js');   // beside the scan worker
  }
  return path.join(__dirname, 'workers', 'query-tokens.js');
}

// The scan object for an answer. Reading it can fail like any statement; the
// answer still goes out.
function scanForAnswer(mode) {
  let o;
  try {
    o = scanObject();
  } catch (err) {
    try { fail('status', err, false); } catch { /* keep going */ }
    try { o = scanObject(); } catch { o = { state: 'disabled', reason: errMsg(err), reasonCode: 'failure', files: null, queryMode: 'inline' }; }
  }
  if (mode && o.state === 'ok') o.queryMode = mode;   // how THIS answer was computed
  return o;
}

function withScan(res, name, mode) {
  const out = res && typeof res === 'object'
    ? Object.assign({}, res)
    : { error: 'Token store unavailable: bad ' + name + ' result' };
  out.scan = scanForAnswer(mode);
  return out;
}

function queryFailure(name, err) {
  let out;
  try { out = fail(name, err, false); } catch (err2) { out = { error: errMsg(err2) }; }
  try { out.scan = scanForAnswer(); } catch { /* the error alone is still an answer */ }
  return out;
}

function settle(entry, out) {
  if (!waiting.delete(entry.id)) return;      // answered already (a late result after a timeout)
  cancel(entry.timer);
  entry.timer = null;
  try { entry.resolve(out); } catch { /* a resolver does not throw; nothing may escape anyway */ }
}

function failWaiting(error) {
  for (const entry of Array.from(waiting.values())) {
    settle(entry, { error, scan: scanForAnswer() });
  }
}

// The queries on this thread's own handle: the code path from before the
// query worker, and what the fallback runs.
function runInline(name, q) {
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
  if (typeof fn !== 'function') return { error: 'Token store unavailable: no ' + name + ' query' };
  return fn.call(queries, q);
}

function inlineAnswer(name, q) {
  let res;
  try {
    res = runInline(name, q);
  } catch (err) {
    try { res = fail(name, err, false); } catch (err2) { res = { error: errMsg(err2) }; }
  }
  return withScan(res, name, 'inline');
}

// A query does not throw: the queries module (and the query worker) answer
// { error, code }. So a damaged page that only a query reads never reaches
// fail(), and the store would go on answering "malformed" for ever while
// saying it is fine. The code is looked at here instead, and a corruption code
// takes the same path as on the write path: rename, new generation, backfill;
// once per init. Called AFTER the answer has been handed over: recovery asks
// every waiting query again, and this one has had its answer.
function recoverIfCorrupt(res) {
  if (state !== 'ok' || !res || typeof res !== 'object' || typeof res.error !== 'string' || !isCorruptCode(res.code)) return;
  logOnce('error', '[token-usage] a query failed on a corrupt store (' + res.code + '): ' + res.error);
  recoverCorrupt(res.error);
}

// What only this thread can add to the worker's answer: titles, project paths
// and labels, isRunning.
function workerAnswer(name, res) {
  let out = res;
  try {
    const mod = require('./token-usage-queries');
    if (typeof mod.decorateResult === 'function') {
      out = mod.decorateResult(name, res, { sessionInfo: ctx.sessionInfo, folderMeta: ctx.folderMeta, isRunning: ctx.isRunning });
    }
  } catch (err) {
    logOnce('warn', '[token-usage] could not add titles and project paths to a query answer: ' + errMsg(err));
    out = res;
  }
  return withScan(out, name, 'worker');
}

function wire(q) {
  const mod = require('./token-usage-queries');
  return typeof mod.wireRequest === 'function' ? mod.wireRequest(q) : q;
}

function fallBackInline(why) {
  if (queryInline) return;
  queryInline = true;
  logOnce('warn', '[token-usage] the query worker is not available (' + why + '): token queries run in the main process');
}

// Stop using a worker without waiting for it: it is dead, stuck or unwanted.
// The closing flag makes a worker that is still alive close its connection at
// its next message instead of starting another query.
function dropQueryWorker(cur) {
  if (qw === cur) qw = null;
  cancel(cur.helloTimer);
  cur.helloTimer = null;
  try { Atomics.store(cur.signal, SIG_CLOSING, 1); } catch { /* ignore */ }
  try {
    const p = cur.worker.terminate();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already gone */ }
}

// Close the query worker's connection and WAIT for the confirmation. Called
// before every delete, rename and close of the database file. Synchronous on
// purpose: the callers are (Rebuild, the corrupt-file rename, disable, close),
// and a state machine that waits for a message would leave the store half
// closed while other calls arrive. The wait is the rest of the one query the
// worker is in, at most: it starts no other once the flag is up.
// Returns true when the connection is known to be closed.
function closeQueryWorker() {
  cancel(qwRespawnTimer);
  qwRespawnTimer = null;
  const cur = qw;
  qw = null;
  // Whatever was sent is asked again of the next worker, or answered by
  // pumpQueries once the caller has settled what state the store is in.
  for (const entry of waiting.values()) entry.sentTo = null;
  if (!cur) return true;
  cancel(cur.helloTimer);
  cur.helloTimer = null;
  let confirmed = false;
  try {
    Atomics.store(cur.signal, SIG_CLOSING, 1);
    try { cur.worker.postMessage({ type: 'close' }); } catch { /* a dead worker holds no handle */ }
    if (Atomics.load(cur.signal, SIG_CLOSED) !== 1) Atomics.wait(cur.signal, SIG_CLOSED, 0, QW_CLOSE_WAIT_MS);
    confirmed = Atomics.load(cur.signal, SIG_CLOSED) === 1;
  } catch (err) {
    logOnce('warn', '[token-usage] could not wait for the query worker to close: ' + errMsg(err));
  }
  try {
    const p = cur.worker.terminate();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already gone */ }
  if (!confirmed) {
    // The delete that follows may fail; wipeAndReopen then drops the tables in
    // place, and a rename that fails leaves the store disabled. Neither throws.
    logOnce('warn', '[token-usage] the query worker did not confirm that its connection is closed');
  }
  return confirmed;
}

function startQueryWorker() {
  if (qw || state !== 'ok' || !db || stopped || queryInline || !ctx) return false;
  let w = null;
  try {
    const signal = new Int32Array(new SharedArrayBuffer(8));
    const data = { dbPath, signal: signal.buffer };
    if (typeof ctx.ctxDir === 'string' && ctx.ctxDir) data.ctxDir = ctx.ctxDir;
    if (typeof ctx.handoffsDir === 'string' && ctx.handoffsDir) data.handoffsDir = ctx.handoffsDir;
    const workerPath = queryWorkerPath();
    if (typeof ctx.createQueryWorker === 'function') {
      w = ctx.createQueryWorker(workerPath, data);
    } else {
      const { Worker } = require('worker_threads');
      w = new Worker(workerPath, { workerData: data });
    }
    if (!w || typeof w.on !== 'function' || typeof w.postMessage !== 'function') throw new Error('no worker was created');
    const cur = { worker: w, signal, ready: false, helloTimer: null };
    qw = cur;
    w.on('message', (m) => reading('query worker message', () => onQueryWorkerMessage(cur, m)));
    w.on('error', (e) => reading('query worker error', () => onQueryWorkerGone(cur, 'error: ' + errMsg(e))));
    w.on('exit', (code) => reading('query worker exit', () => onQueryWorkerGone(cur, 'exit code ' + code)));
    cur.helloTimer = laterReading(QW_HELLO_MS, 'query worker hello', () => {
      cur.helloTimer = null;
      if (qw === cur && !cur.ready) queryWorkerCannotStart(cur, 'no hello within ' + (QW_HELLO_MS / 1000) + ' s');
    });
    return true;
  } catch (err) {
    const cur = qw && qw.worker === w ? qw : null;
    if (!cur && w && typeof w.terminate === 'function') {
      try { const p = w.terminate(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* ignore */ }
    }
    queryWorkerCannotStart(cur, errMsg(err));
    return false;
  }
}

// After a rebuild or a corrupt-file recovery, where the store stays open: the
// worker comes back if the Tokens tab has been using it.
function restartQueryWorker() {
  if (qwUsed || waiting.size > 0) startQueryWorker();
  pumpQueries();
}

function queryWorkerCannotStart(cur, why) {
  if (cur) dropQueryWorker(cur);
  fallBackInline(why);
  pumpQueries();
}

function onQueryWorkerMessage(cur, msg) {
  if (qw !== cur || !msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') {
    if (cur.ready) return;
    if (msg.ok !== true) {
      queryWorkerCannotStart(cur, typeof msg.error === 'string' && msg.error ? msg.error : 'its hello carried no ok');
      return;
    }
    cancel(cur.helloTimer);
    cur.helloTimer = null;
    cur.ready = true;
    logAt('info', '[token-usage] query worker ready');
    pumpQueries();
    return;
  }
  if (msg.type === 'result') {
    const entry = waiting.get(msg.id);
    if (!entry || entry.sentTo !== cur) return;
    settle(entry, workerAnswer(entry.name, msg.result));
    recoverIfCorrupt(msg.result);
  }
}

// error and exit both land here; the identity check makes the second one, and
// the exit of a worker that was closed on purpose, a no-op.
function onQueryWorkerGone(cur, why) {
  if (qw !== cur) return;
  const served = cur.ready;
  dropQueryWorker(cur);
  if (!served) {
    queryWorkerCannotStart(null, 'it stopped before its hello, ' + why);
    return;
  }
  logAt('warn', '[token-usage] query worker stopped (' + why + ')');
  // What it was working on has no answer. Queries not yet sent wait for the respawn.
  for (const entry of Array.from(waiting.values())) {
    if (entry.sentTo === cur) settle(entry, withScan({ error: 'query worker stopped (' + why + ')' }, entry.name, 'worker'));
  }
  scheduleQueryRespawn();
  pumpQueries();
}

// Backoff, at most 3 respawns in any hour. Past that the queries run inline
// until the next init or Rebuild.
function scheduleQueryRespawn() {
  if (qw || qwRespawnTimer !== null || stopped || state !== 'ok' || queryInline) return;
  const now = clock.now();
  qwRespawnTimes = qwRespawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS);
  if (qwRespawnTimes.length >= RESPAWN_MAX) {
    fallBackInline('it stopped more than ' + RESPAWN_MAX + ' times in an hour');
    return;
  }
  const delay = QW_RESPAWN_DELAYS_MS[qwRespawnTimes.length];
  qwRespawnTimes.push(now);
  qwRespawnTimer = laterReading(delay, 'query worker respawn', () => {
    qwRespawnTimer = null;
    if (!qw) startQueryWorker();
    pumpQueries();
  });
}

function onQueryTimeout(entry) {
  entry.timer = null;
  if (!waiting.has(entry.id)) return;
  const cur = entry.sentTo;
  settle(entry, withScan({ error: 'query timed out' }, entry.name));
  if (!cur || qw !== cur) return;
  // The worker has been inside one query for 30 s: replace it. Everything else
  // it was sent sits behind that query and has no answer either.
  logAt('warn', '[token-usage] a ' + entry.name + ' query had no answer after ' + (QUERY_TIMEOUT_MS / 1000) + ' s: replacing the query worker');
  dropQueryWorker(cur);
  for (const other of Array.from(waiting.values())) {
    if (other.sentTo === cur) settle(other, withScan({ error: 'query worker replaced after a timeout' }, other.name, 'worker'));
  }
  scheduleQueryRespawn();
  pumpQueries();
}

// Move every waiting query as far as it can go now. Safe to call at any time.
function pumpQueries() {
  if (waiting.size === 0) return;
  if (state !== 'ok' || !db) { failWaiting(unavailable().error); return; }
  if (stopped) { failWaiting('Token store unavailable: shut down'); return; }
  if (queryInline) {
    for (const entry of Array.from(waiting.values())) {
      if (entry.sentTo !== null || !waiting.has(entry.id)) continue;
      const out = inlineAnswer(entry.name, entry.q);
      settle(entry, out);
      recoverIfCorrupt(out);
    }
    return;
  }
  if (!qw) {
    if (qwRespawnTimer !== null) return;      // the backoff is running; the 30 s timer is the backstop
    startQueryWorker();                       // a failure here latches the fallback and pumps again
    return;
  }
  if (!qw.ready) return;                      // posted at hello
  const cur = qw;
  for (const entry of Array.from(waiting.values())) {
    if (entry.sentTo !== null) continue;
    try {
      cur.worker.postMessage({ type: 'query', id: entry.id, name: entry.name, q: wire(entry.q), now: clock.now() });
      entry.sentTo = cur;
    } catch (err) {
      settle(entry, withScan({ error: 'query could not be sent: ' + errMsg(err) }, entry.name, 'worker'));
    }
  }
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
    unansweredSinceMs = null;
    w.on('message', (m) => safely('worker message', () => onWorkerMessage(w, m)));
    w.on('error', (e) => safely('worker error', () => onWorkerGone(w, 'error: ' + errMsg(e))));
    w.on('exit', (code) => safely('worker exit', () => onWorkerGone(w, 'exit code ' + code)));
    // A thread that starts and never runs its file sends no error and no exit.
    // Nothing is posted to a worker before its hello, so nothing else would
    // ever notice: no walk, no scan, and a Rebuild left "already running".
    cancel(helloTimer);
    helloTimer = later(SCAN_HELLO_MS, 'scanner hello', () => {
      helloTimer = null;
      if (worker === w && !workerReady) onWorkerGone(w, 'no hello within ' + (SCAN_HELLO_MS / 1000) + ' s');
    });
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
  unansweredSinceMs = null;
  cancel(helloTimer); helloTimer = null;
  try {
    const p = w.terminate();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already gone */ }
  logAt('warn', '[token-usage] scanner worker stopped (' + why + ')');
  // Said at the FIRST death, not only when the respawns are used up: until a
  // worker says hello again nothing is scanned, and the Tokens tab shows
  // scan.reason so that frozen totals are not taken for current ones.
  scannerError = 'scanner worker stopped (' + why + ')';
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
    // The oldest request this worker has answered with nothing at all (catchupTick).
    if ((msg.type === 'walk' || msg.type === 'scan') && unansweredSinceMs === null) unansweredSinceMs = clock.now();
    return true;
  } catch (err) {
    logOnce('warn', '[token-usage] could not post to the scanner worker: ' + errMsg(err));
    return false;
  }
}

function onWorkerMessage(w, msg) {
  if (w !== worker || !msg || typeof msg !== 'object') return;
  lastWorkerMsgMs = clock.now();
  unansweredSinceMs = null;
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
  cancel(helloTimer); helloTimer = null;
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
// A row marked missing is sent the same way, with its mark. The mark is what
// lets the worker leave the path alone: without it every walk reported every
// deleted file again, and every `done` stat'ed and wrote each one again on this
// thread, for as long as the row is kept (which is until a Rebuild). The -1 is
// for the file that comes back: it is scanned even if its size and mtime are
// what the row says, and the chunk that scan posts clears the mark.
function knownFiles() {
  return S.known.all().map((r) => {
    const missing = r.missing_since !== null;
    const k = {
      rel_path: r.rel_path,
      size: (r.head_hash === null || r.scan_error !== null || missing) ? -1 : r.size,
      mtime_ms: r.mtime_ms,
      head_hash: r.head_hash,
      indexed_bytes: r.indexed_bytes,
      tail_hash: r.tail_hash,
    };
    if (missing) k.missing = true;
    return k;
  });
}

function requestWalk() {
  if (state !== 'ok' || stopped || !db) return false;
  if (!worker || !workerReady || walk) { walkWanted = true; return false; }
  const mode = getMeta('backfill_done') ? 'catchup' : 'backfill';
  const now = clock.now();
  endCascadeCycle();        // a walk is a new root event for the cascade guard
  if (!post({ type: 'walk', gen, mode, known: knownFiles() })) { walkWanted = true; return false; }
  walk = { mode, startedMs: now, level: walkLogLevel(mode) };
  walkWanted = false;
  lastWalkMs = now;
  phase = mode;
  progressDone = 0;
  progressTotal = 0;
  if (mode === 'backfill' && !getMeta('backfill_started')) setMeta('backfill_started', iso(Date.now()));
  logAt(walk.level, '[token-usage] ' + walkName(mode) + ' started');
  scheduleBroadcast();
  return true;
}

function walkName(mode) { return mode === 'backfill' ? 'backfill' : 'catch-up'; }

// Where a walk's two lines go. Every backfill, and every walk until one has
// finished since the store was opened, is at info: those are the lines to look
// for after a relaunch. The catch-up walks after that run every 10 minutes for
// as long as the app is open (about 290 lines a day at info), so they say the
// same at debug. "Until one has finished", not "the first one": a first walk
// whose worker died leaves the next walk at info too.
function walkLogLevel(mode) {
  return mode === 'backfill' || !walkDoneSinceOpen ? 'info' : 'debug';
}

// Rows in `files`, for a log line. A log line must not be what fails an open or
// a walk: a store that cannot be read shows itself at the next real statement.
function fileCount() {
  try { return S.fileStats.get().files || 0; } catch { return '?'; }
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
  if (getMeta('indexes_built') !== '1') startIndexBuild();
  logAt(walk ? walk.level : walkLogLevel(mode), '[token-usage] ' + walkName(mode) + ' done ' + fileCount() + ' files'
    + (walk ? ' in ' + (Math.max(0, clock.now() - walk.startedMs) / 1000).toFixed(1) + ' s' : ''));
  walkDoneSinceOpen = true;
  walk = null;
  phase = 'idle';
  rescanRunning = false;
  lastWalkMs = clock.now();
  scheduleBroadcast();
  if (walkWanted) requestWalk();
}

// The secondary indexes after a backfill: ONE statement per timer turn, so the
// main thread (which carries every terminal's output) is held for one index at
// a time, about 0.3 s at most on the real-size store, instead of all seven.
// Nothing depends on them meanwhile: queries and the cascade are only slower.
// indexes_built is set after the last one and nowhere else, so a quit, a
// Rebuild or a failure between two steps leaves the flag empty and the next
// `done` starts again (IF NOT EXISTS skips what is already there). The chain
// belongs to one generation and is cancelled wherever in-flight work is dropped.
function startIndexBuild() {
  if (indexTimer !== null) return;      // a chain is already running
  const forGen = gen;
  const step = (i) => {
    indexTimer = null;
    if (forGen !== gen || state !== 'ok' || !db || stopped) return;
    db.exec(INDEX_STATEMENTS[i]);
    if (i + 1 < INDEX_STATEMENTS.length) {
      indexTimer = later(0, 'index build', () => step(i + 1));
      return;
    }
    setMeta('indexes_built', '1');
  };
  indexTimer = later(0, 'index build', () => step(0));
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
// queue, and which of them used their extra reset.
//
// A file that was already fully rescanned in this cycle was applied BEFORE the
// rows were deleted just now, so what it holds of them is gone again: a
// continuation and then its original both touched in one flush leave the shared
// row with the original's placeholder line (review A3). Such a file is reset
// ONE more time per cycle. Past that the guard applies, and it applies at once
// to the file whose own rescan queued this one: two files that each own rows the
// other sighted would queue each other for ever, and going straight back cannot
// settle them (whichever is rescanned last deletes what the other added). So a
// file is fully rescanned at most twice per cycle.
// It only reads the cycle sets: they move after the commit, in applyChunkImpl.
function cascade(fileId, rel) {
  const affected = S.cascadeAffected.all(fileId, fileId);
  S.delResponses.run(fileId);
  S.delSightings.run(fileId);
  S.delCompactions.run(fileId);
  // F's own stored offset describes rows that no longer exist: reset it too, so
  // a quit before the last chunk can never resume past the deleted bytes.
  S.resetFile.run(fileId);
  const out = { queue: [], extra: [] };
  const queuedBy = cycleQueuedBy.get(rel);
  for (const a of affected) {
    if (cycleRescanned.has(a.id)) {
      if (cycleExtraReset.has(a.id) || (queuedBy && queuedBy.has(a.id))) {
        logOnce('warn', '[token-usage] cascade: ' + a.rel_path + ' was already rescanned in this cycle; not queued again');
        continue;
      }
      out.extra.push(a.id);
    }
    S.resetFile.run(a.id);
    out.queue.push(a.rel_path);
  }
  return out;
}

// One chunk = one transaction (better-sqlite3 transactions are synchronous, so
// BEGIN is never held across an event-loop turn; the handle also serves queries).
function applyChunkRows(a) {
  const out = { fileId: null, fullRescan: false, queue: [], extra: [], written: 0, rejected: 0, sessions: [] };
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
    if (a.fullRescan && before) {
      const c = cascade(out.fileId, a.rel);
      out.queue = c.queue;
      out.extra = c.extra;
    }
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
  if (!rel) {
    // Refused, but answered: the worker posts one chunk at a time and waits for
    // its ack, so a refusal without one would stop it for good. (A stale
    // generation above needs none: the worker ignores acks of another
    // generation and releases its own wait when the generation moves.)
    ack(msg, true);
    return { error: 'bad request: a chunk needs rel_path' };
  }

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
  for (const id of res.extra) cycleExtraReset.add(id);
  for (const q of res.queue) {
    let by = cycleQueuedBy.get(q);
    if (!by) { by = new Set(); cycleQueuedBy.set(q, by); }
    by.add(res.fileId);
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

// The order of a flush. A path the watcher reported keeps its place. The paths
// the cascade queued are put oldest file first (birth time, then path: the
// order a backfill scans main files in) into the places such paths held.
// Queue order is the order the rescans happened in, and for a chain touched
// newest first (C2, C1, O: C2 continues C1, C1 continues O) that puts C2 before
// C1. C1's rescan then deletes the rows it owns after C2 was applied, C2 has
// had its one extra reset, and those rows kept C1's line until a Rebuild.
// Oldest first, each file is rescanned behind the file whose rows it copied.
// Only the order changes: the same paths are sent, and cascade() decides what
// is reset and queued exactly as before.
function cascadeOldestFirst(batch) {
  if (cascadePending.size < 2) return batch;
  const slots = [];
  const queued = [];
  for (let i = 0; i < batch.length; i++) {
    if (!cascadePending.has(batch[i])) continue;
    const row = S.fileByPath.get(batch[i]);
    slots.push(i);
    queued.push({ rel: batch[i], birth: row && isNum(row.birthtime_ms) ? row.birthtime_ms : Infinity });
  }
  queued.sort((a, b) => (a.birth < b.birth ? -1 : a.birth > b.birth ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (let i = 0; i < slots.length; i++) batch[slots[i]] = queued[i].rel;
  return batch;
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

  // One cascade cycle resets a file at most twice (see cascade()): the cycle
  // ends at the first flush that carries no cascade-queued path.
  let carriesCascade = false;
  for (const rel of pending) {
    if (cascadePending.has(rel)) { carriesCascade = true; break; }
  }
  if (!carriesCascade) endCascadeCycle();

  const batch = cascadeOldestFirst(Array.from(pending));
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
  const now = clock.now();
  if (walk && now - lastWorkerMsgMs > WORKER_SILENT_MS) {
    onWorkerGone(worker, 'no message for 10 minutes during a walk');
    return;
  }
  // The same for a scan request, which has no `walk` state: a request was
  // posted, and since then the worker has sent nothing for 10 minutes. A
  // healthy worker answers the walk of every tick, so this cannot age.
  if (unansweredSinceMs !== null && now - unansweredSinceMs >= WORKER_SILENT_MS) {
    onWorkerGone(worker, 'no message for 10 minutes after a request');
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
    // Why it is off, for the Tokens tab's way back: 'kill-switch' offers "turn
    // on", 'failure' offers "Try again" (enable() re-runs init).
    reasonCode: ok ? null : reasonCode(),
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
    files: null,                 // rows in the files table; null while the store is not open
    queryMode: queryMode(),      // 'worker' | 'inline': where the next query runs
  };
  if (!ok) return o;
  const f = S.fileStats.get();
  o.files = f.files || 0;
  o.filesWithErrors = f.errs || 0;
  o.filesMissing = f.missing || 0;
  o.linesSkipped = f.skipped || 0;
  o.lastScanMs = f.lastScan === null || f.lastScan === undefined ? null : f.lastScan;
  o.backfillDone = getMeta('backfill_done') || null;
  const lastCatchup = Date.parse(getMeta('last_catchup') || '');
  o.lastCatchupMs = Number.isFinite(lastCatchup) ? lastCatchup : null;
  return o;
}

// One query. Returns the answer (inline, or when there is nothing to ask) or a
// Promise for it (the worker); guardQuery turns both into a Promise that
// resolves.
function runQuery(name, q) {
  if (state !== 'ok' || !db) return Object.assign(unavailable(), { scan: scanForAnswer() });
  // After shutdown() the store stays readable until close(), on this thread:
  // the app is quitting and no worker is started for that.
  if (stopped || queryInline) {
    const out = inlineAnswer(name, q);
    recoverIfCorrupt(out);
    return out;
  }
  if (waiting.size >= WAITING_MAX) {
    return { error: 'Token store busy: ' + WAITING_MAX + ' queries are already waiting', scan: scanForAnswer() };
  }
  qwUsed = true;
  return new Promise((resolve) => {
    const entry = { id: ++querySeq, name, q, resolve, timer: null, sentTo: null };
    waiting.set(entry.id, entry);
    try {
      entry.timer = laterReading(QUERY_TIMEOUT_MS, 'query timeout', () => onQueryTimeout(entry));
      pumpQueries();
    } catch (err) {
      settle(entry, queryFailure(name, err));
    }
  });
}

// The tab says which loads are an opening (or something the user asked for:
// a range change, Rebuild, Enable, Try again) with `opened: true`. Its quiet
// refreshes, one every few seconds while a session writes, carry no flag: taken
// for openings they walked the whole projects tree about once a minute.
function isOpening(q) {
  try { return !!q && typeof q === 'object' && q.opened === true; } catch { return false; }
}

function summaryImpl(q) {
  // "Tokens tab opened": a catch-up walk if the last one is older than 60 s.
  if (isOpening(q) && state === 'ok' && !stopped && !walk && clock.now() - lastWalkMs > CATCHUP_ON_OPEN_MS) {
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
  // Queries (each: the design section 4 shape plus `scan`, or { error, scan }).
  // Asynchronous: a Promise that always resolves and never rejects.
  summary: guardQuery('summary', summaryImpl),
  models: guardQuery('models', (q) => runQuery('models', q)),
  daily: guardQuery('daily', (q) => runQuery('daily', q)),
  sessions: guardQuery('sessions', (q) => runQuery('sessions', q)),
  context: guardQuery('context', (q) => runQuery('context', q)),
  // For tests and for the queries module's tests.
  createSchema: plain((handle) => { createSchema(handle); return { ok: true }; }),
  createIndexes: plain((handle) => { createIndexes(handle); return { ok: true }; }),
  localDay: plain(localDay),
  dayList: plain(dayList),
  applyChunk: guard('applyChunk', applyChunkImpl, true),
  _handle: () => db,
  _gen: () => gen,
};
