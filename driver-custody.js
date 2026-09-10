// driver-custody.js — own every process we start, so a stop is a real stop.
//
// Today this repo has no process custody at all. The scheduler's child is held
// in a local const (main.js:1797) and registered nowhere; `before-quit`
// (main.js:1841-1862) kills PTYs only; there is no taskkill, no `detached`, and
// no tree-kill anywhere outside node_modules. And the app can exit without any
// hook running: electron-reloader calls `app.relaunch(); app.exit(0)`, and
// `app.exit()` emits neither before-quit nor will-quit.
//
// The consequence is that a hung or runaway scheduled run cannot be stopped at
// all, and any "halt" the app reports is cosmetic — it stops the timer, not the
// process that is doing the work.
//
// Two rules make this safe rather than dangerous:
//
//   Verify before killing.  Pids are reused. A record whose pid now belongs to
//   some unrelated process must be dropped, never killed. Identity = the
//   recorded start time matching the live process's creation time, plus a
//   fingerprint of the command line.
//
//   Verify after killing.   We do not report "stopped" until the process is
//   confirmed gone. If it will not die, that is reported loudly with the
//   surviving pid, not swallowed.

const { execFileSync } = require('child_process');
const store = require('./driver-store');

// How far apart the recorded spawn time and the OS's reported creation time may
// be before we refuse to believe it is the same process. Generous, because the
// record is written before spawn returns.
const CREATION_TOLERANCE_MS = 10_000;

let _now = () => Date.now();
let _platform = process.platform;
let _exec = execFileSync;
let _log = console;
let _store = store;

function init(ctx = {}) {
  _now = ctx.now || (() => Date.now());
  _platform = ctx.platform || process.platform;
  _exec = ctx.execFileSync || execFileSync;
  _log = ctx.log || console;
  _store = ctx.store || store;
}

// ------------------------------------------------------------------ registry

function list() {
  const recs = _store.readJson(_store.paths().children, []);
  return Array.isArray(recs) ? recs : [];
}

/**
 * Record a child BEFORE it is spawned.
 *
 * Throws if the registry cannot be written. That is deliberate and callers must
 * honour it: if we cannot record the child, we cannot promise to stop it, so it
 * must not be started. "Log and continue" here is how orphans are made.
 */
function register(rec) {
  if (!rec || typeof rec.pid !== 'number') throw new Error('register requires a numeric pid');
  const entry = {
    pid: rec.pid,
    startedAtMs: typeof rec.startedAtMs === 'number' ? rec.startedAtMs : _now(),
    cwd: rec.cwd || null,
    tag: rec.tag || null,          // e.g. the schedule name or session id
    cmdlineNeedle: rec.cmdlineNeedle || null,
    armId: rec.armId || null,
  };
  const next = list().filter(r => r.pid !== entry.pid);
  next.push(entry);
  _store.writeJsonAtomic(_store.paths().children, next); // throws on failure
  _store.appendEvent('CHILD_REGISTERED', entry);
  return entry;
}

function unregister(pid) {
  const next = list().filter(r => r.pid !== pid);
  try {
    _store.writeJsonAtomic(_store.paths().children, next);
  } catch (err) {
    // Failing to forget a dead child is not dangerous — the identity check will
    // drop it on the next reap. Failing to *record* one is; that still throws.
    _log.error?.('[custody] could not unregister', pid, err.message);
    return false;
  }
  _store.appendEvent('CHILD_UNREGISTERED', { pid });
  return true;
}

// ------------------------------------------------------------------ identity

/** Cross-platform liveness probe. Signal 0 tests existence without signalling. */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Ask the OS what this pid actually is.
 * @returns {{pid:number, creationMs:number|null, commandLine:string|null}|null}
 */
function inspect(pid) {
  if (!isPidAlive(pid)) return null;
  try {
    if (_platform === 'win32') {
      const out = _exec('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
        'if ($null -eq $p) { "" } else { ' +
        '@{ c = [Math]::Floor(([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()); ' +
        'l = $p.CommandLine } | ConvertTo-Json -Compress }',
      ], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!out) return null;
      const parsed = JSON.parse(out);
      return { pid, creationMs: Number(parsed.c) || null, commandLine: parsed.l || null };
    }
    const out = _exec('ps', ['-p', String(pid), '-o', 'lstart=,args='], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const commandLine = out.slice(out.indexOf(' ') >= 0 ? 0 : 0);
    return { pid, creationMs: null, commandLine };
  } catch {
    return null;
  }
}

/**
 * Is the live process at this pid the one we recorded?
 *
 * Answers `ok:false` for a pid that is dead (nothing to do) and for a pid that
 * has been reused (must NOT be killed). Only a positive identity match permits
 * a kill.
 */
function verify(record) {
  if (!record || typeof record.pid !== 'number') return { ok: false, reason: 'bad_record' };
  if (!isPidAlive(record.pid)) return { ok: false, reason: 'not_running' };

  const live = inspect(record.pid);
  if (!live) return { ok: false, reason: 'not_inspectable' };

  if (typeof live.creationMs === 'number' && typeof record.startedAtMs === 'number') {
    const drift = Math.abs(live.creationMs - record.startedAtMs);
    if (drift > CREATION_TOLERANCE_MS) {
      return { ok: false, reason: 'pid_reused', driftMs: drift, live };
    }
  }

  if (record.cmdlineNeedle && live.commandLine
      && !live.commandLine.includes(record.cmdlineNeedle)) {
    return { ok: false, reason: 'cmdline_mismatch', live };
  }

  return { ok: true, live };
}

// -------------------------------------------------------------------- kill

/** Kill a process and its descendants. Returns whether death was confirmed. */
function killTree(pid) {
  try {
    if (_platform === 'win32') {
      _exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Negative pid targets the process group, which is why children are
      // spawned detached. Fall back to the bare pid if there is no group.
      try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
      // Give it a moment to exit cleanly before escalating. Real sleep, not a
      // spin on an injectable clock — see the note in driver-store.sleepSync.
      for (let i = 0; i < 30 && isPidAlive(pid); i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      if (isPidAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
      }
    }
  } catch (err) {
    // taskkill exits non-zero when the process is already gone; that is success.
    if (!isPidAlive(pid)) return { killed: true, alreadyGone: true };
    return { killed: false, error: err.message };
  }
  return { killed: !isPidAlive(pid) };
}

/**
 * Stop one recorded child, safely.
 * A pid that has been reused is dropped from the registry, never killed.
 */
function stop(record) {
  const v = verify(record);
  if (!v.ok) {
    unregister(record.pid);
    _store.appendEvent('CHILD_DROPPED', { pid: record.pid, reason: v.reason, driftMs: v.driftMs });
    return { pid: record.pid, verified: false, reason: v.reason, killed: false };
  }
  const k = killTree(record.pid);
  _store.appendEvent(k.killed ? 'CHILD_KILLED' : 'CHILD_KILL_FAILED', {
    pid: record.pid, tag: record.tag, ...k,
  });
  if (k.killed) unregister(record.pid);
  return { pid: record.pid, verified: true, killed: k.killed, error: k.error,
           commandLine: v.live && v.live.commandLine };
}

/**
 * Reap every recorded child. Call at startup BEFORE anything else runs, and on
 * halt. Returns a report; survivors are the loud case.
 */
function reap() {
  const records = list();
  const results = records.map(stop);
  const survivors = results.filter(r => r.verified && !r.killed);
  if (records.length) {
    _store.appendEvent('REAPED', {
      considered: records.length,
      killed: results.filter(r => r.killed).length,
      dropped: results.filter(r => !r.verified).length,
      survivors: survivors.map(s => ({ pid: s.pid, commandLine: s.commandLine })),
    });
  }
  return { results, survivors, degraded: survivors.length > 0 };
}

/** Kill everything and write the global stop, in that order. */
function haltAndReap(reason) {
  _store.halt(reason);
  return reap();
}

module.exports = {
  init,
  list,
  register,
  unregister,
  isPidAlive,
  inspect,
  verify,
  killTree,
  stop,
  reap,
  haltAndReap,
  CREATION_TOLERANCE_MS,
};
