'use strict';
// Token store baseline check (design 7.4). Manual, run after the relaunch; the
// app never loads this file.
//
// Opens the token store READ-ONLY and prints
//   - per kind, [input, output, output over finalised rows, cache_write,
//     cache_read, responses] for rows with ts_ms below a cutoff, to be compared
//     with the independent Python recount run minutes earlier over the same
//     cutoff (the acceptance test: exact equality per kind);
//   - the invariants that need no baseline (they cover the WHOLE store, not
//     only the rows below the cutoff).
//
// better-sqlite3 is built for Electron's ABI, so this runs under Electron as
// Node, not plain node:
//   PowerShell: $env:ELECTRON_RUN_AS_NODE=1; & "C:/Users/jhack/Bitbucket/switchboard/node_modules/.bin/electron.cmd" "C:/Users/jhack/Bitbucket/switchboard/scripts/token-baseline.js"
//
// Options:
//   --db <path>        the store to read (default: token-usage.db in
//                      SWITCHBOARD_DATA_DIR, else in ~/.switchboard: the rule
//                      token-usage.js uses)
//   --cutoff-ms <n>    epoch milliseconds; rows with ts_ms below it are counted
//                      (default: one hour ago, so no file is mid-write)
//   --json             one JSON object on stdout instead of the tables
//
// Exit code: 0 = every invariant holds, 1 = at least one does not, 2 = the
// store could not be read (or bad arguments).
//
// Read-only means the store's bytes are never changed. It does not mean no
// file is touched: the store is in WAL mode, and SQLite needs its -wal and
// -shm files beside it even to read. With the app running they are already
// there; with the app closed this run creates them (an empty -wal and a 32 KiB
// -shm) and, being read-only, leaves them. SQLite reuses or removes them at the
// next ordinary open.
//
// Reading the output: `output` includes responses that were still streaming
// when they were last seen (finalized = 0), which is a lower bound; `output
// over finalised rows` is the column the recount is compared on.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KINDS = ['main', 'subagent', 'workflow'];
const COUNTERS = ['input', 'output', 'output_finalized', 'cache_write', 'cache_read', 'responses'];
// Every counter the per-session check adds up (the two halves of cache_write included).
const SUMMED = ['input', 'output', 'output_finalized', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'responses'];
const EXAMPLES_MAX = 10;

// The data map's measurement of 2026-10-03 (design 7.4). CONTEXT ONLY: the
// store has grown since and the cross-file dedupe is under 1% of output, so no
// tolerance against these numbers can pass or fail anything.
const FROZEN_2026_10_03 = {
  main: { input: 157810, output: 36019059, cache_write: 409076501, cache_read: 11128855712, responses: 26837 },
  subagent: { input: 1501159, output: 35150812, cache_write: 154868441, cache_read: 5057794396, responses: 32306 },
  workflow: { input: 387685, output: 102773389, cache_write: 414629668, cache_read: 15243432454, responses: 90704 },
  all: { input: 2046654, output: 173943260, cache_write: 978574610, cache_read: 31430082562, responses: 149847 },
};

const SUMS_SQL = `
  COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(CASE WHEN finalized = 1 THEN output ELSE 0 END), 0) AS output_finalized,
  COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
  COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h,
  COALESCE(SUM(cache_read), 0) AS cache_read,
  COUNT(*) AS responses,
  COALESCE(SUM(CASE WHEN finalized = 1 THEN 0 ELSE 1 END), 0) AS unfinalized`;

function usage() {
  return 'usage: token-baseline.js [--db <path>] [--cutoff-ms <epoch ms>] [--json]';
}

function parseArgs(argv) {
  const out = { db: null, cutoffMs: null, json: false, help: false };
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
    else if (name === '--db') out.db = value();
    else if (name === '--cutoff-ms') {
      const text = value();
      if (!/^\d{1,16}$/.test(text)) throw new Error('--cutoff-ms must be epoch milliseconds, got ' + JSON.stringify(text));
      out.cutoffMs = Number(text);
    } else throw new Error('unknown option ' + JSON.stringify(arg));
  }
  return out;
}

// The rule of token-usage.js resolveDataDir (and db.js before it).
function defaultDbPath() {
  const dir = process.env.SWITCHBOARD_DATA_DIR
    ? path.resolve(process.env.SWITCHBOARD_DATA_DIR)
    : path.join(os.homedir(), '.switchboard');
  return path.join(dir, 'token-usage.db');
}

function iso(ms) {
  try { return new Date(ms).toISOString(); } catch { return String(ms); }
}

function zeroRow() {
  const row = { unfinalized: 0 };
  for (const name of SUMMED) row[name] = 0;
  return row;
}

function collect(db, cutoffMs) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  for (const name of ['responses', 'sightings', 'files', 'meta']) {
    if (!tables.has(name)) throw new Error('not a token store: no table ' + name);
  }

  const meta = {};
  for (const row of db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value;

  // --- The comparison table: rows below the cutoff, per kind ---
  const perKind = {};
  for (const kind of KINDS) perKind[kind] = zeroRow();
  const otherKinds = [];
  for (const row of db.prepare(`SELECT kind, ${SUMS_SQL} FROM responses WHERE ts_ms < ? GROUP BY kind`).all(cutoffMs)) {
    const kind = row.kind;
    delete row.kind;
    if (!KINDS.includes(kind)) otherKinds.push(kind);
    perKind[kind] = row;
  }
  const all = db.prepare(`SELECT ${SUMS_SQL} FROM responses WHERE ts_ms < ?`).get(cutoffMs);
  const rowsAtOrAfterCutoff = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE ts_ms >= ?').get(cutoffMs).n;

  // --- Invariants, over the whole store ---
  const invariants = [];
  const add = (name, ok, detail, examples) => invariants.push({ name, ok: !!ok, detail, examples: examples || [] });

  const counts = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT message_id) AS d FROM responses').get();
  add('COUNT(*) = COUNT(DISTINCT message_id)', counts.n === counts.d, `${counts.n} rows, ${counts.d} distinct message ids`);

  // Per-session sums added up here, against one SUM over the table: a response
  // counted under two sessions, or under none, shows as a difference.
  const grand = db.prepare(`SELECT ${SUMS_SQL} FROM responses`).get();
  const bySession = zeroRow();
  let sessions = 0;
  for (const row of db.prepare(`SELECT session_id, ${SUMS_SQL} FROM responses GROUP BY session_id`).iterate()) {
    sessions += 1;
    for (const name of SUMMED) bySession[name] += row[name];
  }
  const sessionDiffs = SUMMED.filter(name => bySession[name] !== grand[name]);
  add('per-session sums = grand total, every counter', sessionDiffs.length === 0,
    sessionDiffs.length === 0
      ? `${sessions} sessions; ${SUMMED.join(', ')} all equal`
      : sessionDiffs.map(name => `${name}: sessions ${bySession[name]} vs total ${grand[name]}`).join('; '));

  const byKindAll = zeroRow();
  const kindsSeen = [];
  for (const row of db.prepare(`SELECT kind, ${SUMS_SQL} FROM responses GROUP BY kind`).all()) {
    kindsSeen.push(row.kind);
    for (const name of SUMMED) byKindAll[name] += row[name];
  }
  const kindDiffs = SUMMED.filter(name => byKindAll[name] !== grand[name]);
  add('per-kind sums = grand total, every counter', kindDiffs.length === 0,
    kindDiffs.length === 0 ? 'all equal' : kindDiffs.map(name => `${name}: kinds ${byKindAll[name]} vs total ${grand[name]}`).join('; '));
  const strangeKinds = kindsSeen.filter(kind => !KINDS.includes(kind));
  add('every row is of kind main, subagent or workflow', strangeKinds.length === 0,
    strangeKinds.length === 0 ? `kinds present: ${kindsSeen.join(', ') || 'none'}` : `other kinds: ${strangeKinds.map(k => JSON.stringify(k)).join(', ')}`);

  // A response owned by a main transcript that also appears in a subagent or
  // workflow file would mean one usage line reached two kinds of file, which
  // the ownership rule assumes never happens.
  const crossSql = `FROM responses r
    JOIN sightings s ON s.message_id = r.message_id
    JOIN files f ON f.id = s.file_id
    WHERE r.kind = 'main' AND f.kind IN ('subagent', 'workflow')`;
  const cross = db.prepare(`SELECT COUNT(DISTINCT r.message_id) AS n ${crossSql}`).get().n;
  const crossExamples = cross === 0 ? [] : db.prepare(`SELECT DISTINCT r.message_id AS id, f.kind AS kind ${crossSql} LIMIT ${EXAMPLES_MAX}`).all()
    .map(row => `${row.id} (seen in a ${row.kind} file)`);
  add('no main-kind message id has a sighting from a subagent/workflow file', cross === 0, `${cross} such message ids`, crossExamples);

  const split = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE cache_write_5m + cache_write_1h <> cache_write').get().n;
  const splitExamples = split === 0 ? [] : db.prepare(
    `SELECT message_id AS id, cache_write AS w, cache_write_5m AS a, cache_write_1h AS b FROM responses
     WHERE cache_write_5m + cache_write_1h <> cache_write LIMIT ${EXAMPLES_MAX}`).all()
    .map(row => `${row.id}: 5m ${row.a} + 1h ${row.b} <> ${row.w}`);
  add('cache_write_5m + cache_write_1h = cache_write on every row', split === 0, `${split} rows differ`, splitExamples);

  // Listed, not judged: a file that could not be scanned is a known gap in the
  // totals, and the reader decides whether it matters.
  const scanErrors = db.prepare('SELECT rel_path, kind, scan_error FROM files WHERE scan_error IS NOT NULL ORDER BY rel_path').all();
  const files = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN missing_since IS NOT NULL THEN 1 ELSE 0 END), 0) AS missing, COALESCE(SUM(lines_skipped), 0) AS skipped FROM files').get();

  return {
    meta, perKind, all, otherKinds, rowsAtOrAfterCutoff, grand, invariants, scanErrors,
    files: { total: files.n, missing: files.missing, linesSkipped: files.skipped, withScanError: scanErrors.length },
  };
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => String(row[col]).length)));
  return rows.map(row => row.map((cell, col) => (col === 0 ? String(cell).padEnd(widths[col]) : String(cell).padStart(widths[col]))).join('  ')).join('\n');
}

function printText(report) {
  const out = [];
  out.push('Token store baseline');
  out.push(`  store:   ${report.db} (opened read-only)`);
  out.push(`  cutoff:  ts_ms < ${report.cutoffMs} (${report.cutoffIso})`);
  out.push(`  meta:    schema ${report.meta.schema_version || '?'}, parser ${report.meta.parse_version || '?'}, backfill done ${report.meta.backfill_done || 'NO'}, zone ${report.meta.tz || '?'}`);
  out.push(`  files:   ${fmt(report.files.total)} known, ${fmt(report.files.missing)} marked missing, ${fmt(report.files.withScanError)} with a scan error, ${fmt(report.files.linesSkipped)} lines skipped`);
  if (!report.meta.backfill_done) out.push('  NOTE: the first backfill has not finished; every number below is partial.');
  out.push('');
  out.push(`Rows below the cutoff, per kind (${fmt(report.rowsAtOrAfterCutoff)} rows at or after it are left out):`);
  const head = ['kind', 'input', 'output', 'output (finalised)', 'cache write', 'cache read', 'responses', 'not finalised'];
  const line = (name, row) => [name, fmt(row.input), fmt(row.output), fmt(row.output_finalized), fmt(row.cache_write), fmt(row.cache_read), fmt(row.responses), fmt(row.unfinalized)];
  const rows = [head];
  for (const kind of Object.keys(report.perKind)) rows.push(line(kind, report.perKind[kind]));
  rows.push(line('all', report.all));
  out.push(table(rows));
  out.push('');
  out.push('For comparison with the recount: [input, output, output over finalised rows, cache_write, cache_read, responses]');
  for (const kind of Object.keys(report.perKind)) out.push(`  ${kind}: ${JSON.stringify(COUNTERS.map(name => report.perKind[kind][name]))}`);
  out.push(`  all: ${JSON.stringify(COUNTERS.map(name => report.all[name]))}`);
  out.push('');
  out.push('Measured 2026-10-03 (context only, not a pass mark; the store has grown since):');
  const frozen = [['kind', 'input', 'output', 'cache write', 'cache read', 'responses']];
  for (const kind of Object.keys(FROZEN_2026_10_03)) {
    const row = FROZEN_2026_10_03[kind];
    frozen.push([kind, fmt(row.input), fmt(row.output), fmt(row.cache_write), fmt(row.cache_read), fmt(row.responses)]);
  }
  out.push(table(frozen));
  out.push('');
  out.push('Invariants (whole store):');
  for (const inv of report.invariants) {
    out.push(`  ${inv.ok ? 'ok  ' : 'FAIL'}  ${inv.name}: ${inv.detail}`);
    for (const example of inv.examples) out.push(`          ${example}`);
  }
  out.push('');
  if (report.scanErrors.length === 0) {
    out.push('Files with a scan error: none');
  } else {
    out.push(`Files with a scan error (${report.scanErrors.length}); their usage may be missing from the totals:`);
    for (const file of report.scanErrors) out.push(`  ${file.rel_path} [${file.kind}]: ${file.scan_error}`);
  }
  out.push('');
  out.push(report.ok ? 'Result: every invariant holds.' : 'Result: at least one invariant FAILED.');
  process.stdout.write(out.join('\n') + '\n');
}

function main() {
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
  const dbPath = path.resolve(args.db || defaultDbPath());
  const cutoffMs = args.cutoffMs === null ? Date.now() - 60 * 60 * 1000 : args.cutoffMs;
  const failed = (message) => {
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: message, db: dbPath }) + '\n');
    else process.stderr.write(message + '\n');
    return 2;
  };

  // Checked first: better-sqlite3 would otherwise CREATE a missing file, and a
  // read-only check must leave nothing behind.
  if (!fs.existsSync(dbPath)) return failed('No token store at ' + dbPath);

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    return failed('better-sqlite3 could not be loaded (' + err.message + ').\n'
      + 'Run this under Electron as Node, not plain node:\n'
      + '  $env:ELECTRON_RUN_AS_NODE=1; & "C:/Users/jhack/Bitbucket/switchboard/node_modules/.bin/electron.cmd" "' + __filename.replace(/\\/g, '/') + '"');
  }

  let db = null;
  try {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      // The same mistake, seen one step later: the module loads lazily and
      // only fails on the wrong ABI when the first handle is made.
      const hint = /NODE_MODULE_VERSION|was compiled against/.test(err.message)
        ? '\nRun this under Electron as Node, not plain node:\n'
          + '  $env:ELECTRON_RUN_AS_NODE=1; & "C:/Users/jhack/Bitbucket/switchboard/node_modules/.bin/electron.cmd" "' + __filename.replace(/\\/g, '/') + '"'
        : '';
      return failed('Could not open ' + dbPath + ': ' + err.message + hint);
    }
    // Second layer under the read-only handle: no statement on this connection may write.
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');
    const report = collect(db, cutoffMs);
    report.db = dbPath;
    report.cutoffMs = cutoffMs;
    report.cutoffIso = iso(cutoffMs);
    report.frozenBaseline = FROZEN_2026_10_03;
    report.ok = report.invariants.every(inv => inv.ok);
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printText(report);
    return report.ok ? 0 : 1;
  } catch (err) {
    return failed('Could not read ' + dbPath + ': ' + err.message);
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

if (require.main === module) {
  process.exitCode = main();
} else {
  // For a test: nothing here touches a database until main() or collect() is called.
  module.exports = { parseArgs, defaultDbPath, collect, main, COUNTERS, KINDS };
}
