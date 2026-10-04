'use strict';
const { parentPort, workerData, isMainThread } = require('worker_threads');

/**
 * Token query worker. Answers the Tokens tab's five queries off the main
 * thread: better-sqlite3 is synchronous, the main process also carries every
 * terminal's output, and one query over the real-size store takes 0.15-0.7 s.
 *
 * One long-lived worker, `workerData = { dbPath, signal[, ctxDir, handoffsDir, busyTimeoutMs] }`.
 * It opens the store READ-ONLY (it never creates the file and never writes),
 * and requires ../token-usage-queries and ../token-prices itself, so THIS
 * thread's copy of both is re-read at every spawn: the SQL and the arithmetic
 * of a query are new after the next spawn of this worker (Disable then Enable
 * on the Tokens tab, a worker that died, or Rebuild, which also empties the
 * store) with no app restart.
 * That is half of the queries module. The main process loads its own copy of
 * ../token-usage-queries (token-usage.js: decorateResult and wireRequest on
 * every answer, and every query when the fallback runs them inline) and of
 * ../token-prices (scan.pricesVersion, and the inline fallback). Main's copies
 * are loaded once, at the first Tokens query of the process, and change only
 * with an app restart. A fix to a field both sides touch therefore runs new
 * here and old there until the restart.
 *
 * Messages.
 *   worker -> main  { type: 'hello', ok: true }
 *   worker -> main  { type: 'hello', ok: false, error }      the store could not be opened
 *   main -> worker  { type: 'query', id, name, q, now }      now = the store's clock, for "today"
 *   worker -> main  { type: 'result', id, result, ms }       result: the queries module's answer, or { error[, code] }
 *   main -> worker  { type: 'close' }
 *   worker -> main  { type: 'closed' }
 *
 * `signal` is a SharedArrayBuffer of two int32:
 *   [0] closing: main sets 1. No query is started after that; the connection is
 *       closed at the next message instead, whatever the message is.
 *   [1] closed: the worker sets 1 (and notifies) once its connection is closed
 *       or was never opened.
 * Why shared memory and not only the 'closed' message: on Windows an open
 * handle blocks deleting or renaming the database file, and the store deletes
 * it synchronously (Rebuild, a schema change, a corrupt file). Main waits on
 * [1] with Atomics.wait, which a message could not satisfy because main is not
 * reading messages while it waits.
 *
 * Nothing here ends the thread: every failure becomes an { error } answer.
 * The lookups that need the main process (session titles, project paths,
 * running sessions) are not done here; the store runs decorateResult on the
 * answer.
 *
 * Exports `createResponder` so the message handling can be driven without a
 * thread. Requiring this file outside a worker does nothing.
 */

const SIG_CLOSING = 0;
const SIG_CLOSED = 1;
const QUERY_NAMES = ['summary', 'models', 'daily', 'sessions', 'context'];
const DEFAULT_BUSY_MS = 5000;

function errText(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

function signalOf(buf) {
  try {
    if (typeof SharedArrayBuffer === 'undefined' || !(buf instanceof SharedArrayBuffer)) return null;
    return buf.byteLength >= 8 ? new Int32Array(buf) : null;
  } catch {
    return null;
  }
}

/**
 * opts = { data, post(msg), Database }
 *   data      the workerData object.
 *   post      sends one message to the store.
 *   Database  test seam: the better-sqlite3 constructor.
 * Returns { hello(), handle(msg), isOpen() }.
 */
function createResponder(opts) {
  const data = opts.data && typeof opts.data === 'object' ? opts.data : {};
  const signal = signalOf(data.signal);
  let db = null;
  let queries = null;
  let closed = false;
  let nowMs = null;         // the store's clock for the query being answered

  function post(msg) {
    try {
      opts.post(msg);
      return true;
    } catch {
      return false;
    }
  }

  function closing() {
    return closed || (signal !== null && Atomics.load(signal, SIG_CLOSING) === 1);
  }

  // Idempotent. The flag is raised even when close() threw: main must not wait
  // for a confirmation that can never come, and its own delete has a fallback.
  function closeNow() {
    closed = true;
    const handle = db;
    db = null;
    queries = null;
    if (handle) {
      try { handle.close(); } catch { /* already closed or broken */ }
    }
    if (signal !== null) {
      try {
        Atomics.store(signal, SIG_CLOSED, 1);
        Atomics.notify(signal, SIG_CLOSED);
      } catch { /* nothing to tell */ }
    }
  }

  // Returns null, or the reason the store could not be opened.
  function open() {
    if (closing()) {
      closeNow();
      return 'closed before it opened';
    }
    try {
      if (typeof data.dbPath !== 'string' || data.dbPath === '') throw new Error('no database path');
      const Database = opts.Database || require('better-sqlite3');
      const busy = Number.isInteger(data.busyTimeoutMs) && data.busyTimeoutMs >= 0 ? data.busyTimeoutMs : DEFAULT_BUSY_MS;
      // readonly + fileMustExist: this thread can neither create the file nor
      // change it. `timeout` is the busy timeout.
      db = new Database(data.dbPath, { readonly: true, fileMustExist: true, timeout: busy });
      db.pragma('query_only = 1');
      // A file without the schema is not a store this worker should answer for:
      // an empty answer would look like "no usage".
      const tables = db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('responses', 'compactions')").get();
      if (!tables || tables.n !== 2) throw new Error('the store has no schema yet');
      const mod = require('../token-usage-queries');
      const prices = require('../token-prices');
      const deps = { prices, now: () => (nowMs === null ? Date.now() : nowMs) };
      if (typeof data.ctxDir === 'string' && data.ctxDir) deps.ctxDir = data.ctxDir;
      if (typeof data.handoffsDir === 'string' && data.handoffsDir) deps.handoffsDir = data.handoffsDir;
      // No sessionInfo / folderMeta / isRunning: those live in the main process.
      queries = mod.createQueries(db, deps);
      if (!queries || typeof queries !== 'object') throw new Error('createQueries returned nothing');
      return null;
    } catch (err) {
      closeNow();
      return errText(err);
    }
  }

  function hello() {
    const error = open();
    post(error === null ? { type: 'hello', ok: true } : { type: 'hello', ok: false, error });
  }

  function answer(msg) {
    if (closing()) {
      closeNow();
      return { error: 'query worker closed' };
    }
    if (!queries) return { error: 'query worker has no open store' };
    if (typeof msg.name !== 'string' || QUERY_NAMES.indexOf(msg.name) === -1) {
      return { error: 'bad request: unknown query' };
    }
    const fn = queries[msg.name];
    if (typeof fn !== 'function') return { error: 'Token store unavailable: no ' + msg.name + ' query' };
    nowMs = typeof msg.now === 'number' && Number.isFinite(msg.now) ? msg.now : null;
    try {
      const res = fn.call(queries, msg.q);
      return res && typeof res === 'object' ? res : { error: 'Token store unavailable: bad ' + msg.name + ' result' };
    } finally {
      nowMs = null;
    }
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') {
      closeNow();
      post({ type: 'closed' });
      return;
    }
    if (msg.type !== 'query') return;
    const started = Date.now();
    let result;
    try {
      result = answer(msg);
    } catch (err) {
      result = { error: 'query failed: ' + errText(err) };
      // With its code, as the queries module's own guard does: the store reads
      // it to tell a corrupt file (which it renames away) from any other failure.
      if (err && typeof err.code === 'string' && err.code) result.code = err.code;
    }
    const sent = post({ type: 'result', id: msg.id, result, ms: Date.now() - started });
    // An answer that cannot be cloned must still be an answer.
    if (!sent) post({ type: 'result', id: msg.id, result: { error: 'query failed: the answer could not be posted' }, ms: Date.now() - started });
  }

  return { hello, handle, isOpen: () => db !== null };
}

if (!isMainThread && parentPort) {
  const responder = createResponder({ data: workerData, post: (msg) => parentPort.postMessage(msg) });
  // Listener first: a query posted while the store is being opened is queued
  // by the port and answered after hello.
  parentPort.on('message', responder.handle);
  responder.hello();
}

module.exports = { createResponder, QUERY_NAMES, SIG_CLOSING, SIG_CLOSED };
