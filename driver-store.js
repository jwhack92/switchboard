// driver-store.js — durable, machine-wide state for the scheduler and driver.
//
// Three jobs, all of which the app needs today, before any driver exists:
//
//   HALT       A global stop. There is currently no way to stop all scheduled
//              runs at once; `stopScheduler()` only stops the timer, and cannot
//              be reached at all if the app is wedged. A file on disk can be
//              written by anything — a script, a phone syncing a folder, a
//              scheduled task — and is checked synchronously before every spawn.
//
//   Atomic     tmp + rename writes with bounded retries. On Windows, renameSync
//   writes     over an existing destination throws EPERM/EBUSY routinely
//              (Defender, OneDrive, backup agents). The conventional
//              `try {...} catch (e) { log.warn(e) }` shape silently freezes
//              whatever the file was tracking, so write failure is raised, not
//              logged, and callers are expected to treat it as halt-class.
//
//   Events     Append-only JSONL, so a wedged process still leaves a record.
//
// The directory is deliberately MACHINE-WIDE, not under SWITCHBOARD_DATA_DIR.
// A dev instance (`npm run electron-dev`) and the installed app must share one
// HALT file and one lock — otherwise the kill switch reaches only one of them.

const fsDefault = require('fs');
const path = require('path');
const os = require('os');

const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = [10, 25, 60, 150, 350];

/**
 * A real synchronous sleep. Deliberately not a spin loop on Date.now(): these
 * calls sit immediately before a spawn, so blocking is correct here, but
 * burning a core for it is not — and a spin keyed off an injectable clock never
 * terminates under a frozen test clock.
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let _fs = fsDefault;
let _now = () => Date.now();
let _log = console;
let _dir = null;

function defaultDir() {
  // LOCALAPPDATA on Windows; a dotdir elsewhere. Never under the Electron
  // userData dir and never under SWITCHBOARD_DATA_DIR — see the note above.
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : os.homedir();
  return process.platform === 'win32'
    ? path.join(base, 'switchboard-driver')
    : path.join(base, '.switchboard-driver');
}

function init(ctx = {}) {
  _fs = ctx.fs || fsDefault;
  _now = ctx.now || (() => Date.now());
  _log = ctx.log || console;
  _dir = ctx.dir || defaultDir();
  try {
    if (!_fs.existsSync(_dir)) _fs.mkdirSync(_dir, { recursive: true });
  } catch (err) {
    // Not fatal here: isHalted() fails closed, so an unusable directory stops
    // spawning rather than silently allowing it.
    _log.error?.('[driver-store] cannot create', _dir, err.message);
  }
  return _dir;
}

function dir() {
  if (!_dir) init();
  return _dir;
}

const paths = () => ({
  dir: dir(),
  halt: path.join(dir(), 'HALT'),
  lock: path.join(dir(), 'LOCK'),
  children: path.join(dir(), 'children.json'),
  events: path.join(dir(), 'events.jsonl'),
  arm: path.join(dir(), 'arm.json'),
});

// ------------------------------------------------------------------ HALT

/**
 * Is a global stop in force? Synchronous by design — it is checked immediately
 * before every spawn, and an async check there would be a TOCTOU window.
 *
 * Fails CLOSED: a file that exists but cannot be read counts as halted. The
 * only state that permits spawning is a file that is definitively absent.
 *
 * @returns {{halted: boolean, reason: string|null, since: number|null}}
 */
function isHalted() {
  const p = paths().halt;
  let raw;
  try {
    raw = _fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { halted: false, reason: null, since: null };
    // Permissions, a locked file, a corrupt directory — anything else means we
    // cannot prove the halt is absent, so we act as if it is present.
    return { halted: true, reason: `unreadable: ${err.message}`, since: null };
  }
  const firstLine = String(raw).split('\n')[0].trim();
  let since = null;
  try { since = _fs.statSync(p).mtimeMs; } catch {}
  return { halted: true, reason: firstLine || 'halted', since };
}

/** Write the global stop. Idempotent; an existing HALT keeps its original reason. */
function halt(reason, { overwrite = false } = {}) {
  const p = paths().halt;
  const existing = isHalted();
  if (existing.halted && !overwrite) return existing;
  const body = `${String(reason || 'halted').split('\n')[0]}\n${new Date(_now()).toISOString()}\n`;
  _fs.writeFileSync(p, body, 'utf8');
  appendEvent('HALT', { reason });
  return isHalted();
}

/** Clear the global stop. Callers should require an explicit confirmation. */
function clearHalt() {
  const p = paths().halt;
  try {
    _fs.unlinkSync(p);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  appendEvent('HALT_CLEARED', {});
  return isHalted();
}

// ------------------------------------------------------------ atomic write

/**
 * Write JSON atomically. Throws if it cannot — deliberately.
 *
 * A caller tracking anything that bounds cost must treat a throw here as
 * halt-class: if the counter cannot be persisted, the bound is not real.
 */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  const data = JSON.stringify(obj, null, 2);
  _fs.writeFileSync(tmp, data, 'utf8');

  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      _fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      lastErr = err;
      // EPERM/EBUSY on Windows is a scanner holding the destination open; it
      // clears on its own within a few hundred ms. Anything else will not.
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      sleepSync(RENAME_BACKOFF_MS[Math.min(attempt, RENAME_BACKOFF_MS.length - 1)]);
    }
  }
  try { _fs.unlinkSync(tmp); } catch {}
  const e = new Error(`atomic write failed for ${file}: ${lastErr && lastErr.message}`);
  e.code = 'ATOMIC_WRITE_FAILED';
  e.cause = lastErr;
  throw e;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(_fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ events

/** Append one event. Never throws — losing a log line must not stop a halt. */
function appendEvent(type, data = {}) {
  try {
    const line = JSON.stringify({ t: new Date(_now()).toISOString(), type, ...data });
    _fs.appendFileSync(paths().events, line + '\n', 'utf8');
  } catch (err) {
    _log.error?.('[driver-store] event log write failed:', err.message);
  }
}

function readEvents({ limit = 500 } = {}) {
  let raw;
  try { raw = _fs.readFileSync(paths().events, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  const out = [];
  for (const l of tail) {
    try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
  }
  return out;
}

// ------------------------------------------------------------------- lock

/**
 * Acquire the machine-wide single-instance lock.
 *
 * `wx` is the point: the OS decides the winner, so two processes racing cannot
 * both win. A stale lock is breakable only after its recorded pid is confirmed
 * dead — never on a timeout heuristic, which two simultaneously-starting
 * processes both pass.
 *
 * @param {(pid:number)=>boolean} isPidAlive
 */
function acquireLock(isPidAlive) {
  const p = paths().lock;
  const payload = JSON.stringify({ pid: process.pid, startedAtMs: _now() });
  try {
    const fd = _fs.openSync(p, 'wx');
    _fs.writeFileSync(fd, payload, 'utf8');
    _fs.closeSync(fd);
    return { ok: true, held: true };
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return { ok: false, reason: err && err.message };
  }
  const existing = readJson(p, null);
  if (!existing || typeof existing.pid !== 'number') {
    return { ok: false, reason: 'lock held by an unreadable record' };
  }
  if (existing.pid === process.pid) return { ok: true, held: true, reentrant: true };
  if (isPidAlive && isPidAlive(existing.pid)) {
    return { ok: false, reason: `lock held by live pid ${existing.pid}`, pid: existing.pid };
  }
  // Recorded holder is gone: break and retake.
  try { _fs.unlinkSync(p); } catch {}
  appendEvent('LOCK_BROKEN', { deadPid: existing.pid });
  return acquireLock(isPidAlive);
}

function releaseLock() {
  const p = paths().lock;
  const existing = readJson(p, null);
  if (existing && existing.pid !== process.pid) return false;
  try { _fs.unlinkSync(p); } catch {}
  return true;
}

module.exports = {
  init,
  paths,
  defaultDir,
  isHalted,
  halt,
  clearHalt,
  writeJsonAtomic,
  readJson,
  appendEvent,
  readEvents,
  acquireLock,
  releaseLock,
};
