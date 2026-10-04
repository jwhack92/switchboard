'use strict';
// Token store rehearsal (build contract D6). Dev only; the app never loads this.
//
// Runs the REAL store, worker and parser once over a transcript tree into a
// SCRATCH database and prints counts: wall time, files scanned, files with
// errors, database size and status(). It never prints transcript text, and it
// opens the transcripts read-only (the parser opens every file with 'r').
//
// better-sqlite3 is built for Electron's ABI, so this runs under Electron as
// Node (bash):
//   D=<a fresh folder under the temp dir>
//   ELECTRON_RUN_AS_NODE=1 SWITCHBOARD_DATA_DIR="$D" \
//     "C:/Users/jhack/Bitbucket/switchboard/node_modules/electron/dist/electron.exe" \
//     scripts/token-rehearsal.js --data-dir "$D"
//
// Options:
//   --data-dir <path>      REQUIRED. Refused unless it resolves to a folder
//                          under os.tmpdir(), is not ~/.switchboard (or inside
//                          it), SWITCHBOARD_DATA_DIR names the same folder, and
//                          it holds no token-usage.db yet.
//   --projects-dir <path>  the transcript tree (default ~/.claude/projects)
//   --timeout-min <n>      give up after n minutes (default 60)
//   --json                 one JSON object on stdout instead of text
//
// Exit code: 0 = the backfill finished, 1 = it did not (timeout, store
// disabled), 2 = refused or bad arguments.
//
// Afterwards, compare with the independent recount (design 7.4):
//   scripts/token-baseline.js --db <data-dir>/token-usage.db --cutoff-ms <ms>

const fs = require('fs');
const os = require('os');
const path = require('path');

const POLL_MS = 250;
const SETTLE_ROUNDS_MAX = 40;
const SETTLE_WAIT_MS = 1500;
const INDEX_WAIT_MS = 60000;    // longest wait for the index chain before the counts are taken

function usage() {
  return 'usage: token-rehearsal.js --data-dir <path under the temp dir> [--projects-dir <path>] [--timeout-min <n>] [--json]';
}

function parseArgs(argv) {
  const out = { dataDir: null, projectsDir: null, timeoutMin: 60, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const value = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(name + ' needs a value');
      return argv[i];
    };
    if (name === '--json') out.json = true;
    else if (name === '--help' || name === '-h') out.help = true;
    else if (name === '--data-dir') out.dataDir = value();
    else if (name === '--projects-dir') out.projectsDir = value();
    else if (name === '--timeout-min') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0 || n > 600) throw new Error('--timeout-min must be a number of minutes between 0 and 600');
      out.timeoutMin = n;
    } else throw new Error('unknown option ' + JSON.stringify(arg));
  }
  return out;
}

// The deepest existing ancestor, resolved through links, plus the part that
// does not exist yet: a junction inside the temp dir cannot lead outside it.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function isInside(child, parent) {
  const c = fold(path.resolve(child));
  const p = fold(path.resolve(parent));
  return c === p || c.startsWith(p + path.sep);
}

// → the resolved data dir, or throws with the reason it was refused.
function checkDataDir(raw, env) {
  if (typeof raw !== 'string' || raw === '') throw new Error('--data-dir is required');
  const dataDir = realish(raw);
  const tmp = realish(os.tmpdir());
  const real = realish(path.join(os.homedir(), '.switchboard'));
  if (isInside(dataDir, real) || isInside(real, dataDir)) {
    throw new Error('refused: ' + dataDir + ' is (or contains) the real ~/.switchboard');
  }
  if (!isInside(dataDir, tmp) || fold(dataDir) === fold(tmp)) {
    throw new Error('refused: ' + dataDir + ' is not a folder under the temp dir ' + tmp);
  }
  // Contract rule 5: the environment must name the same folder, so nothing in
  // this process can fall back to the real one.
  const fromEnv = env.SWITCHBOARD_DATA_DIR;
  if (!fromEnv) throw new Error('refused: SWITCHBOARD_DATA_DIR is not set; set it to the same folder as --data-dir');
  if (fold(realish(fromEnv)) !== fold(dataDir)) {
    throw new Error('refused: SWITCHBOARD_DATA_DIR (' + realish(fromEnv) + ') is not the --data-dir folder (' + dataDir + ')');
  }
  if (fs.existsSync(path.join(dataDir, 'token-usage.db'))) {
    throw new Error('refused: ' + dataDir + ' already holds a token-usage.db; a rehearsal needs a fresh folder (a second run would be a catch-up, not a backfill)');
  }
  if (fs.existsSync(path.join(dataDir, 'token-usage.off'))) {
    throw new Error('refused: ' + dataDir + ' holds token-usage.off (the kill switch); use a fresh folder');
  }
  return dataDir;
}

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function dbBytes(dataDir) {
  const base = path.join(dataDir, 'token-usage.db');
  return { db: sizeOf(base), wal: sizeOf(base + '-wal'), shm: sizeOf(base + '-shm') };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The secondary indexes are built one statement per timer turn after the
// backfill's `done` (token-usage.js, startIndexBuild: about a second in all on
// the real-size store), so a count taken right after the walk can see fewer
// than seven. Wait until meta.indexes_built is '1', for at most timeoutMs.
// Sleeping between reads is also what lets the chain's timers run.
// `readFlag()` returns the stored value. → { built, waitedMs } (plus `error`
// when the flag could not be read: there is then nothing to wait for).
async function waitForIndexes(readFlag, opts) {
  const o = opts || {};
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : INDEX_WAIT_MS;
  const pollMs = typeof o.pollMs === 'number' ? o.pollMs : POLL_MS;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const nap = typeof o.sleep === 'function' ? o.sleep : sleep;
  const t0 = now();
  for (;;) {
    let value;
    try {
      value = readFlag();
    } catch (err) {
      return { built: false, waitedMs: now() - t0, error: err && err.message ? err.message : String(err) };
    }
    const waitedMs = now() - t0;
    if (value === '1') return { built: true, waitedMs };
    if (waitedMs >= timeoutMs) return { built: false, waitedMs };
    await nap(pollMs);
  }
}

async function run(args) {
  const dataDir = checkDataDir(args.dataDir, process.env);
  const projectsDir = path.resolve(args.projectsDir || path.join(os.homedir(), '.claude', 'projects'));
  if (!fs.existsSync(projectsDir)) throw new Error('refused: no projects dir at ' + projectsDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const logs = { info: 0, warn: 0, error: 0, debug: 0 };
  const firstLines = [];
  const log = {};
  for (const level of Object.keys(logs)) {
    log[level] = (m) => {
      logs[level] += 1;
      // Store and worker messages name paths and error codes, never transcript
      // text (workers/scan-tokens.js describe()). Kept short all the same.
      if ((level === 'warn' || level === 'error') && firstLines.length < 12) firstLines.push(level + ': ' + String(m).slice(0, 240));
    };
  }
  let broadcasts = 0;

  const store = require(path.join(__dirname, '..', 'token-usage.js'));
  const tInit = Date.now();
  const started = store.init({
    log,
    broadcast: () => { broadcasts += 1; },
    projectsDir,
    dataDir,
    appVersion: 'rehearsal',
    workerPath: path.join(__dirname, '..', 'workers', 'scan-tokens.js'),
  });
  if (!started || started.error || started.state !== 'ok') {
    throw new Error('init did not open the store: ' + JSON.stringify(started));
  }
  const dbFile = path.join(dataDir, 'token-usage.db');
  if (!isInside(store._handle().name, dataDir)) throw new Error('the store opened ' + store._handle().name + ', not a file in ' + dataDir);

  // The backfill starts by itself on the store's deferred timer (10 s after
  // init), exactly as it does in the app.
  const deadline = tInit + args.timeoutMin * 60 * 1000;
  let tWalk = null;
  let tDone = null;
  let lastShown = 0;
  let finished = false;
  for (;;) {
    const s = store.status();
    if (!s || s.error || s.state !== 'ok') throw new Error('the store went away during the backfill: ' + JSON.stringify(s));
    if (tWalk === null && s.phase === 'backfill') tWalk = Date.now();
    if (s.backfillDone) { tDone = Date.now(); finished = true; break; }
    if (Date.now() > deadline) break;
    if (!args.json && Date.now() - lastShown > 15000) {
      lastShown = Date.now();
      process.stderr.write(`  ${s.phase} ${s.done}/${s.total} after ${Math.round((Date.now() - tInit) / 1000)} s\n`);
    }
    await sleep(POLL_MS);
  }

  // Settle: files that changed under the read, and files the cascade reset,
  // are queued for the next flush. Flush until no row is waiting for a rescan.
  const waitingSql = 'SELECT COUNT(*) AS n FROM files WHERE head_hash IS NULL OR scan_error IS NOT NULL';
  let settleRounds = 0;
  let rescansAfterWalk = 0;
  let waiting = 0;
  if (finished) {
    for (; settleRounds < SETTLE_ROUNDS_MAX; settleRounds++) {
      const r = store.flush();
      if (r && r.scanned) rescansAfterWalk += r.scanned;
      await sleep(settleRounds === 0 ? 300 : SETTLE_WAIT_MS);
      waiting = store._handle().prepare(waitingSql).get().n;
      const again = store.flush();
      if (again && again.scanned) rescansAfterWalk += again.scanned;
      if (waiting === 0 && !(again && again.scanned)) break;
    }
  }
  const tSettled = Date.now();

  // Not part of the wall time above: the index chain is the store's own work
  // after the walk, and the times stay comparable with earlier rehearsals.
  const flagSql = "SELECT value FROM meta WHERE key = 'indexes_built'";
  const indexWait = finished
    ? await waitForIndexes(() => { const row = store._handle().prepare(flagSql).get(); return row ? row.value : null; })
    : { built: false, waitedMs: 0 };

  const db = store._handle();
  const files = db.prepare(
    `SELECT kind, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(indexed_bytes), 0) AS indexed,
       COUNT(scan_error) AS errors, COUNT(missing_since) AS missing, COALESCE(SUM(lines_skipped), 0) AS skipped
     FROM files GROUP BY kind ORDER BY kind`).all();
  const errorKinds = db.prepare('SELECT scan_error AS error, COUNT(*) AS n FROM files WHERE scan_error IS NOT NULL GROUP BY scan_error').all();
  const counts = {
    files: db.prepare('SELECT COUNT(*) AS n FROM files').get().n,
    responses: db.prepare('SELECT COUNT(*) AS n FROM responses').get().n,
    sightings: db.prepare('SELECT COUNT(*) AS n FROM sightings').get().n,
    compactions: db.prepare('SELECT COUNT(*) AS n FROM compactions').get().n,
    sharedIds: db.prepare('SELECT COUNT(*) AS n FROM (SELECT message_id FROM sightings GROUP BY message_id HAVING COUNT(*) > 1)').get().n,
    indexes: db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").get().n,
  };
  const status = store.status();
  const bytesOpen = dbBytes(dataDir);

  store.shutdown();
  store.close();
  const bytesClosed = dbBytes(dataDir);

  return {
    ok: finished,
    dataDir,
    db: dbFile,
    projectsDir,
    startedIso: new Date(tInit).toISOString(),
    finishedIso: new Date(tSettled).toISOString(),
    wallSeconds: (tSettled - tInit) / 1000,
    waitBeforeWalkSeconds: tWalk === null ? null : (tWalk - tInit) / 1000,
    backfillSeconds: tWalk === null || tDone === null ? null : (tDone - tWalk) / 1000,
    settleSeconds: tDone === null ? null : (tSettled - tDone) / 1000,
    settleRounds,
    rescansAfterWalk,
    filesStillWaiting: waiting,
    indexesBuilt: indexWait.built,
    indexWaitSeconds: indexWait.waitedMs / 1000,
    filesScanned: counts.files,
    filesWithErrors: status && typeof status.filesWithErrors === 'number' ? status.filesWithErrors : null,
    files,
    errorKinds,
    counts,
    dbBytesOpen: bytesOpen,
    dbBytes: bytesClosed.db,
    dbBytesClosed: bytesClosed,
    status,
    logLines: logs,
    firstWarnings: firstLines,
    broadcasts,
  };
}

function printText(r) {
  const n = (x) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x));
  const out = [];
  out.push('Token store rehearsal');
  out.push(`  projects:  ${r.projectsDir} (read-only)`);
  out.push(`  store:     ${r.db}`);
  out.push(`  started:   ${r.startedIso}   finished: ${r.finishedIso}`);
  out.push(`  wall time: ${r.wallSeconds.toFixed(1)} s  (wait before the walk ${r.waitBeforeWalkSeconds === null ? '?' : r.waitBeforeWalkSeconds.toFixed(1)} s, backfill ${r.backfillSeconds === null ? 'NOT FINISHED' : r.backfillSeconds.toFixed(1) + ' s'}, settle ${r.settleSeconds === null ? '?' : r.settleSeconds.toFixed(1)} s in ${r.settleRounds} rounds, ${n(r.rescansAfterWalk)} rescans)`);
  out.push(`  files:     ${n(r.filesScanned)} scanned, ${n(r.filesWithErrors)} with a scan error, ${n(r.filesStillWaiting)} still waiting for a rescan`);
  for (const f of r.files) {
    out.push(`    ${f.kind.padEnd(9)} ${n(f.n)} files, ${n(f.bytes)} bytes, ${n(f.indexed)} indexed, ${n(f.errors)} errors, ${n(f.missing)} missing, ${n(f.skipped)} lines skipped`);
  }
  for (const e of r.errorKinds) out.push(`    scan_error ${JSON.stringify(e.error)}: ${n(e.n)} files`);
  out.push(`  rows:      ${n(r.counts.responses)} responses, ${n(r.counts.sightings)} sightings, ${n(r.counts.sharedIds)} ids seen in more than one file, ${n(r.counts.compactions)} compactions, ${n(r.counts.indexes)} indexes (${r.indexesBuilt ? 'indexes_built set' : 'indexes_built NOT SET'} after waiting ${r.indexWaitSeconds.toFixed(1)} s)`);
  out.push(`  db size:   ${n(r.dbBytes)} bytes after close (while open: db ${n(r.dbBytesOpen.db)}, wal ${n(r.dbBytesOpen.wal)})`);
  out.push(`  log lines: ${JSON.stringify(r.logLines)}, broadcasts ${n(r.broadcasts)}`);
  for (const line of r.firstWarnings) out.push('    ' + line);
  out.push('  status():  ' + JSON.stringify(r.status));
  out.push('');
  out.push(r.ok ? 'Result: the backfill finished.' : 'Result: the backfill did NOT finish.');
  process.stdout.write(out.join('\n') + '\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(err.message + '\n' + usage() + '\n');
    return 2;
  }
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  let report;
  try {
    report = await run(args);
  } catch (err) {
    const refused = /^refused: |--data-dir is required/.test(err.message);
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    else process.stderr.write(err.message + '\n' + (refused ? usage() + '\n' : ''));
    return refused ? 2 : 1;
  }
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printText(report);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  // exit, not exitCode: the worker thread is being terminated and the store's
  // handles are closed; nothing is left to wait for.
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write('rehearsal failed: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exit(1);
  });
} else {
  module.exports = { parseArgs, checkDataDir, isInside, realish, waitForIndexes, INDEX_WAIT_MS };
}
