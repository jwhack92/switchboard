const { parentPort, workerData, isMainThread, receiveMessageOnPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { PARSE_VERSION, classifyPath, scanTranscript } = require('../token-usage-parse');

/**
 * Token scan worker. The only scanner: it walks the projects dir, parses
 * transcripts with token-usage-parse and posts the result to the store
 * (token-usage.js) in chunks. Parse-only: it never opens a database and never
 * writes a file, so everything it posts can be thrown away and scanned again.
 *
 * One long-lived worker, `workerData = { projectsDir, gen }`. It is loaded by
 * `new Worker`, so it and the parser are re-read at every spawn: a fix to the
 * accounting rules takes effect with the Rebuild button and no app restart.
 *
 * Messages (design 3.4). Every one carries `gen`.
 *   worker -> main  { type: 'hello', gen, parseVersion }
 *   main -> worker  { type: 'walk', gen, mode: 'backfill'|'catchup', known: [files rows] }
 *   main -> worker  { type: 'scan', gen, files: [{ rel_path, prev }] }
 *   main -> worker  { type: 'ack', gen, rel_path, seq[, dropped] }
 *   worker -> main  { type: 'chunk', gen, rel_path, seq, last, fileRow, candidates, compactions,
 *                     fullRescan, lines_skipped, resumed_from[, discarded] }
 *   worker -> main  { type: 'progress', gen, done, total }            during a walk
 *   worker -> main  { type: 'progress', gen, warn[, rel_path, code] } something could not be read
 *   worker -> main  { type: 'done', gen, mode, seen, missing }
 *
 * `resumed_from` is the byte offset the pass started at (0 unless it resumed).
 * It is not in the design; it lets the store tell a chunk computed from an
 * out-of-date `prev` from one computed from the row it holds now.
 *
 * Exports `createScanner` so the walk and the flow control can be tested in the
 * test's own thread with an injected fs. Requiring this file outside a worker
 * does nothing: the worker part at the bottom runs only with a parentPort.
 */

// Upper bound per chunk: one chunk is one main-thread transaction, and the main
// thread also carries every terminal's PTY data.
const CHUNK_MAX = 500;
const PROGRESS_FILES = 10;
const PROGRESS_MS = 1000;

// Same times rule as the parser: mtimeMs and birthtimeMs are fractional on most
// files, and the stored columns are integers.
const floorMs = x => (Number.isFinite(x) ? Math.floor(x) : 0);
const errCode = err => (err && typeof err.code === 'string' ? err.code : 'EUNKNOWN');
const normRel = p => String(p).replace(/\\/g, '/');

// File-system errors are named by code. Anything else is a bug in the scan, so
// its message is kept, but short: a warn line must never carry transcript text.
function describe(err) {
  if (err && typeof err.code === 'string') return err.code;
  const name = err && err.name ? String(err.name) : 'Error';
  const text = err && err.message ? String(err.message).slice(0, 120) : '';
  return text ? name + ': ' + text : name;
}

// A transcript path that stays inside the projects dir. classifyPath anchors
// the shape, but its workflow capture is `[^/]+`, which also matches '..'.
function transcriptRel(rel) {
  if (typeof rel !== 'string' || !classifyPath(rel)) return false;
  for (const part of rel.split('/')) {
    if (part === '.' || part === '..') return false;
  }
  return true;
}

/**
 * opts = { projectsDir, gen, post(msg), receive(), fs, scan, now }
 *   post     sends one message to the store.
 *   receive  optional: returns the next queued inbox message as { message }, or
 *            undefined when the inbox is empty (receiveMessageOnPort).
 *   fs, scan, now  test seams: readdirSync/statSync, scanTranscript, Date.now.
 * Returns { handle(msg), hello() }.
 */
function createScanner(opts) {
  const projectsDir = opts.projectsDir;
  const io = opts.fs || fs;
  const scan = opts.scan || scanTranscript;
  const now = opts.now || Date.now;

  let gen = opts.gen;
  // Bumped when a newer generation arrives. A job compares the value it started
  // with after every wait and stops when it differs.
  let epoch = 0;
  // Order of arrival of every incoming message. The parent posts in order, so
  // "arrived earlier" also means "was posted earlier".
  let arrivals = 0;
  // rel_path -> { row, ackedAt }: the files rows posted in this generation whose
  // last chunk the store has confirmed. ackedAt is the arrival number of that ack.
  const posted = new Map();
  // rel_path -> { prev, at }. A Map so a path queued twice is scanned once, at
  // its first position, with the later (fresher) prev.
  const scans = new Map();
  let walks = [];
  let waiting = null;   // the one chunk that has been posted and not acknowledged
  let running = false;

  const abs = rel => path.join(projectsDir, ...rel.split('/'));

  function post(msg) {
    try {
      opts.post(msg);
      return true;
    } catch {
      return false;
    }
  }

  function warn(text, extra) {
    post({ type: 'progress', gen, warn: text, ...(extra || {}) });
  }

  function hello() {
    post({ type: 'hello', gen, parseVersion: PARSE_VERSION });
  }

  // ---------------------------------------------------------------- inbox ----

  function handle(msg) {
    try {
      if (!msg || typeof msg !== 'object') return;
      const at = ++arrivals;
      if (msg.type === 'ack') { onAck(msg, at); return; }
      if (msg.type !== 'walk' && msg.type !== 'scan') return;
      if (msg.gen !== gen) {
        const newer = Number.isInteger(msg.gen) && (!Number.isInteger(gen) || msg.gen > gen);
        if (!newer) return;       // a request from a generation that is over
        switchGen(msg.gen);
      }
      if (msg.type === 'walk') {
        walks.push({ msg, at });
      } else {
        for (const f of Array.isArray(msg.files) ? msg.files : []) {
          if (!f || typeof f.rel_path !== 'string') continue;
          const prev = f.prev && typeof f.prev === 'object' ? f.prev : null;
          scans.set(normRel(f.rel_path), { prev, at });
        }
      }
      kick();
    } catch (err) {
      warn('scanner could not handle a request: ' + describe(err));
    }
  }

  function onAck(msg, at) {
    const w = waiting;
    if (!w || msg.gen !== gen || msg.seq !== w.seq) return;
    if (typeof msg.rel_path !== 'string' || normRel(msg.rel_path) !== w.rel) return;
    waiting = null;
    w.resolve({ at, dropped: msg.dropped === true });
  }

  // The store dropped or rebuilt its tables. Everything queued or posted was
  // computed against rows that no longer exist. The store answers a stale chunk
  // with no ack at all, so the wait is released here or it would never end.
  function switchGen(next) {
    gen = next;
    epoch++;
    posted.clear();
    scans.clear();
    walks = [];
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.resolve({ aborted: true });
    }
  }

  // Messages reach the 'message' listener only when this thread goes back to
  // its event loop. Reading the port directly between files is what lets a
  // scan request overtake a walk that never has to wait (a catch-up walk over
  // unchanged files posts no chunk, so it never waits for an ack).
  function drainInbox() {
    if (typeof opts.receive !== 'function') return;
    for (;;) {
      let m;
      try { m = opts.receive(); } catch { return; }
      if (!m) return;
      handle(m.message);
    }
  }

  function kick() {
    if (running) return;
    running = true;
    pump().catch((err) => {
      warn('scanner stopped a job: ' + describe(err));
    }).then(() => {
      running = false;
      if (scans.size > 0 || walks.length > 0) kick();
    });
  }

  async function pump() {
    for (;;) {
      const ep = epoch;
      await serveScans(ep);
      if (ep !== epoch) continue;
      const w = walks.shift();
      if (!w) {
        if (scans.size === 0) return;
        continue;
      }
      await runWalk(w, ep);
    }
  }

  // ------------------------------------------------------------- one file ----

  // Which previous row to resume from. The store is the source of truth and
  // sends its row with every request, but it read that row when it POSTED the
  // request. If our own last chunk for this file was acknowledged after the
  // request arrived, the store read its row before it stored ours: the row it
  // sent is the older one, and resuming from it would post the same lines
  // again (and add lines_skipped twice). A request that arrived after the ack
  // was read from a store that already held our row, including any reset the
  // store has made since, so the store's row wins.
  function pickPrev(rel, mainPrev, at) {
    const mine = posted.get(rel);
    if (mine && mine.ackedAt > at) return mine.row;
    return mainPrev || null;
  }

  function waitAck(rel, seq) {
    return new Promise((resolve) => { waiting = { rel, seq, resolve }; });
  }

  // Post one chunk and wait for its ack before returning: nothing queues
  // unbounded in memory and the main thread is never flooded.
  async function send(chunk, ep) {
    const acked = waitAck(chunk.rel_path, chunk.seq);   // registered first: the ack may come back inside post
    if (!post(chunk)) {
      waiting = null;
      return { failed: true };
    }
    const a = await acked;
    if (a.aborted || ep !== epoch) return { aborted: true };
    return a;
  }

  // Scan one transcript and post it. Never throws: one unreadable file must
  // not cost the rest of the walk, or the worker.
  async function scanFile(rel, mainPrev, at, ep) {
    // The store queues any '.jsonl' path the watcher reports (it never loads
    // the parser); only the three transcript shapes are scanned.
    if (!transcriptRel(rel)) return 'ignored';
    const prev = pickPrev(rel, mainPrev, at);
    let res;
    try {
      res = scan(abs(rel), prev, projectsDir);
    } catch (err) {
      // Reported and left alone. A 'discarded' chunk would make the store retry
      // at every flush, which for a file that stays unreadable never ends; the
      // next walk tries it again.
      warn('cannot scan ' + rel + ': ' + describe(err), { rel_path: rel, code: errCode(err) });
      return 'failed';
    }

    if (res.discarded) {
      // The file changed under the read. The store writes nothing and retries.
      const a = await send({
        type: 'chunk', gen, rel_path: rel, seq: 0, last: true, fileRow: res.fileRow,
        candidates: [], compactions: [], fullRescan: false, lines_skipped: 0,
        resumed_from: 0, discarded: true,
      }, ep);
      return a.aborted ? 'aborted' : 'discarded';
    }

    const resumedFrom = prev && !res.fullRescan && Number.isSafeInteger(prev.indexed_bytes)
      ? prev.indexed_bytes : 0;
    const cands = res.candidates;
    const count = Math.max(1, Math.ceil(cands.length / CHUNK_MAX));   // a file with no usage still posts its row
    for (let seq = 0; seq < count; seq++) {
      const last = seq === count - 1;
      const a = await send({
        type: 'chunk', gen, rel_path: rel, seq, last, fileRow: res.fileRow,
        candidates: cands.slice(seq * CHUNK_MAX, (seq + 1) * CHUNK_MAX),
        compactions: seq === 0 ? res.compactions : [],
        fullRescan: res.fullRescan === true,
        lines_skipped: res.lines_skipped || 0,
        resumed_from: resumedFrom,
      }, ep);
      if (a.aborted) return 'aborted';
      if (a.failed) {
        warn('cannot post ' + rel, { rel_path: rel, code: 'EPOST' });
        posted.delete(rel);
        return 'failed';
      }
      if (a.dropped) {
        // The store refused the chunk and will refuse the rest of this pass.
        // Its row did not move, so ours must not claim it did.
        posted.delete(rel);
        return 'dropped';
      }
      if (last) posted.set(rel, { row: res.fileRow, ackedAt: a.at });
    }
    return 'ok';
  }

  // Scan requests go ahead of a walk in progress, so a live append is counted
  // within a second or two even during a backfill.
  async function serveScans(ep) {
    drainInbox();
    while (scans.size > 0 && ep === epoch) {
      const [rel, job] = scans.entries().next().value;
      scans.delete(rel);
      await scanFile(rel, job.prev, job.at, ep);
      drainInbox();
    }
  }

  // ----------------------------------------------------------------- walk ----

  // Entries of a directory, or null when it could not be read. A sub-folder
  // that does not exist is simply empty. Any other failure is remembered, so
  // nothing under that folder is reported as gone in this walk.
  function readDir(relDir, st) {
    try {
      return io.readdirSync(relDir ? abs(relDir) : projectsDir, { withFileTypes: true });
    } catch (err) {
      const code = errCode(err);
      if (relDir && (code === 'ENOENT' || code === 'ENOTDIR')) return [];
      st.failedDirs.push(relDir ? relDir + '/' : '');
      warn('cannot read folder ' + (relDir || '(projects dir)') + ': ' + code, { code });
      return null;
    }
  }

  // A symlink or junction is tried as a folder; readDir answers "empty" if it
  // is not one.
  const isDir = d => d.isDirectory() || d.isSymbolicLink();

  function addFile(rel, st) {
    const cls = classifyPath(rel);
    if (!cls) return;
    let s;
    try {
      s = io.statSync(abs(rel));
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') return;      // gone since the readdir: not seen
      // On disk but unreadable. It was seen, so it can never be reported gone.
      st.seen.push(rel);
      warn('cannot stat ' + rel + ': ' + code, { rel_path: rel, code });
      return;
    }
    if (typeof s.isFile === 'function' && !s.isFile()) return;
    st.seen.push(rel);
    st.files.push({
      rel,
      kind: cls.kind,
      size: s.size,
      mtime_ms: floorMs(s.mtimeMs),
      birthtime_ms: floorMs(s.birthtimeMs),
    });
  }

  function collectAgentDir(relDir, st, withWorkflows) {
    const entries = readDir(relDir, st);
    if (!entries) return;
    for (const d of entries) {
      if (d.name.endsWith('.jsonl')) addFile(relDir + '/' + d.name, st);
      else if (withWorkflows && d.name === 'workflows' && isDir(d)) {
        const wfs = readDir(relDir + '/workflows', st);
        for (const wf of wfs || []) {
          if (isDir(wf)) collectAgentDir(relDir + '/workflows/' + wf.name, st, false);
        }
      }
    }
  }

  function collectSlug(slug, st) {
    const entries = readDir(slug, st);
    if (!entries) return;
    for (const d of entries) {
      if (d.name.endsWith('.jsonl')) addFile(slug + '/' + d.name, st);
      // A session folder is named by its 36-character uuid. The length check
      // only saves a readdir on folders such as memory/; classifyPath still
      // decides what counts as a transcript.
      else if (d.name.length === 36 && isDir(d)) collectAgentDir(slug + '/' + d.name + '/subagents', st, true);
    }
  }

  const byBirthThenPath = (a, b) => (a.birthtime_ms - b.birthtime_ms) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const byPath = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

  // Main files first, oldest first: a response copied into a continuation is
  // then stored under its original straight away, with fewer ownership
  // takeovers. The path is the tie-break so the order never depends on readdir.
  function walkOrder(files) {
    return files.filter(f => f.kind === 'main').sort(byBirthThenPath)
      .concat(files.filter(f => f.kind === 'subagent').sort(byPath))
      .concat(files.filter(f => f.kind === 'workflow').sort(byPath));
  }

  // "Gone" means: known to the store, not seen by this walk, AND stat says
  // ENOENT. EACCES, EBUSY or a folder that could not be listed never count.
  function findMissing(known, st) {
    const seen = new Set(st.seen);
    const missing = [];
    for (const rel of known.keys()) {
      if (seen.has(rel) || !transcriptRel(rel)) continue;
      if (st.failedDirs.some(d => rel.startsWith(d))) continue;
      try {
        io.statSync(abs(rel));
      } catch (err) {
        if (errCode(err) === 'ENOENT') missing.push(rel);
      }
    }
    return missing;
  }

  async function runWalk(w, ep) {
    const mode = w.msg.mode === 'backfill' ? 'backfill' : 'catchup';
    const known = new Map();
    for (const k of Array.isArray(w.msg.known) ? w.msg.known : []) {
      if (k && typeof k.rel_path === 'string') known.set(normRel(k.rel_path), k);
    }
    const st = { seen: [], files: [], failedDirs: [] };
    let missing = [];
    try {
      const root = readDir('', st);
      for (const d of root || []) {
        if (d.name === '.git' || !isDir(d)) continue;
        collectSlug(d.name, st);
        await serveScans(ep);           // the inbox is checked between folders too
        if (ep !== epoch) return;
      }

      const files = walkOrder(st.files);
      const total = files.length;
      let done = 0;
      let scannedSince = 0;
      let lastProgress = now();
      post({ type: 'progress', gen, done, total });

      for (const f of files) {
        await serveScans(ep);           // a scan request is served before the walk's next file
        if (ep !== epoch) return;
        const mainPrev = known.get(f.rel) || null;
        const prev = pickPrev(f.rel, mainPrev, w.at);
        // Catch-up: same floored size and mtime as the stored row means
        // nothing to read, and the file is not even opened. The store sends
        // size -1 for a row it wants rescanned, which never matches.
        const unchanged = mode === 'catchup' && !!prev
          && prev.size === f.size && floorMs(prev.mtime_ms) === f.mtime_ms;
        if (!unchanged) {
          const r = await scanFile(f.rel, mainPrev, w.at, ep);
          if (r === 'aborted' || ep !== epoch) return;
          scannedSince++;
        }
        done++;
        // Every 10 files that were actually read, or every second: a walk that
        // skips 3,000 unchanged files in a few ms posts two lines, not 300.
        if (scannedSince >= PROGRESS_FILES || now() - lastProgress >= PROGRESS_MS || done === total) {
          post({ type: 'progress', gen, done, total });
          scannedSince = 0;
          lastProgress = now();
        }
      }
      missing = findMissing(known, st);
    } catch (err) {
      // The store waits for 'done' to end its walk state, so it is posted even
      // after a bug here, with nothing reported as gone.
      warn('walk stopped early: ' + describe(err));
      missing = [];
    }
    if (ep !== epoch) return;
    post({ type: 'done', gen, mode, seen: st.seen, missing });
  }

  return { handle, hello };
}

module.exports = { createScanner, CHUNK_MAX };

// The worker itself. The 'message' listener is what keeps the thread alive: it
// ends only when the store calls terminate().
if (!isMainThread && parentPort) {
  const scanner = createScanner({
    projectsDir: workerData && workerData.projectsDir,
    gen: workerData && workerData.gen,
    post: msg => parentPort.postMessage(msg),
    receive: () => receiveMessageOnPort(parentPort),
  });
  parentPort.on('message', scanner.handle);
  scanner.hello();
}
