const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Read-only queries behind the Tokens tab (design section 4; build contract 6.4).
 *
 *   createQueries(db, deps) -> { summary(q), models(q), daily(q), sessions(q), context(q) }
 *
 * Every function is synchronous and returns the design section 4 shape WITHOUT
 * the `scan` field (token-usage.js adds it), or { error: 'bad request: ...' }.
 * Nothing here throws: a database failure comes back as { error: 'query failed: ...' },
 * with the failure's `code` when it has one (the store reads it: a corrupt file
 * is recovered wherever it shows itself).
 *
 * Two halves, because the queries run in a worker thread (workers/query-tokens.js)
 * and three lookups cannot cross a thread boundary:
 *  - the query itself needs only the database, the price table and two folders;
 *  - decorateResult(name, result, lookups) fills in what only the main process
 *    knows: session titles (sessionInfo), project path and label (folderMeta)
 *    and isRunning. It is the ONLY place those three are called.
 * createQueries without the lookups returns the undecorated shape (title null,
 * projectPath and label = the slug, isRunning false); with them it runs
 * decorateResult itself, so the worker path (query there, decorate in main) and
 * the inline path (both here) give the same answer by construction.
 * wireRequest(q) is the copy of a request that is safe to post to the worker.
 *
 * Who loads this file, and when an edit to it is in effect (two copies):
 *  - the query worker requires it at each spawn, so createQueries and the SQL
 *    are new after the worker's next spawn (Disable then Enable, a worker that
 *    died, or Rebuild), with no app restart;
 *  - the main process (token-usage.js) requires it lazily, at the first Tokens
 *    query of the process, for decorateResult, wireRequest and the inline
 *    fallback. That copy changes only with an app restart.
 * Saving the file in the running checkout reloads the windows and neither copy.
 *
 * Rules this file keeps, and why:
 *  - It only reads. Every statement is a prepared SELECT over the `responses`
 *    and `compactions` tables; the SQL strings are constants and every value
 *    from the caller is a bound parameter.
 *  - `responses` holds each response ONCE, on the session that owns it (design
 *    1.5), so no query joins `sightings`: a join would count a copied prefix
 *    again for the continuation, which is the double counting the store exists
 *    to prevent. Per-session, per-model and per-day sums therefore add up to the
 *    summary total for the same range.
 *  - Every aggregate is COALESCE(SUM(x), 0): SUM over an empty range is NULL.
 *  - Weighted tokens and USD are computed here in JS from GROUP BY model
 *    sub-results (the read ratio and the base price differ by model), with the
 *    price table read at query time so an edit to token-prices.json needs no
 *    restart (design 5.1).
 *  - Nothing is filtered out: hidden projects, archived sessions and files that
 *    are gone from disk all count (decisions: "Count everything on disk",
 *    "Keep them, marked missing"), and so do responses that never got a
 *    stop_reason (their output is a lower bound; `unfinalized` says how many).
 *
 * Numbers: the six counters, `responses` and `unfinalized` are exact integers.
 * `weighted` is rounded to a whole token where it is returned, so a sum of
 * returned `weighted` values can differ from the returned total by up to half a
 * token per addend. Sorting, shares and USD use the unrounded values.
 *
 * Fields beyond the design shape (additions only): `cache_write_5m`,
 * `cache_write_1h`, `responses` and `unfinalized` wherever a counter set is
 * returned; `weighted` on `byKind`; `weighted` (the summary block) and `priced`
 * on the models reply; `ratios` and `readRatios` in that weighted block (the
 * ratios the figure was computed with, for the tab's tooltip); counters and `slugs` on the daily `other`; `dir` on the
 * sessions request; `model` on a context point; `contextWindowSource` and
 * `totalPoints` on the context reply.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_PER_DAY = 86400000;

const DEFAULT_RANGE_DAYS = 30;
// The store's dayList stops after 3,660 days. A longer range would come back
// with days missing from the zero-filled list, and rows on those days would be
// dropped from the daily view while the summary still counted them. Refusing
// the range in every view keeps the views equal to each other.
const MAX_RANGE_DAYS = 3660;

const DEFAULT_TOP_N = 6;
const MAX_TOP_N = 12;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_POINTS = 2000;
const PALETTE_SIZE = 8;            // design 6.2: eight project colours
const OTHER_SLUG = '__other__';
const MAX_SLUG_LENGTH = 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
// Two handoff marks closer than this are the same write seen in both files.
const SAME_HANDOFF_MS = 5000;

const COUNTER_KEYS = ['input', 'output', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'cache_read'];
const KINDS = ['main', 'subagent', 'workflow'];

const SUMS = `
  COALESCE(SUM(input), 0)          AS input,
  COALESCE(SUM(output), 0)         AS output,
  COALESCE(SUM(cache_write), 0)    AS cache_write,
  COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
  COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h,
  COALESCE(SUM(cache_read), 0)     AS cache_read,
  COALESCE(SUM(thinking), 0)       AS thinking,
  COUNT(*)                         AS responses,
  COALESCE(SUM(CASE WHEN finalized = 0 THEN 1 ELSE 0 END), 0) AS unfinalized`;

// local_day is a 'YYYY-MM-DD' string, so string comparison is date comparison
// and idx_resp_day_slug serves every ranged query.
const SQL = {
  byKindModel: `
    SELECT kind, model, ${SUMS}
    FROM responses
    WHERE local_day >= ? AND local_day <= ?
    GROUP BY kind, model
    ORDER BY kind, model`,

  byDaySlugModel: `
    SELECT local_day, slug, model, ${SUMS}
    FROM responses
    WHERE local_day >= ? AND local_day <= ?
    GROUP BY local_day, slug, model
    ORDER BY local_day, slug, model`,

  // peak is only meaningful for kind = 'main' (the context of the session's
  // own thread); the caller ignores it for the other kinds.
  bySession: `
    SELECT session_id, kind, slug, model, ${SUMS},
      MIN(ts_ms) AS first_ts, MAX(ts_ms) AS last_ts,
      COALESCE(MAX(input + cache_write + cache_read), 0) AS peak
    FROM responses
    WHERE local_day >= ? AND local_day <= ?
    GROUP BY session_id, kind, slug, model
    ORDER BY session_id, kind, slug, model`,

  bySessionForSlug: `
    SELECT session_id, kind, slug, model, ${SUMS},
      MIN(ts_ms) AS first_ts, MAX(ts_ms) AS last_ts,
      COALESCE(MAX(input + cache_write + cache_read), 0) AS peak
    FROM responses
    WHERE local_day >= ? AND local_day <= ? AND slug = ?
    GROUP BY session_id, kind, slug, model
    ORDER BY session_id, kind, slug, model`,

  // Separate from bySession because that one is grouped by model, and an agent
  // that used two models would be counted twice there. A workflow agent id is
  // only unique inside its workflow, hence the wf_id prefix.
  agents: `
    SELECT session_id, kind,
      COUNT(DISTINCT COALESCE(wf_id, '') || '/' || agent_id) AS agents,
      COUNT(DISTINCT wf_id) AS workflows
    FROM responses
    WHERE local_day >= ? AND local_day <= ? AND kind IN ('subagent', 'workflow')
    GROUP BY session_id, kind`,

  agentsForSlug: `
    SELECT session_id, kind,
      COUNT(DISTINCT COALESCE(wf_id, '') || '/' || agent_id) AS agents,
      COUNT(DISTINCT wf_id) AS workflows
    FROM responses
    WHERE local_day >= ? AND local_day <= ? AND slug = ? AND kind IN ('subagent', 'workflow')
    GROUP BY session_id, kind`,

  compactionsBetween: `
    SELECT session_id, ts_ms
    FROM compactions
    WHERE ts_ms >= ? AND ts_ms < ?`,

  // "Its own responses only": owner rows of kind main, nothing from sightings.
  contextPoints: `
    SELECT message_id, ts_ms, model, slug, input, cache_write, cache_read, output, finalized
    FROM responses
    WHERE session_id = ? AND kind = 'main'
    ORDER BY ts_ms, message_id`,

  anySlug: `
    SELECT slug FROM responses WHERE session_id = ? ORDER BY ts_ms DESC LIMIT 1`,

  contextCompactions: `
    SELECT ts_ms, trigger, pre_tokens, post_tokens, slug
    FROM compactions
    WHERE session_id = ?
    ORDER BY ts_ms, uuid`,
};

// --- small pure helpers ---

function bad(msg) {
  return { error: 'bad request: ' + msg };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function given(v) {
  return v !== undefined && v !== null;
}

function num(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function fmtDay(y, m, d) {
  return String(y).padStart(4, '0') + '-' + pad2(m) + '-' + pad2(d);
}

/**
 * 'YYYY-MM-DD' -> a day number (days since 1970-01-01), or null when the string
 * is not a real calendar day. Day numbers are computed in UTC, where every day
 * has 86,400,000 ms, so "30 days back" is plain subtraction with no DST hazard;
 * nothing here says what instant a local day starts at.
 */
function dayNumber(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const date = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  date.setUTCFullYear(y, m - 1, d);
  // 2026-02-30 would silently become 2026-03-02; refuse it instead.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return Math.round(date.getTime() / MS_PER_DAY);
}

function dayFromNumber(n) {
  const date = new Date(n * MS_PER_DAY);
  return fmtDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

// Fallbacks for deps.localDay / deps.dayList, following the same rules as the
// store's (design 1.6): LOCAL getters, and calendar stepping for lists.
function ownLocalDay(tsMs) {
  if (typeof tsMs !== 'number' || !Number.isFinite(tsMs)) return null;
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return null;
  return fmtDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function ownDayList(fromDay, toDay) {
  const a = dayNumber(fromDay);
  const b = dayNumber(toDay);
  const out = [];
  if (a === null || b === null) return out;
  for (let n = a; n <= b && out.length < MAX_RANGE_DAYS; n++) out.push(dayFromNumber(n));
  return out;
}

function zero() {
  return {
    input: 0, output: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0,
    responses: 0, unfinalized: 0, weighted: 0,
  };
}

function add(acc, row, weighted) {
  for (const k of COUNTER_KEYS) acc[k] += num(row[k]);
  acc.responses += num(row.responses);
  acc.unfinalized += num(row.unfinalized);
  acc.weighted += num(weighted);
}

/** The counter set as it is returned: exact integers plus a whole-token weighted. */
function emit(acc) {
  return {
    input: acc.input,
    output: acc.output,
    cache_write: acc.cache_write,
    cache_write_5m: acc.cache_write_5m,
    cache_write_1h: acc.cache_write_1h,
    cache_read: acc.cache_read,
    weighted: Math.round(acc.weighted),
    responses: acc.responses,
    unfinalized: acc.unfinalized,
  };
}

function roundUsd(n) {
  // Hundredths of a cent: enough for a tooltip, and no 0.30000000000000004.
  return Math.round(n * 1e4) / 1e4;
}

/** 'claude-opus-5-5' -> 'Opus 5.5'. Anything that is not that pattern is shown as it is. */
function modelLabel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(typeof id === 'string' ? id : '');
  if (!m) return typeof id === 'string' && id ? id : 'unknown';
  return m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
}

/**
 * Context window when no sidecar says otherwise (design section 4 notes):
 * 1,000,000 for opus / sonnet / fable ids, 200,000 for haiku. The design names
 * no value for any other id; 200,000 is returned with source 'default' so the
 * caller can tell a known family from a fallback.
 */
function contextWindowFor(model) {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  if (/opus|sonnet|fable/.test(id)) return { size: 1000000, source: 'model' };
  if (/haiku/.test(id)) return { size: 200000, source: 'model' };
  return { size: 200000, source: 'default' };
}

function lastSegment(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A colour slot per project that does not depend on its rank. Rank changes
 * with the range and with every refresh while sessions run, and a legend whose
 * colours swap between two refreshes is unreadable. The slot comes from a hash
 * of the slug; only when two projects of one reply hash to the same slot does
 * the lower-ranked one move to the next free slot. With more than eight
 * projects the slots run past the palette and stay unique.
 */
function assignColors(slugsInRankOrder) {
  const slots = Math.max(PALETTE_SIZE, slugsInRankOrder.length);
  const taken = new Set();
  const out = new Map();
  for (const slug of slugsInRankOrder) {
    let i = fnv1a(slug) % slots;
    while (taken.has(i)) i = (i + 1) % slots;
    taken.add(i);
    out.set(slug, i);
  }
  return out;
}

/**
 * At most `maxPoints` points: the list is cut into maxPoints / 2 runs of equal
 * length and each run keeps its largest ctx (so no peak before a compaction is
 * lost) and its last point (so the line still ends where the run ended).
 */
function downsamplePoints(points, maxPoints) {
  const max = Number.isInteger(maxPoints) && maxPoints >= 2 ? maxPoints : MAX_POINTS;
  if (points.length <= max) return { points, downsampled: false };
  const buckets = Math.floor(max / 2);
  const size = Math.ceil(points.length / buckets);
  const out = [];
  for (let start = 0; start < points.length; start += size) {
    const end = Math.min(points.length, start + size);
    let peak = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i].ctx > points[peak].ctx) peak = i;
    }
    out.push(points[peak]);
    if (peak !== end - 1) out.push(points[end - 1]);
  }
  return { points: out, downsampled: true };
}

/**
 * written_at of a handoff as epoch ms. The hook's files were seen with a float
 * of epoch seconds; the design also allows ms and an ISO string because the
 * type was not confirmed for every file (design 1.7).
 */
function writtenAtMs(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.round(v < 1e12 ? v * 1000 : v);
  }
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** JSON from a small file, or null for anything that goes wrong. Never throws. */
function readJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeFileName(name) {
  // The slug becomes a file name; one with a separator would leave the folder.
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && name !== '.' && name !== '..' && !/[\\/:*?"<>|\0]/.test(name);
}

function intOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Handoff marks for one session, read live (design 1.7): they are not in the
 * database. A missing, unreadable or malformed file is an empty list, because a
 * session without a handoff is the normal case and the chart must still draw.
 */
function readHandoffs(sessionId, slug, ctxDir, handoffsDir) {
  const out = [];
  try {
    if (ctxDir) {
      const state = readJson(path.join(ctxDir, sessionId + '.state.json'));
      if (isPlainObject(state)) {
        const t = writtenAtMs(state.written_at);
        if (t !== null) {
          out.push({
            t,
            tokens: intOrNull(state.written_tokens),
            path: strOrNull(state.handoff_path),
            consumedBy: null,
          });
        }
      }
    }
    if (handoffsDir && safeFileName(slug)) {
      const latest = readJson(path.join(handoffsDir, 'latest', slug + '.json'));
      const entries = isPlainObject(latest) && Array.isArray(latest.entries) ? latest.entries
        : (Array.isArray(latest) ? latest : []);
      for (const e of entries) {
        if (!isPlainObject(e) || e.session_id !== sessionId) continue;
        const t = writtenAtMs(e.written_at);
        if (t === null) continue;
        const item = {
          t,
          tokens: intOrNull(e.tokens),
          path: strOrNull(e.path),
          consumedBy: strOrNull(e.consumed_by),
        };
        // The same write is recorded in both files. Matched on time only: the
        // handoff file name is per session and day, so a later rewrite has the
        // same path and is a second mark, not a duplicate.
        const twin = out.find((h) => Math.abs(h.t - t) <= SAME_HANDOFF_MS);
        if (twin) {
          if (twin.tokens === null) twin.tokens = item.tokens;
          if (twin.path === null) twin.path = item.path;
          if (twin.consumedBy === null) twin.consumedBy = item.consumedBy;
        } else {
          out.push(item);
        }
      }
    }
  } catch {
    // Whatever was collected before the failure is still true.
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// --- the two ends of the thread boundary ---

// Every field a request may carry (design section 4).
const REQUEST_KEYS = ['from', 'to', 'topN', 'slug', 'sort', 'dir', 'limit', 'offset', 'sessionId'];
const WIRE_STRING_MAX = 4096;

// A value no field accepts and postMessage can always clone. A function, a
// symbol or a nested object is replaced by it, so the worker refuses the field
// with the same message the inline path gives for the original value.
function unsendable() { return []; }

function wireValue(v) {
  const t = typeof v;
  if (v === null || t === 'undefined' || t === 'boolean' || t === 'number' || t === 'bigint') return v;
  // Longer than any valid value, so the check that refuses it still refuses it.
  if (t === 'string') return v.length > WIRE_STRING_MAX ? v.slice(0, WIRE_STRING_MAX) : v;
  return unsendable();
}

/**
 * The request as it is posted to the query worker: the known fields only,
 * primitives only. Never throws; a request that cannot be read at all becomes a
 * value the queries answer with 'bad request: expected an object'.
 */
function wireRequest(q) {
  try {
    if (!isPlainObject(q)) return wireValue(q);
    const out = {};
    for (const key of REQUEST_KEYS) {
      const v = q[key];
      if (v !== undefined) out[key] = wireValue(v);
    }
    return out;
  } catch {
    return unsendable();
  }
}

/**
 * Main-process half of a query: fills title, projectPath, label and isRunning
 * into a result that was computed without them. Changes `result` in place and
 * returns it; an { error } or anything that is not a result passes through.
 * Never throws: each lookup may be a query against the app's own database, and
 * a failing one leaves the undecorated value.
 */
function decorateResult(name, result, lookups) {
  try {
    if (!isPlainObject(result) || typeof result.error === 'string') return result;
    const l = isPlainObject(lookups) ? lookups : {};
    const sessionInfo = typeof l.sessionInfo === 'function' ? l.sessionInfo : null;
    const folderMeta = typeof l.folderMeta === 'function' ? l.folderMeta : null;
    const isRunning = typeof l.isRunning === 'function' ? l.isRunning : null;

    const titleOf = (sessionId) => {
      if (!sessionInfo) return null;
      try {
        const info = sessionInfo(sessionId);
        return info && typeof info.title === 'string' && info.title ? info.title : null;
      } catch {
        return null;
      }
    };
    const paths = new Map();
    const pathOf = (slug) => {
      if (paths.has(slug)) return paths.get(slug);
      let projectPath = slug;
      if (folderMeta) {
        try {
          const meta = folderMeta(slug);
          if (meta && typeof meta.projectPath === 'string' && meta.projectPath) projectPath = meta.projectPath;
        } catch {
          // The folder table is display detail; the slug is always available.
        }
      }
      paths.set(slug, projectPath);
      return projectPath;
    };

    if (name === 'daily' && Array.isArray(result.projects)) {
      for (const p of result.projects) {
        if (!isPlainObject(p)) continue;
        p.projectPath = pathOf(p.slug);
        p.label = p.projectPath === p.slug ? p.slug : lastSegment(p.projectPath);
      }
    } else if (name === 'sessions' && Array.isArray(result.rows)) {
      for (const r of result.rows) {
        if (!isPlainObject(r)) continue;
        r.projectPath = pathOf(r.slug);
        r.title = titleOf(r.sessionId);
        let running = false;
        if (isRunning) {
          try { running = isRunning(r.sessionId) === true; } catch { running = false; }
        }
        r.isRunning = running;
      }
    } else if (name === 'context' && typeof result.sessionId === 'string') {
      result.title = titleOf(result.sessionId);
    }
    return result;
  } catch {
    return result;
  }
}

// --- the query object ---

function createQueries(db, deps) {
  const d = isPlainObject(deps) ? deps : {};
  const localDay = typeof d.localDay === 'function' ? d.localDay : ownLocalDay;
  const dayList = typeof d.dayList === 'function' ? d.dayList : ownDayList;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  // The main-process lookups. Absent in the query worker (functions cannot be
  // posted to a thread); the facade then runs decorateResult on the answer.
  const lookups = { sessionInfo: d.sessionInfo, folderMeta: d.folderMeta, isRunning: d.isRunning };
  const decorates = typeof d.sessionInfo === 'function' || typeof d.folderMeta === 'function'
    || typeof d.isRunning === 'function';

  // Required on first use, not at module load and not when injected, so this
  // file loads (and its argument checks run) even if token-prices.js is broken.
  let pricesModule = isPlainObject(d.prices) ? d.prices : null;
  function prices() {
    if (!pricesModule) pricesModule = require('./token-prices');
    return pricesModule;
  }

  // Prepared once per SQL text and kept: preparing is the expensive part of a
  // small query. Lazy, so createQueries itself cannot fail on a database that
  // is not ready yet.
  const prepared = new Map();
  function stmt(key) {
    let s = prepared.get(key);
    if (!s) {
      s = db.prepare(SQL[key]);
      prepared.set(key, s);
    }
    return s;
  }

  function guarded(name, fn) {
    return function query(q) {
      try {
        const res = fn(q);
        return decorates ? decorateResult(name, res, lookups) : res;
      } catch (err) {
        const out = { error: 'query failed: ' + (err && err.message ? err.message : String(err)) };
        // The code goes with the error: the store renames a corrupt file away
        // and rebuilds it wherever the damage shows, and a page that only a
        // query reads shows it here and nowhere else. The message alone does
        // not say which failure it was.
        if (err && typeof err.code === 'string' && err.code) out.code = err.code;
        return out;
      }
    };
  }

  function today() {
    let day = null;
    try { day = localDay(now()); } catch { day = null; }
    if (dayNumber(day) === null) day = ownLocalDay(Date.now());
    return day;
  }

  /** { from, to } (inclusive local days) or { error }. Default: the last 30 local days. */
  function resolveRange(q) {
    let toN;
    if (given(q.to)) {
      toN = dayNumber(q.to);
      if (toN === null) return bad('to must be a calendar day, YYYY-MM-DD');
    } else {
      toN = dayNumber(today());
    }
    let fromN;
    if (given(q.from)) {
      fromN = dayNumber(q.from);
      if (fromN === null) return bad('from must be a calendar day, YYYY-MM-DD');
    } else {
      fromN = toN - (DEFAULT_RANGE_DAYS - 1);
    }
    if (fromN > toN) return bad('from is after to');
    if (toN - fromN + 1 > MAX_RANGE_DAYS) return bad('range is longer than ' + MAX_RANGE_DAYS + ' days');
    return { from: dayFromNumber(fromN), to: dayFromNumber(toN) };
  }

  function request(q) {
    if (!given(q)) return {};
    if (!isPlainObject(q)) return bad('expected an object');
    return q;
  }

  /** One price-table read per query, and one weights lookup per model id. */
  function pricing() {
    const p = prices();
    const table = p.loadPriceTable();
    const cache = new Map();
    return {
      version: table && typeof table.version === 'string' ? table.version : 'unavailable',
      of(model) {
        let hit = cache.get(model);
        if (!hit) {
          // The alias and the dated snapshot of one model are one row
          // (claude-haiku-4-5 and claude-haiku-4-5-20251001).
          const norm = typeof p.normalizeModel === 'function' ? p.normalizeModel(model) : model;
          hit = { key: norm || (typeof model === 'string' && model ? model : 'unknown'), w: p.weightsFor(model, table) };
          cache.set(model, hit);
        }
        return hit;
      },
      weigh(row, w) {
        return p.weightedTokens(row, w);
      },
      /**
       * The ratios this table weighs with, for the tab to SAY how the figure
       * was computed (it used to name them in a fixed sentence, which an edit
       * to the price file overtook): the model-independent ones, taken as the
       * weights of a model that has no row, and the cache-read ratio of every
       * model in the answer whose ratio is not the default one.
       */
      ratios(perModel) {
        const base = p.weightsFor('', table) || {};
        const ratios = {
          input: num(base.input),
          output: num(base.output),
          write5m: num(base.write5m),
          write1h: num(base.write1h),
          readDefault: num(base.read),
        };
        const readRatios = [];
        for (const [key, m] of perModel) {
          const read = m.w ? m.w.read : null;
          if (typeof read === 'number' && Number.isFinite(read) && read !== ratios.readDefault) readRatios.push({ model: key, read });
        }
        readRatios.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
        return { ratios, readRatios };
      },
      /**
       * USD over per-model weighted sums. Unpriced models add nothing and are
       * named, so the figure is a lower bound ("≥") when the list is not empty.
       * null when there is usage and not one model has a price: "≥ $0" says
       * nothing.
       */
      usd(perModel) {
        let usd = 0;
        let pricedCount = 0;
        const unpriced = [];
        for (const [key, m] of perModel) {
          const u = p.estimateUsd(m.weighted, m.w);
          if (typeof u === 'number' && Number.isFinite(u)) {
            usd += u;
            pricedCount++;
          } else {
            unpriced.push(key);
          }
        }
        unpriced.sort();
        return {
          usd: pricedCount === 0 && unpriced.length > 0 ? null : roundUsd(usd),
          unpricedModels: unpriced,
        };
      },
    };
  }

  /** Shared by summary and models: one pass over GROUP BY kind, model. */
  function kindModelPass(range) {
    const pr = pricing();
    const rows = stmt('byKindModel').all(range.from, range.to);
    const totals = zero();
    const byKind = { main: zero(), subagent: zero(), workflow: zero() };
    const perModel = new Map();
    for (const r of rows) {
      const { key, w } = pr.of(r.model);
      const weighted = pr.weigh(r, w);
      add(totals, r, weighted);
      if (Object.prototype.hasOwnProperty.call(byKind, r.kind)) add(byKind[r.kind], r, weighted);
      let m = perModel.get(key);
      if (!m) {
        m = { acc: zero(), thinking: 0, weighted: 0, w };
        perModel.set(key, m);
      }
      add(m.acc, r, weighted);
      m.thinking += num(r.thinking);
      m.weighted = m.acc.weighted;
    }
    const money = pr.usd(perModel);
    const said = pr.ratios(perModel);
    return {
      totals,
      byKind,
      perModel,
      pr,
      weighted: {
        tokens: Math.round(totals.weighted),
        usd: money.usd,
        unpricedModels: money.unpricedModels,
        pricesVersion: pr.version,
        ratios: said.ratios,
        readRatios: said.readRatios,
      },
    };
  }

  function summary(q) {
    const req = request(q);
    if (req.error) return req;
    const range = resolveRange(req);
    if (range.error) return range;

    const pass = kindModelPass(range);
    const t = pass.totals;
    return {
      range,
      totals: {
        input: t.input,
        output: t.output,
        cache_write: t.cache_write,
        cache_write_5m: t.cache_write_5m,
        cache_write_1h: t.cache_write_1h,
        cache_read: t.cache_read,
        responses: t.responses,
        unfinalized: t.unfinalized,
      },
      byKind: {
        main: emit(pass.byKind.main),
        subagent: emit(pass.byKind.subagent),
        workflow: emit(pass.byKind.workflow),
      },
      weighted: pass.weighted,
    };
  }

  function models(q) {
    const req = request(q);
    if (req.error) return req;
    const range = resolveRange(req);
    if (range.error) return range;

    const pass = kindModelPass(range);
    const p = prices();
    const total = pass.totals.weighted;
    const list = [];
    for (const [key, m] of pass.perModel) {
      const usd = p.estimateUsd(m.weighted, m.w);
      const row = emit(m.acc);
      list.push({
        model: key,
        label: modelLabel(key),
        input: row.input,
        output: row.output,
        cache_write: row.cache_write,
        cache_write_5m: row.cache_write_5m,
        cache_write_1h: row.cache_write_1h,
        cache_read: row.cache_read,
        thinking: m.thinking,
        responses: row.responses,
        unfinalized: row.unfinalized,
        weighted: row.weighted,
        usd: typeof usd === 'number' && Number.isFinite(usd) ? roundUsd(usd) : null,
        share: total > 0 ? m.weighted / total : 0,
        priced: !!(m.w && m.w.priced),
        _sort: m.weighted,
      });
    }
    list.sort((a, b) => (b._sort - a._sort) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    for (const row of list) delete row._sort;
    return {
      range,
      models: list,
      byType: {
        input: pass.totals.input,
        output: pass.totals.output,
        cache_write: pass.totals.cache_write,
        cache_read: pass.totals.cache_read,
      },
      weighted: pass.weighted,
    };
  }

  function daily(q) {
    const req = request(q);
    if (req.error) return req;
    const range = resolveRange(req);
    if (range.error) return range;
    let topN = DEFAULT_TOP_N;
    if (given(req.topN)) {
      if (!Number.isInteger(req.topN) || req.topN < 1 || req.topN > MAX_TOP_N) {
        return bad('topN must be an integer from 1 to ' + MAX_TOP_N);
      }
      topN = req.topN;
    }

    let list = dayList(range.from, range.to);
    // A list that does not span the range would leave days (and the tokens on
    // them) out of the chart while the summary counts them.
    if (!Array.isArray(list) || list.length === 0 || list[0] !== range.from || list[list.length - 1] !== range.to) {
      list = ownDayList(range.from, range.to);
    }

    const pr = pricing();
    const rows = stmt('byDaySlugModel').all(range.from, range.to);

    // Pass 1: rank the projects over the whole range.
    const bySlug = new Map();
    for (const r of rows) {
      const { w } = pr.of(r.model);
      r._weighted = pr.weigh(r, w);
      let acc = bySlug.get(r.slug);
      if (!acc) {
        acc = zero();
        bySlug.set(r.slug, acc);
      }
      add(acc, r, r._weighted);
    }
    const ranked = [...bySlug.keys()].sort((a, b) => {
      const diff = bySlug.get(b).weighted - bySlug.get(a).weighted;
      return diff || (a < b ? -1 : a > b ? 1 : 0);
    });
    const top = ranked.slice(0, topN);
    const topSet = new Set(top);
    const colors = assignColors(top);

    // Pass 2: fill the days.
    const dayMap = new Map();
    for (const day of list) dayMap.set(day, { total: zero(), bySlug: new Map() });
    let unlisted = false;
    for (const r of rows) {
      let day = dayMap.get(r.local_day);
      if (!day) {
        // A stored day the list does not contain (a malformed local_day between
        // the bounds). Counted anyway: dropping it would undercount.
        day = { total: zero(), bySlug: new Map() };
        dayMap.set(r.local_day, day);
        unlisted = true;
      }
      add(day.total, r, r._weighted);
      const name = topSet.has(r.slug) ? r.slug : OTHER_SLUG;
      let acc = day.bySlug.get(name);
      if (!acc) {
        acc = zero();
        day.bySlug.set(name, acc);
      }
      add(acc, r, r._weighted);
    }
    const dayKeys = [...dayMap.keys()];
    if (unlisted) dayKeys.sort();

    const days = dayKeys.map((key) => {
      const day = dayMap.get(key);
      const slugs = {};
      for (const [name, acc] of day.bySlug) slugs[name] = emit(acc);
      return { day: key, total: emit(day.total), bySlug: slugs };
    });

    // projectPath and label are the slug here; decorateResult replaces them.
    const projects = top.map((slug) => ({
      slug,
      projectPath: slug,
      label: slug,
      colorIndex: colors.get(slug),
      ...emit(bySlug.get(slug)),
    }));

    const other = zero();
    for (const slug of ranked.slice(topN)) {
      const acc = bySlug.get(slug);
      for (const k of COUNTER_KEYS) other[k] += acc[k];
      other.responses += acc.responses;
      other.unfinalized += acc.unfinalized;
      other.weighted += acc.weighted;
    }

    return {
      range,
      days,
      projects,
      other: { ...emit(other), slugs: Math.max(0, ranked.length - topN) },
    };
  }

  const SESSION_SORTS = {
    weighted: (s) => s.all.weighted,
    last_ts: (s) => s.lastTs,
    output: (s) => s.all.output,
    cache_read: (s) => s.all.cache_read,
    peak_ctx: (s) => s.peak,
  };

  function sessions(q) {
    const req = request(q);
    if (req.error) return req;
    const range = resolveRange(req);
    if (range.error) return range;

    let slug = null;
    if (given(req.slug)) {
      if (typeof req.slug !== 'string' || !req.slug || req.slug.length > MAX_SLUG_LENGTH) {
        return bad('slug must be a non-empty string');
      }
      slug = req.slug;
    }
    let sort = 'weighted';
    if (given(req.sort)) {
      if (typeof req.sort !== 'string' || !Object.prototype.hasOwnProperty.call(SESSION_SORTS, req.sort)) {
        return bad('sort must be one of ' + Object.keys(SESSION_SORTS).join(', '));
      }
      sort = req.sort;
    }
    let descending = true;
    if (given(req.dir)) {
      if (req.dir !== 'asc' && req.dir !== 'desc') return bad('dir must be asc or desc');
      descending = req.dir === 'desc';
    }
    let limit = DEFAULT_LIMIT;
    if (given(req.limit)) {
      if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_LIMIT) {
        return bad('limit must be an integer from 1 to ' + MAX_LIMIT);
      }
      limit = req.limit;
    }
    let offset = 0;
    if (given(req.offset)) {
      if (!Number.isInteger(req.offset) || req.offset < 0) return bad('offset must be an integer of 0 or more');
      offset = req.offset;
    }

    const pr = pricing();
    const args = slug === null ? [range.from, range.to] : [range.from, range.to, slug];
    const rows = stmt(slug === null ? 'bySession' : 'bySessionForSlug').all(...args);

    const map = new Map();
    for (const r of rows) {
      let s = map.get(r.session_id);
      if (!s) {
        s = {
          sessionId: r.session_id,
          slug: null,
          slugFromMain: false,
          firstTs: Infinity,
          lastTs: -Infinity,
          all: zero(),
          kinds: { main: zero(), subagent: zero(), workflow: zero() },
          models: new Map(),
          peak: 0,
          agents: { subagent: 0, workflow: 0 },
          workflows: 0,
          compactions: 0,
        };
        map.set(r.session_id, s);
      }
      const { key, w } = pr.of(r.model);
      const weighted = pr.weigh(r, w);
      add(s.all, r, weighted);
      if (Object.prototype.hasOwnProperty.call(s.kinds, r.kind)) add(s.kinds[r.kind], r, weighted);
      s.models.set(key, (s.models.get(key) || 0) + weighted);
      if (num(r.first_ts) < s.firstTs) s.firstTs = num(r.first_ts);
      if (num(r.last_ts) > s.lastTs) s.lastTs = num(r.last_ts);
      if (r.kind === 'main') {
        // Peak context is the main thread's: an agent has its own window.
        if (num(r.peak) > s.peak) s.peak = num(r.peak);
        // The session's project is where its own transcript lives.
        if (!s.slugFromMain) {
          s.slug = r.slug;
          s.slugFromMain = true;
        }
      } else if (s.slug === null) {
        s.slug = r.slug;
      }
    }

    for (const r of stmt(slug === null ? 'agents' : 'agentsForSlug').all(...args)) {
      const s = map.get(r.session_id);
      if (!s) continue;
      if (r.kind === 'subagent') {
        s.agents.subagent = num(r.agents);
      } else if (r.kind === 'workflow') {
        s.agents.workflow = num(r.agents);
        s.workflows = num(r.workflows);
      }
    }

    // compactions has no local_day column. Fetch a window wide enough for any
    // UTC offset (36 h each side), then keep exactly the marks whose local day
    // is in range, by the same localDay the store stamps responses with.
    const fromMs = dayNumber(range.from) * MS_PER_DAY - 36 * 3600000;
    const toMs = (dayNumber(range.to) + 1) * MS_PER_DAY + 36 * 3600000;
    for (const r of stmt('compactionsBetween').all(fromMs, toMs)) {
      const s = map.get(r.session_id);
      if (!s) continue;
      let day = null;
      try { day = localDay(r.ts_ms); } catch { day = null; }
      if (typeof day === 'string' && day >= range.from && day <= range.to) s.compactions++;
    }

    const keyOf = SESSION_SORTS[sort];
    const sign = descending ? -1 : 1;
    const all = [...map.values()];
    all.sort((a, b) => {
      const diff = keyOf(a) - keyOf(b);
      if (diff) return sign * diff;
      // Ties: most recent first, then the id, so paging is deterministic.
      if (a.lastTs !== b.lastTs) return b.lastTs - a.lastTs;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });

    // The display lookups (title, project path, running) are decorateResult's,
    // for the returned page only: each may be a query against the app's own
    // database. Here they are the undecorated values.
    const page = all.slice(offset, offset + limit).map((s) => {
      const modelsByWeight = [...s.models.entries()]
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
        .map((e) => e[0]);
      return {
        sessionId: s.sessionId,
        slug: s.slug,
        projectPath: s.slug,
        title: null,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        models: modelsByWeight,
        main: emit(s.kinds.main),
        subagents: { ...emit(s.kinds.subagent), agents: s.agents.subagent },
        workflow: { ...emit(s.kinds.workflow), agents: s.agents.workflow, workflows: s.workflows },
        weighted: Math.round(s.all.weighted),
        peakContext: s.peak,
        compactions: s.compactions,
        unfinalized: s.all.unfinalized,
        isRunning: false,
      };
    });

    return { range, total: all.length, rows: page };
  }

  function context(q) {
    if (!isPlainObject(q)) return bad('expected an object with sessionId');
    const sessionId = q.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) {
      return bad('sessionId must be a session uuid');
    }

    const p = prices();
    const norm = (model) => (typeof p.normalizeModel === 'function' ? p.normalizeModel(model) : model) || 'unknown';
    const rows = stmt('contextPoints').all(sessionId);
    const allPoints = rows.map((r) => ({
      t: r.ts_ms,
      ctx: num(r.input) + num(r.cache_write) + num(r.cache_read),
      out: num(r.output),
      mid: r.message_id,
      fin: r.finalized ? 1 : 0,
      model: norm(r.model),
    }));
    const sampled = downsamplePoints(allPoints, MAX_POINTS);

    const compactionRows = stmt('contextCompactions').all(sessionId);
    const compactions = compactionRows.map((r) => ({
      t: r.ts_ms,
      trigger: typeof r.trigger === 'string' ? r.trigger : null,
      pre: intOrNull(r.pre_tokens),
      post: intOrNull(r.post_tokens),
    }));

    // The session's project: its own transcript's, else an agent row's, else a
    // compaction's (a session can have marks and no response in the store yet).
    let slug = rows.length ? rows[rows.length - 1].slug : null;
    if (slug === null) {
      const any = stmt('anySlug').get(sessionId);
      if (any && typeof any.slug === 'string') slug = any.slug;
    }
    if (slug === null && compactionRows.length) slug = compactionRows[compactionRows.length - 1].slug;

    // The model in use now is the last response's: a session can switch models.
    const model = allPoints.length ? allPoints[allPoints.length - 1].model : null;

    const ctxDir = typeof d.ctxDir === 'string' && d.ctxDir
      ? d.ctxDir
      : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-ctx');
    const handoffsDir = typeof d.handoffsDir === 'string' && d.handoffsDir
      ? d.handoffsDir
      : path.join(os.homedir(), '.claude', 'handoffs');

    // The sidecar is what Claude Code itself reported for this session, so it
    // wins over a guess from the model name.
    let win = contextWindowFor(model);
    const sidecar = readJson(path.join(ctxDir, sessionId + '.json'));
    if (isPlainObject(sidecar) && typeof sidecar.context_window_size === 'number'
      && Number.isFinite(sidecar.context_window_size) && sidecar.context_window_size > 0) {
      win = { size: sidecar.context_window_size, source: 'sidecar' };
    }

    return {
      sessionId,
      slug,
      title: null,              // decorateResult fills it in
      model,
      contextWindow: win.size,
      contextWindowSource: win.source,
      points: sampled.points,
      compactions,
      handoffs: readHandoffs(sessionId, slug, ctxDir, handoffsDir),
      downsampled: sampled.downsampled,
      totalPoints: allPoints.length,
    };
  }

  return {
    summary: guarded('summary', summary),
    models: guarded('models', models),
    daily: guarded('daily', daily),
    sessions: guarded('sessions', sessions),
    context: guarded('context', context),
  };
}

module.exports = {
  createQueries,
  // The two ends of the thread boundary (token-usage.js, workers/query-tokens.js):
  decorateResult,
  wireRequest,
  // For tests and for the renderer's own expectations:
  downsamplePoints,
  writtenAtMs,
  modelLabel,
  contextWindowFor,
  assignColors,
  dayNumber,
  MAX_RANGE_DAYS,
  MAX_POINTS,
  OTHER_SLUG,
};
