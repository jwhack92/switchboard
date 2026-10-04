const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Token usage parser. Pure accounting rules plus the per-file scan.
 *
 * Loaded ONLY by workers/scan-tokens.js, so a fix here takes effect at the next
 * worker spawn (the Rebuild button) with no app restart. Node built-ins only,
 * no I/O at require time, no database: the store (token-usage.js) applies the
 * same two upsert rules in SQL and stamps `local_day` at write time.
 *
 * Exports
 * -------
 * PARSE_VERSION
 *   Integer. Bump it when a rule below changes what a line yields; the store
 *   rebuilds when the value in its meta table differs.
 *
 * classifyPath(relPath) -> { kind, slug, sessionId, agentId, wfId } | null
 *   relPath is relative to the projects dir; '/' and '\' both accepted.
 *   kind is 'main' | 'subagent' | 'workflow'. agentId keeps its 'agent-'
 *   prefix. Absent captures are null. Upper-case hex in the uuid is rejected.
 *
 * parseUsageLine(obj, file, stats) -> candidate | null
 *   obj   the JSON.parse'd line.
 *   file  { kind, slug, sessionId, agentId, wfId, birthMs }: classifyPath's
 *         result plus the floored birthtimeMs of the file the line came from.
 *   stats optional { skipped: number }. Incremented when a line that WOULD
 *         have counted is dropped by field hardening (no message.id, no
 *         parseable timestamp, counters that only became zero by clamping).
 *         Lines dropped by an ordinary rule (not assistant, no usage object,
 *         '<synthetic>', genuinely all-zero) return null without counting.
 *   candidate = { message_id, session_id, kind, slug, wf_id, agent_id,
 *     owner_birth_ms, model, ts_ms, input, output, cache_write,
 *     cache_write_5m, cache_write_1h, cache_read, thinking, finalized,
 *     stop_reason }. finalized is 0 or 1. thinking is a number or null.
 *     cache_write_5m + cache_write_1h === cache_write on every candidate.
 *
 * parseCompaction(obj, file, stats) -> compaction | null
 *   Same arguments. Only for main files. compaction = { uuid, session_id,
 *   slug, ts_ms, trigger, pre_tokens, post_tokens }. A boundary without a
 *   string uuid or a parseable timestamp returns null and counts in stats.
 *
 * decideUpsert(stored, cand) -> { action, counters, owner, row }
 *   PURE. `stored` is the row currently held for cand.message_id (a candidate
 *   shaped object, or null/undefined when there is none). Two INDEPENDENT
 *   decisions, the same two the store's ON CONFLICT statement makes:
 *     counters (design 1.4, SQL <better>):
 *       stored unfinalised and cand finalised, OR the same finalised state and
 *       (cand.output > stored.output OR (equal output AND cand.ts_ms >
 *       stored.ts_ms)).
 *     owner (design 1.5, SQL <takeover>):
 *       cand.kind === 'main' AND stored.kind === 'main' AND
 *       cand.owner_birth_ms < stored.owner_birth_ms (strictly earlier).
 *   Returns
 *     action   'insert' (no stored row) | 'update' (either decision true) |
 *              'keep' (neither; the SQL WHERE clause is false)
 *     counters boolean: COUNTER_FIELDS were taken from cand
 *     owner    boolean: OWNER_FIELDS were taken from cand
 *     row      the row to hold afterwards: a copy of cand on insert, a new
 *              object on update, `stored` itself (same reference) on keep.
 *   Neither argument is mutated. `local_day` travels with the counter fields
 *   and `file_id` with the owner fields when the candidate carries them (the
 *   parser's own candidates carry neither), so the store's rows can be put
 *   through this function unchanged for the agreement test.
 *
 * COUNTER_FIELDS, OWNER_FIELDS
 *   The two column sets above, as arrays of names.
 *
 * reduceFile(candidates) -> candidates
 *   At most one candidate per message_id, in first-seen order, by applying
 *   decideUpsert in the order given. Input is not mutated.
 *
 * scanTranscript(absPath, prevFileRow, projectsDir[, opts]) ->
 *     { discarded, fullRescan, fileRow, candidates, compactions, lines_skipped }
 *   Synchronous. prevFileRow is the stored `files` row or null. Throws only
 *   for file-system errors (read err.code); a path that is not one of the
 *   three transcript shapes throws with code 'EINVAL'.
 *     discarded     the file changed under the scan. Nothing may be written.
 *                   candidates/compactions are empty, fullRescan is false and
 *                   fileRow carries the PREVIOUS head_hash / indexed_bytes /
 *                   tail_hash (null / 0 / null without a previous row), so
 *                   even a caller that stored it could not move the offset.
 *     fullRescan    a previous row existed and could not be resumed; the store
 *                   deletes this file's rows before applying the candidates.
 *     fileRow       { rel_path, kind, slug, session_id, agent_id, wf_id, size,
 *                   mtime_ms, birthtime_ms, head_hash, indexed_bytes,
 *                   tail_hash }, times floored, size and mtime as of the open.
 *     candidates    reduced: at most one per message_id for this pass.
 *     compactions   at most one per uuid for this pass.
 *     lines_skipped for THIS pass only.
 *   opts is a test seam: { fs, decode }. `fs` replaces the fs functions used
 *   (openSync, fstatSync, readSync, closeSync); `decode(buf)` replaces the
 *   UTF-8 decode. The worker passes neither.
 */

// Version of the accounting rules. Posted in the worker's hello message.
const PARSE_VERSION = 1;

const HEAD_BYTES = 4096;        // same guard window as harnesses/claude.js
const TAIL_BYTES = 256;         // bytes before the offset that must not have changed
const CHUNK_BYTES = 256 * 1024;

// Needles as bytes, built once: the prefilter runs on every line of about 3 GB.
// The quotes are part of the first needle, so an escaped \"usage\" inside a
// tool result (bytes: backslash, quote, usage, backslash, quote) does not match.
const NEEDLE_USAGE = Buffer.from('"usage"');
const NEEDLE_BOUNDARY = Buffer.from('compact_boundary');

// Anchored on both ends. The workflow shape is tried first so a path under
// /workflows/ can never be read as a plain subagent file.
const RE_WORKFLOW = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/workflows\/([^/]+)\/(agent-[^/]+)\.jsonl$/;
const RE_SUBAGENT = /^([^/]+)\/([0-9a-f-]{36})\/subagents\/(agent-[^/]+)\.jsonl$/;
const RE_MAIN = /^([^/]+)\/([0-9a-f-]{36})\.jsonl$/;

// Kind comes from the path, never from isSidechain, which cannot tell a
// subagent from a workflow agent.
function classifyPath(relPath) {
  if (typeof relPath !== 'string') return null;
  const rel = relPath.replace(/\\/g, '/');
  let m;
  let out = null;
  if ((m = RE_WORKFLOW.exec(rel))) {
    out = { kind: 'workflow', slug: m[1], sessionId: m[2], agentId: m[4], wfId: m[3] };
  } else if ((m = RE_SUBAGENT.exec(rel))) {
    out = { kind: 'subagent', slug: m[1], sessionId: m[2], agentId: m[3], wfId: null };
  } else if ((m = RE_MAIN.exec(rel))) {
    out = { kind: 'main', slug: m[1], sessionId: m[2], agentId: null, wfId: null };
  }
  // `[^/]+` also matches '..', which is what path.relative gives for a file
  // outside the projects dir.
  if (!out || out.slug === '.' || out.slug === '..') return null;
  return out;
}

// --- Line rules ---

const isCount = x => Number.isSafeInteger(x) && x >= 0;
// Plain numbers, never 32-bit ops: cache read totals already pass 2^31.
const count = x => (isCount(x) ? x : 0);
// Present but unusable. Used to tell "zero" from "zeroed by the clamp".
const clamped = x => x !== undefined && x !== null && !isCount(x);

function noteSkip(stats) {
  if (stats) stats.skipped = (stats.skipped || 0) + 1;
}

// A string only: Date.parse(12345) coerces to '12345' and returns a real date.
function parseTs(v) {
  if (typeof v !== 'string') return NaN;
  return Date.parse(v);
}

function parseUsageLine(obj, file, stats) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') return null;
  const u = msg.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  // API error lines and other local stand-ins. Always zero usage.
  if (msg.model === '<synthetic>') return null;

  // Top-level counters only. usage.iterations is never read, for any purpose:
  // the zeroed post-compaction copies keep real-looking numbers there, and the
  // response they copy is already counted from its own lines.
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const cacheWrite = count(u.cache_creation_input_tokens);
  const cacheRead = count(u.cache_read_input_tokens);
  if (input + output + cacheWrite + cacheRead === 0) {
    // Zero because the clamp removed every counter is a dropped line, not an
    // empty one: count it so a format change shows up instead of reading as 0.
    if (clamped(u.input_tokens) || clamped(u.output_tokens)
        || clamped(u.cache_creation_input_tokens) || clamped(u.cache_read_input_tokens)) {
      noteSkip(stats);
    }
    return null;
  }

  // From here on the line would count. These two checks come after the rules
  // above so lines_skipped means "usage that could not be stored", not noise
  // from lines that were never going to count.
  if (typeof msg.id !== 'string' || !msg.id) { noteSkip(stats); return null; }
  const tsMs = parseTs(obj.timestamp);
  if (!Number.isFinite(tsMs)) { noteSkip(stats); return null; }

  // The split exists only for the price weighting. Normalise so 5m + 1h always
  // equals cache_write: the fallback responses store a split of the abandoned
  // first attempt beside a cache_write of 0, and a split with no counter behind
  // it would be weighted as tokens that were never counted.
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  let write5m = cc ? count(cc.ephemeral_5m_input_tokens) : 0;
  let write1h = cc ? count(cc.ephemeral_1h_input_tokens) : 0;
  if (write5m + write1h !== cacheWrite) { write5m = cacheWrite; write1h = 0; }

  // A sub-figure of output, never added to anything.
  const det = u.output_tokens_details;
  const thinking = det && typeof det === 'object' && isCount(det.thinking_tokens)
    ? det.thinking_tokens : null;

  // Copied main lines are re-stamped with the new file's sessionId, so for a
  // main file only the path says whose it is. Copied agent files keep the
  // line's original sessionId, which is the owner; the directory uuid is the
  // fallback for a line that has lost the field.
  const sessionId = file.kind === 'main'
    ? file.sessionId
    : (typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : file.sessionId);

  // Only the line with a stop_reason carries the real output count; earlier
  // lines of the same response hold a streaming placeholder.
  const finalized = typeof msg.stop_reason === 'string';

  return {
    message_id: msg.id,
    session_id: sessionId,
    kind: file.kind,
    slug: file.slug,
    wf_id: file.wfId || null,
    agent_id: file.agentId || null,
    owner_birth_ms: file.birthMs,
    model: typeof msg.model === 'string' && msg.model ? msg.model : 'unknown',
    ts_ms: tsMs,
    input,
    output,
    cache_write: cacheWrite,
    cache_write_5m: write5m,
    cache_write_1h: write1h,
    cache_read: cacheRead,
    thinking,
    finalized: finalized ? 1 : 0,
    stop_reason: finalized ? msg.stop_reason : null,
  };
}

function parseCompaction(obj, file, stats) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type !== 'system' || obj.subtype !== 'compact_boundary') return null;
  if (!file || file.kind !== 'main') return null;
  // uuid is the dedupe key (copies keep it). Without it, or without a time to
  // place the mark at, the record cannot be stored.
  if (typeof obj.uuid !== 'string' || !obj.uuid) { noteSkip(stats); return null; }
  const tsMs = parseTs(obj.timestamp);
  if (!Number.isFinite(tsMs)) { noteSkip(stats); return null; }
  const meta = obj.compactMetadata && typeof obj.compactMetadata === 'object' ? obj.compactMetadata : {};
  return {
    uuid: obj.uuid,
    session_id: file.sessionId,
    slug: file.slug,
    ts_ms: tsMs,
    trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
    pre_tokens: isCount(meta.preTokens) ? meta.preTokens : null,
    post_tokens: isCount(meta.postTokens) ? meta.postTokens : null,
  };
}

// --- Upsert rules ---

// Taken from ONE line as a unit, never per-field maxima: in a fallback response
// the placeholder lines carry the first attempt's cache numbers.
const COUNTER_FIELDS = ['model', 'ts_ms', 'input', 'output', 'cache_write', 'cache_write_5m',
  'cache_write_1h', 'cache_read', 'thinking', 'finalized', 'stop_reason'];
const OWNER_FIELDS = ['session_id', 'kind', 'slug', 'wf_id', 'agent_id', 'owner_birth_ms'];

function decideUpsert(stored, cand) {
  if (!stored) return { action: 'insert', counters: true, owner: true, row: { ...cand } };

  const rf = stored.finalized ? 1 : 0;
  const cf = cand.finalized ? 1 : 0;
  // Strictly greater in (finalized, output, ts_ms) order. The ts_ms term makes
  // the stored time the same whichever of several max-output lines came last.
  const counters = (rf === 0 && cf === 1)
    || (rf === cf && (cand.output > stored.output
      || (cand.output === stored.output && cand.ts_ms > stored.ts_ms)));
  // Earliest-born main file wins, so the answer is the same in any scan order.
  // Agent files never change owner.
  const owner = cand.kind === 'main' && stored.kind === 'main'
    && cand.owner_birth_ms < stored.owner_birth_ms;

  if (!counters && !owner) return { action: 'keep', counters: false, owner: false, row: stored };

  const row = { ...stored };
  if (counters) {
    for (const f of COUNTER_FIELDS) row[f] = cand[f];
    if (cand.local_day !== undefined) row.local_day = cand.local_day;
  }
  if (owner) {
    for (const f of OWNER_FIELDS) row[f] = cand[f];
    if (cand.file_id !== undefined) row.file_id = cand.file_id;
  }
  return { action: 'update', counters, owner, row };
}

function createReducer() {
  // Map keeps insertion order, so the output order is first-seen order.
  const byId = new Map();
  return {
    add(cand) { byId.set(cand.message_id, decideUpsert(byId.get(cand.message_id), cand).row); },
    list() { return Array.from(byId.values()); },
  };
}

function reduceFile(candidates) {
  const r = createReducer();
  for (const c of candidates) r.add(c);
  return r.list();
}

// --- File scan ---

/** Exactly `len` bytes at `pos`, or null when the file ends first. */
function readExactly(io, fd, len, pos) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = io.readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) return null;
    got += n;
  }
  return buf;
}

// Byte for byte what harnesses/claude.js hashHead produces, 'v1:' tag
// included. Returns null (not a throw) when the head could not be read in
// full, which means the file shrank after the fstat.
function hashHead(io, fd, st) {
  const n = Math.min(HEAD_BYTES, st.size);
  if (n === 0) return '';
  const buf = readExactly(io, fd, n, 0);
  if (!buf) return null;
  // dev:ino is in the hash so an atomic replacement with the same first 4 KB
  // still resets the offset.
  return 'v1:' + crypto.createHash('sha1')
    .update(`${st.dev}:${st.ino}:`).update(buf).digest('hex');
}

// sha1 of the bytes [max(0, offset - 256), offset). Null on a short read.
function hashTail(io, fd, offset) {
  const from = Math.max(0, offset - TAIL_BYTES);
  const len = offset - from;
  const h = crypto.createHash('sha1');
  if (len > 0) {
    const buf = readExactly(io, fd, len, from);
    if (!buf) return null;
    h.update(buf);
  }
  return h.digest('hex');
}

function passesPrefilter(line) {
  return line.indexOf(NEEDLE_USAGE) !== -1 || line.indexOf(NEEDLE_BOUNDARY) !== -1;
}

/**
 * Walk the complete lines of [start, end) as raw bytes. A line reaches
 * `onLine(buf)` only if it passes the prefilter; every complete line, passed or
 * not, moves `consumed` forward. Bytes after the last newline are left for the
 * next pass. jsonl-scan.js decodes every line before its caller sees it, which
 * is the cost this walker exists to avoid.
 */
function walkLines(io, fd, start, end, onLine) {
  let consumed = start;
  let read = 0;
  let pos = start;
  let pending = [];
  let pendingBytes = 0;
  // One buffer for the whole walk. A piece that has to outlive its chunk is
  // copied below; a line inside one chunk is handed over as a view, and the
  // callback must be done with it when it returns.
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, end - start)));
  while (pos < end) {
    const n = io.readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
    if (n === 0) return { consumed, read, truncated: true };
    read += n;
    const data = chunk.subarray(0, n);
    let from = 0;
    let nl;
    while ((nl = data.indexOf(0x0A, from)) !== -1) {
      let line = data.subarray(from, nl);
      if (pendingBytes) {
        pending.push(line);
        line = Buffer.concat(pending, pendingBytes + line.length);
        pending = [];
        pendingBytes = 0;
      }
      consumed = pos + nl + 1;
      if (line.length && passesPrefilter(line)) onLine(line);
      from = nl + 1;
    }
    if (from < n) {
      pending.push(Buffer.from(data.subarray(from)));
      pendingBytes += n - from;
    }
    pos += n;
  }
  return { consumed, read, truncated: false };
}

function decodeUtf8(buf) {
  return buf.toString('utf8');
}

// Floor every time before it is stored or compared. mtimeMs and birthtimeMs
// are fractional on most files here; an INTEGER column compared with the raw
// float never matches, and every launch would re-read everything.
function floorMs(x) {
  return Number.isFinite(x) ? Math.floor(x) : 0;
}

function scanTranscript(absPath, prevFileRow, projectsDir, opts) {
  const io = (opts && opts.fs) || fs;
  const decode = (opts && opts.decode) || decodeUtf8;

  const rel = path.relative(projectsDir, absPath).replace(/\\/g, '/');
  const cls = classifyPath(rel);
  if (!cls) {
    const err = new Error('not a transcript path: ' + rel);
    err.code = 'EINVAL';
    throw err;
  }
  const prev = prevFileRow || null;

  const fd = io.openSync(absPath, 'r');
  try {
    const st = io.fstatSync(fd);
    const size = st.size;
    const mtime = floorMs(st.mtimeMs);
    const birth = floorMs(st.birthtimeMs);
    const identity = {
      rel_path: rel,
      kind: cls.kind,
      slug: cls.slug,
      session_id: cls.sessionId,
      agent_id: cls.agentId,
      wf_id: cls.wfId,
      size,
      mtime_ms: mtime,
      birthtime_ms: birth,
    };
    // The file changed while it was being read. Hand back the previous resume
    // state so nothing a caller does with this result can advance the offset.
    const discard = () => ({
      discarded: true,
      fullRescan: false,
      fileRow: {
        ...identity,
        head_hash: prev && typeof prev.head_hash === 'string' ? prev.head_hash : null,
        indexed_bytes: prev && Number.isSafeInteger(prev.indexed_bytes) ? prev.indexed_bytes : 0,
        tail_hash: prev && typeof prev.tail_hash === 'string' ? prev.tail_hash : null,
      },
      candidates: [],
      compactions: [],
      lines_skipped: 0,
    });

    const headHash = hashHead(io, fd, st);
    if (headHash === null) return discard();

    // Resume only when the file is provably the one that was indexed: same
    // head, offset inside the file, and either it grew or nothing touched it.
    // The tail hash is checked last so its read happens only when everything
    // cheaper already holds; it catches a rewrite of the bytes just before the
    // offset that kept the head.
    const canResume = !!prev && !!headHash
      && prev.head_hash === headHash
      && Number.isSafeInteger(prev.indexed_bytes) && prev.indexed_bytes > 0
      && prev.indexed_bytes <= size
      && (prev.indexed_bytes < size || floorMs(prev.mtime_ms) === mtime)
      && typeof prev.tail_hash === 'string'
      && hashTail(io, fd, prev.indexed_bytes) === prev.tail_hash;
    const start = canResume ? prev.indexed_bytes : 0;
    const fullRescan = !!prev && !canResume;

    const file = { ...cls, birthMs: birth };
    const stats = { skipped: 0 };
    const reducer = createReducer();
    const compactions = new Map();

    const walked = walkLines(io, fd, start, size, (buf) => {
      let obj;
      // A complete line that passed the prefilter and is not JSON may have been
      // usage; count it rather than lose it silently.
      try { obj = JSON.parse(decode(buf)); } catch { stats.skipped++; return; }
      if (!obj || typeof obj !== 'object') return;
      if (obj.type === 'assistant') {
        const c = parseUsageLine(obj, file, stats);
        if (c) reducer.add(c);
      } else if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
        const k = parseCompaction(obj, file, stats);
        if (k && !compactions.has(k.uuid)) compactions.set(k.uuid, k);
      }
    });
    if (walked.truncated) return discard();

    // Never past a partial last line: `consumed` stops at the last newline.
    const consumed = walked.consumed;
    // Nothing new consumed on a resumed pass: the gate has just verified this
    // exact hash, so an unchanged file costs the head and one tail read.
    const tailHash = canResume && consumed === start
      ? prev.tail_hash
      : hashTail(io, fd, consumed);
    if (tailHash === null) return discard();

    // Growth is fine (the next pass takes it). A smaller file, or the same size
    // with another mtime, means bytes inside the range read may have changed.
    const after = io.fstatSync(fd);
    if (after.size < size || (after.size === size && floorMs(after.mtimeMs) !== mtime)) {
      return discard();
    }

    return {
      discarded: false,
      fullRescan,
      fileRow: { ...identity, head_hash: headHash, indexed_bytes: consumed, tail_hash: tailHash },
      candidates: reducer.list(),
      compactions: Array.from(compactions.values()),
      lines_skipped: stats.skipped,
    };
  } finally {
    try { io.closeSync(fd); } catch {}
  }
}

module.exports = {
  PARSE_VERSION,
  classifyPath,
  parseUsageLine,
  parseCompaction,
  decideUpsert,
  reduceFile,
  scanTranscript,
  COUNTER_FIELDS,
  OWNER_FIELDS,
};
