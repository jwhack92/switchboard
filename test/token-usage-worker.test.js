const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { PARSE_VERSION, scanTranscript } = require('../token-usage-parse');
const { createScanner, CHUNK_MAX } = require('../workers/scan-tokens');

// Plain node, no database. Every test builds its own projects tree in a temp
// dir (never the real ~/.claude/projects) with synthetic lines. Most tests run
// the real worker thread; the ones that need a file-system error that cannot be
// produced on demand (EACCES, EBUSY, a readdir that fails) drive createScanner
// in this thread with an injected fs.

const WORKER = path.join(__dirname, '..', 'workers', 'scan-tokens.js');
const SLUG = 'C--fixture-proj';
const S1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const S3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const BASE_TS = Date.parse('2026-09-01T12:00:00.000Z');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const roots = [];
const workers = [];
function projectsDir() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tokworker-')));
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())), 'fixture tree must be under the temp dir');
  roots.push(root);
  return root;
}
test.after(async () => {
  for (const w of workers) { try { await w.terminate(); } catch {} }
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
});

function place(dir, rel, body) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

/** One finalised assistant line with usage. */
function usageLine(id, sid, i) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: sid,
    timestamp: new Date(BASE_TS + i * 1000).toISOString(),
    message: {
      id,
      model: 'claude-test-1',
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 10 + (i % 7), cache_creation_input_tokens: 0, cache_read_input_tokens: 5 },
    },
  }) + '\n';
}

/** `n` distinct responses, ids `<prefix>_<i>`. */
function usageLines(prefix, sid, n, from = 0) {
  let out = '';
  for (let i = from; i < from + n; i++) out += usageLine(`${prefix}_${i}`, sid, i);
  return out;
}

// A line that fails the prefilter, long enough to push the offset past the
// 4 KB head so a later append leaves the head hash alone.
const PAD = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(5000) } }) + '\n';

const mainRel = sid => `${SLUG}/${sid}.jsonl`;
const subRel = (sid, agent) => `${SLUG}/${sid}/subagents/agent-${agent}.jsonl`;
const wfRel = (sid, wf, agent) => `${SLUG}/${sid}/subagents/workflows/${wf}/agent-${agent}.jsonl`;

/** A real worker thread plus a pull-style reader of what it posts. */
function start(dir, gen = 1) {
  const w = new Worker(WORKER, { workerData: { projectsDir: dir, gen } });
  workers.push(w);
  const inbox = [];
  let wake = null;
  const h = {
    w,
    gen,
    exitCode: undefined,
    error: null,
    /** The next message of any type; rejects after `ms`. */
    async next(ms = 10000) {
      const end = Date.now() + ms;
      while (inbox.length === 0) {
        if (h.error) throw h.error;
        const left = end - Date.now();
        if (left <= 0) throw new Error('timed out waiting for a worker message');
        await new Promise((res) => {
          const t = setTimeout(() => { wake = null; res(); }, left);
          wake = () => { clearTimeout(t); res(); };
        });
      }
      return inbox.shift();
    },
    /** The next message of one type; anything else before it is returned in `skipped`. */
    async nextOf(type, ms) {
      const skipped = [];
      for (;;) {
        const m = await h.next(ms);
        if (m.type === type) return Object.assign(m, { skipped });
        skipped.push(m);
      }
    },
    /** True when nothing at all arrives for `ms`. */
    async quiet(ms = 300) {
      await sleep(ms);
      return inbox.length === 0;
    },
    ack(chunk, extra) {
      w.postMessage({ type: 'ack', gen: chunk.gen, rel_path: chunk.rel_path, seq: chunk.seq, ...(extra || {}) });
    },
    walk(mode, known, g = gen) { w.postMessage({ type: 'walk', gen: g, mode, known: known || [] }); },
    scan(files, g = gen) { w.postMessage({ type: 'scan', gen: g, files }); },
    /** Read until `done`, acknowledging every chunk. */
    async toDone() {
      const out = { chunks: [], progress: [], warns: [], done: null, all: [] };
      for (;;) {
        const m = await h.next();
        out.all.push(m);
        if (m.type === 'chunk') { out.chunks.push(m); h.ack(m); }
        else if (m.type === 'progress') (m.warn ? out.warns : out.progress).push(m);
        else if (m.type === 'done') { out.done = m; return out; }
      }
    },
  };
  w.on('message', (m) => { inbox.push(m); if (wake) { const f = wake; wake = null; f(); } });
  w.on('error', (e) => { h.error = e; if (wake) { const f = wake; wake = null; f(); } });
  w.on('exit', (code) => { h.exitCode = code; });
  return h;
}

async function started(dir, gen) {
  const h = start(dir, gen);
  const hello = await h.next();
  assert.strictEqual(hello.type, 'hello');
  return h;
}

/**
 * createScanner in this thread. `autoAck` answers every chunk from inside
 * post(), the way the store does after its transaction.
 */
function inThread(dir, opts = {}) {
  const out = { posted: [], scanner: null, done: null };
  let resolveDone;
  out.finished = new Promise((r) => { resolveDone = r; });
  out.scanner = createScanner({
    projectsDir: dir,
    gen: 1,
    fs: opts.fs,
    scan: opts.scan,
    post(m) {
      out.posted.push(m);
      if (m.type === 'chunk' && opts.autoAck !== false) {
        out.scanner.handle({ type: 'ack', gen: m.gen, rel_path: m.rel_path, seq: m.seq });
      }
      if (m.type === 'done') { out.done = m; resolveDone(m); }
    },
  });
  return out;
}

const codeError = (code) => Object.assign(new Error(code + ': injected'), { code });
const under = (dir, rel) => path.join(dir, ...rel.split('/'));

/** Poll until `cond()` is true; the in-thread scanner has no other signal for "it is waiting". */
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await sleep(5);
  }
}

// ------------------------------------------------------------------ hello ----

test('hello carries PARSE_VERSION and the generation', async () => {
  const dir = projectsDir();
  const h = start(dir, 7);
  const hello = await h.next();
  assert.deepStrictEqual(hello, { type: 'hello', gen: 7, parseVersion: PARSE_VERSION });
  assert.ok(Number.isInteger(hello.parseVersion));
  assert.ok(await h.quiet(150), 'nothing is scanned before a request');
});

// ------------------------------------------------------------------- walk ----

test('walk: every matched file is posted and seen, in main / subagent / workflow order', async () => {
  const dir = projectsDir();
  // Created in an order that is NOT the name order, so birthtime decides.
  place(dir, mainRel(S3), usageLines('m3', S3, 2));
  await sleep(25);
  place(dir, mainRel(S1), usageLines('m1', S1, 3));
  await sleep(25);
  place(dir, mainRel(S2), usageLines('m2', S2, 1));
  place(dir, wfRel(S1, 'wf_one', 'w1'), usageLines('w1', S1, 2));
  place(dir, subRel(S1, 'a1'), usageLines('a1', S1, 2));
  place(dir, subRel(S2, 'a2'), usageLines('a2', S2, 1));
  // None of these is a transcript.
  place(dir, `${SLUG}/notes.jsonl`, usageLines('no', S1, 1));
  place(dir, `${SLUG}/${S1}/subagents/agent-a1.meta.json`, '{}');
  place(dir, `${SLUG}/${S1}/subagents/other.jsonl`, usageLines('ot', S1, 1));
  place(dir, `${SLUG}/memory/MEMORY.md`, 'x');
  place(dir, `.git/${S1}.jsonl`, usageLines('git', S1, 1));
  place(dir, 'stray.jsonl', usageLines('st', S1, 1));

  const h = await started(dir, 3);
  h.walk('backfill', []);
  const r = await h.toDone();

  const expectSeen = [mainRel(S1), mainRel(S2), mainRel(S3), subRel(S1, 'a1'), subRel(S2, 'a2'), wfRel(S1, 'wf_one', 'w1')];
  assert.deepStrictEqual(r.done.seen.slice().sort(), expectSeen.slice().sort());
  assert.deepStrictEqual(r.done.missing, []);
  assert.strictEqual(r.done.mode, 'backfill');

  // Main files by floored birthtime (path as the tie-break), computed here from
  // the same stats the worker reads.
  const births = [S1, S2, S3].map(s => ({ rel: mainRel(s), b: Math.floor(fs.statSync(under(dir, mainRel(s))).birthtimeMs) }));
  births.sort((a, b) => (a.b - b.b) || (a.rel < b.rel ? -1 : 1));
  const order = r.chunks.map(c => c.rel_path);
  assert.deepStrictEqual(order, births.map(x => x.rel).concat([subRel(S1, 'a1'), subRel(S2, 'a2'), wfRel(S1, 'wf_one', 'w1')]));
  if (new Set(births.map(x => x.b)).size === 3) {
    assert.deepStrictEqual(order.slice(0, 3), [mainRel(S3), mainRel(S1), mainRel(S2)], 'creation order, not name order');
  }

  for (const c of r.chunks) {
    assert.strictEqual(c.seq, 0);
    assert.strictEqual(c.last, true);
    assert.strictEqual(c.fullRescan, false);
    assert.strictEqual(c.discarded, undefined);
    assert.strictEqual(c.fileRow.rel_path, c.rel_path);
    assert.strictEqual(c.resumed_from, 0);
  }
  assert.deepStrictEqual(r.chunks.map(c => c.candidates.length), births.map(x => ({ [mainRel(S1)]: 3, [mainRel(S2)]: 1, [mainRel(S3)]: 2 }[x.rel])).concat([2, 1, 2]));
  assert.deepStrictEqual(r.chunks.map(c => c.fileRow.kind), ['main', 'main', 'main', 'subagent', 'subagent', 'workflow']);

  // Every message carries the generation.
  for (const m of r.all) assert.strictEqual(m.gen, 3, m.type + ' carries gen');
  // Progress ends at done === total.
  const lastP = r.progress[r.progress.length - 1];
  assert.deepStrictEqual({ done: lastP.done, total: lastP.total }, { done: 6, total: 6 });
  assert.deepStrictEqual(r.warns, []);
});

test('walk over an empty projects dir posts done with nothing seen', async () => {
  const dir = projectsDir();
  const h = await started(dir);
  h.walk('catchup', []);
  const r = await h.toDone();
  assert.deepStrictEqual(r.done, { type: 'done', gen: 1, mode: 'catchup', seen: [], missing: [] });
  assert.strictEqual(r.chunks.length, 0);
});

test('progress is posted at least every 10 scanned files', async () => {
  const dir = projectsDir();
  for (let i = 0; i < 25; i++) {
    const sid = 'cccccccc-0000-4000-8000-' + String(i).padStart(12, '0');
    place(dir, mainRel(sid), usageLines('p' + i, sid, 1));
  }
  const h = await started(dir);
  h.walk('backfill', []);
  const r = await h.toDone();
  assert.strictEqual(r.chunks.length, 25);
  const dones = r.progress.map(p => p.done);
  assert.strictEqual(dones[0], 0, 'a first line with the total, before any file');
  assert.strictEqual(dones[dones.length - 1], 25, 'a last line at done === total');
  assert.ok(r.progress.every(p => p.total === 25));
  assert.deepStrictEqual(dones, dones.slice().sort((a, b) => a - b), 'done never goes back');
  // Never more than 10 chunks between two progress lines. (The exact values
  // are not asserted: on a slow machine the 1 s rule adds lines in between.)
  let run = 0;
  for (const m of r.all) {
    if (m.type === 'chunk') { run++; assert.ok(run <= 10, 'more than 10 files without a progress line'); } else if (m.type === 'progress') run = 0;
  }
  assert.ok(r.progress.length >= 4, '25 files need at least 4 lines, got ' + dones.join(','));
});

// ----------------------------------------------------------- flow control ----

test('the worker waits for the ack of each chunk before posting anything else', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 2));
  await sleep(25);
  place(dir, mainRel(S2), usageLines('m2', S2, 2));
  const h = await started(dir);
  h.walk('backfill', []);

  const c1 = await h.nextOf('chunk');
  assert.strictEqual(c1.rel_path, mainRel(S1));
  assert.ok(await h.quiet(400), 'no chunk, progress or done while the ack is withheld');

  // An ack for something else does not release it.
  h.w.postMessage({ type: 'ack', gen: 1, rel_path: mainRel(S2), seq: 0 });
  h.w.postMessage({ type: 'ack', gen: 1, rel_path: mainRel(S1), seq: 1 });
  h.w.postMessage({ type: 'ack', gen: 99, rel_path: mainRel(S1), seq: 0 });
  assert.ok(await h.quiet(300), 'a non-matching ack is ignored');

  h.ack(c1);
  const c2 = await h.nextOf('chunk');
  assert.strictEqual(c2.rel_path, mainRel(S2));
  assert.ok(await h.quiet(300));
  h.ack(c2);
  const done = await h.nextOf('done');
  assert.deepStrictEqual(done.seen.slice().sort(), [mainRel(S1), mainRel(S2)]);
});

test('a file with more than 500 responses is posted in seq order, at most 500 per chunk, last on the final one', async () => {
  const dir = projectsDir();
  const N = 2 * CHUNK_MAX + 203;
  assert.strictEqual(CHUNK_MAX, 500);
  place(dir, mainRel(S1), usageLines('big', S1, N));
  const h = await started(dir);
  h.scan([{ rel_path: mainRel(S1), prev: null }]);

  const chunks = [];
  for (;;) {
    const c = await h.nextOf('chunk');
    chunks.push(c);
    assert.ok(c.candidates.length <= 500, 'chunk of ' + c.candidates.length);
    if (c.last) break;
    assert.ok(await h.quiet(200), 'seq ' + (c.seq + 1) + ' waits for the ack of seq ' + c.seq);
    h.ack(c);
  }
  assert.deepStrictEqual(chunks.map(c => c.seq), [0, 1, 2]);
  assert.deepStrictEqual(chunks.map(c => c.last), [false, false, true]);
  assert.deepStrictEqual(chunks.map(c => c.candidates.length), [500, 500, 203]);
  const ids = new Set();
  for (const c of chunks) for (const cand of c.candidates) ids.add(cand.message_id);
  assert.strictEqual(ids.size, N, 'every response exactly once across the chunks');
  // The store needs the row on seq 0 (to create the file) and on the last chunk (to move the offset).
  for (const c of chunks) {
    assert.strictEqual(c.rel_path, mainRel(S1));
    assert.strictEqual(c.fileRow.rel_path, mainRel(S1));
    assert.strictEqual(c.fileRow.indexed_bytes, fs.statSync(under(dir, mainRel(S1))).size);
    assert.strictEqual(c.fullRescan, false);
    assert.strictEqual(c.lines_skipped, 0);
  }
  h.ack(chunks[2]);
  assert.ok(await h.quiet(200), 'a scan request posts no done');
});

test('a walk also splits a big file, and a dropped ack ends that file\'s pass', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('big', S1, 1100));
  await sleep(25);
  place(dir, mainRel(S2), usageLines('m2', S2, 1));
  const h = await started(dir);
  h.walk('backfill', []);
  const c0 = await h.nextOf('chunk');
  assert.deepStrictEqual([c0.rel_path, c0.seq, c0.last, c0.candidates.length], [mainRel(S1), 0, false, 500]);
  // The store refused the chunk: the rest of the pass would be refused too.
  h.ack(c0, { dropped: true });
  const c1 = await h.nextOf('chunk');
  assert.deepStrictEqual([c1.rel_path, c1.seq, c1.last], [mainRel(S2), 0, true]);
  h.ack(c1);
  const done = await h.nextOf('done');
  assert.strictEqual(done.seen.length, 2);

  // The refused row was not remembered: a scan with no prev reads from byte 0.
  h.scan([{ rel_path: mainRel(S1), prev: null }]);
  const again = await h.nextOf('chunk');
  assert.deepStrictEqual([again.seq, again.candidates.length, again.resumed_from], [0, 500, 0]);
});

// -------------------------------------------------------- seen and missing ----

test('done.missing lists only known paths that are not on disk', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 1));
  place(dir, subRel(S1, 'a1'), usageLines('a1', S1, 1));
  // On disk, a transcript shape, but under a folder the walk ignores: not seen and NOT gone.
  place(dir, `.git/${S2}.jsonl`, usageLines('g', S2, 1));

  const known = [
    { rel_path: mainRel(S1), size: -1, mtime_ms: 0, head_hash: null, indexed_bytes: 0, tail_hash: null },
    { rel_path: mainRel(S2), size: 10, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 10, tail_hash: 'y' },                 // deleted file
    { rel_path: subRel(S2, 'gone'), size: 10, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 10, tail_hash: 'y' },         // its whole folder is gone
    { rel_path: `gone-slug/${S3}.jsonl`, size: 10, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 10, tail_hash: 'y' },    // whole project removed
    { rel_path: `.git/${S2}.jsonl`, size: 10, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 10, tail_hash: 'y' },
    { rel_path: `${SLUG}\\${S3}.jsonl`, size: 10, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 10, tail_hash: 'y' },     // backslashes are normalised
    { rel_path: `${SLUG}/not-a-transcript.jsonl`, size: 1, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 1, tail_hash: 'y' },
    { rel_path: `../outside/${S3}.jsonl`, size: 1, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 1, tail_hash: 'y' },
  ];
  const h = await started(dir);
  h.walk('catchup', known);
  const r = await h.toDone();
  assert.deepStrictEqual(r.done.seen.slice().sort(), [mainRel(S1), subRel(S1, 'a1')].sort());
  assert.deepStrictEqual(r.done.missing.slice().sort(),
    [mainRel(S2), subRel(S2, 'gone'), `gone-slug/${S3}.jsonl`, mainRel(S3)].sort());
});

test('EACCES and EBUSY never count as gone; a file that cannot be stat\'ed is still seen', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 1));
  place(dir, mainRel(S2), usageLines('m2', S2, 1));
  const locked = under(dir, mainRel(S2));
  const busy = under(dir, mainRel(S3));               // not on disk at all
  const denied = under(dir, subRel(S1, 'zz'));        // not on disk at all
  const flaky = under(dir, mainRel(S1));
  let flakyStats = 0;
  const io = {
    readdirSync: (p, o) => fs.readdirSync(p, o),
    statSync(p) {
      if (p === locked) throw codeError('EACCES');
      if (p === busy) throw codeError('EBUSY');
      if (p === denied) throw codeError('EPERM');
      // Seen by the walk, then ENOENT for anyone who asks again: a file the
      // walk saw is never reported gone by that same walk.
      if (p === flaky && ++flakyStats > 1) throw codeError('ENOENT');
      return fs.statSync(p);
    },
  };
  const row = rel => ({ rel_path: rel, size: 1, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 1, tail_hash: 'y' });
  const t = inThread(dir, { fs: io });
  t.scanner.handle({ type: 'walk', gen: 1, mode: 'catchup', known: [row(mainRel(S1)), row(mainRel(S2)), row(mainRel(S3)), row(subRel(S1, 'zz')), row(subRel(S1, 'really-gone'))] });
  const done = await t.finished;
  // S2 is in the listing but its stat failed: seen, warned about, not scanned.
  assert.deepStrictEqual(done.seen.slice().sort(), [mainRel(S1), mainRel(S2)]);
  assert.deepStrictEqual(done.missing, [subRel(S1, 'really-gone')], 'only the ENOENT path');
  const warns = t.posted.filter(m => m.type === 'progress' && m.warn);
  assert.deepStrictEqual(warns.map(w => [w.rel_path, w.code]), [[mainRel(S2), 'EACCES']]);
  assert.deepStrictEqual(t.posted.filter(m => m.type === 'chunk').map(c => c.rel_path), [mainRel(S1)]);
});

test('a readdir that fails is a progress warn, and nothing under that folder is reported gone', async () => {
  const dir = projectsDir();
  const OTHER = 'C--other-proj';
  place(dir, mainRel(S1), usageLines('m1', S1, 1));
  place(dir, `${OTHER}/${S2}.jsonl`, usageLines('m2', S2, 1));
  const lockedDir = path.join(dir, OTHER);
  const io = {
    readdirSync(p, o) {
      if (p === lockedDir) throw codeError('EACCES');
      return fs.readdirSync(p, o);
    },
    // Even a stat that says ENOENT is not believed under a folder that could not be listed.
    statSync(p) {
      if (p.startsWith(lockedDir)) throw codeError('ENOENT');
      return fs.statSync(p);
    },
  };
  const row = rel => ({ rel_path: rel, size: 1, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 1, tail_hash: 'y' });
  const t = inThread(dir, { fs: io });
  t.scanner.handle({ type: 'walk', gen: 1, mode: 'catchup', known: [row(`${OTHER}/${S2}.jsonl`), row(`${OTHER}/${S3}.jsonl`), row(mainRel(S3))] });
  const done = await t.finished;
  assert.deepStrictEqual(done.seen, [mainRel(S1)]);
  assert.deepStrictEqual(done.missing, [mainRel(S3)]);
  const warns = t.posted.filter(m => m.type === 'progress' && m.warn);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0].warn, /cannot read folder C--other-proj: EACCES/);
  assert.strictEqual(warns[0].gen, 1);
});

test('a projects dir that cannot be listed reports nothing as gone', async () => {
  const dir = projectsDir();
  const row = rel => ({ rel_path: rel, size: 1, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 1, tail_hash: 'y' });
  for (const code of ['EACCES', 'ENOENT']) {
    const io = {
      readdirSync() { throw codeError(code); },
      statSync() { throw codeError('ENOENT'); },
    };
    const t = inThread(dir, { fs: io });
    t.scanner.handle({ type: 'walk', gen: 1, mode: 'catchup', known: [row(mainRel(S1)), row(subRel(S1, 'a'))] });
    const done = await t.finished;
    assert.deepStrictEqual([done.seen, done.missing], [[], []], code);
    assert.strictEqual(t.posted.filter(m => m.type === 'progress' && m.warn).length, 1, code);
  }
});

// ------------------------------------------------------- scan during walk ----

test('a scan sent during a walk is answered before the walk\'s next file, and the walk then resumes it from the worker\'s own row', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 2));
  await sleep(25);
  place(dir, mainRel(S2), usageLines('m2', S2, 2));
  place(dir, wfRel(S1, 'wf_one', 'late'), PAD + usageLines('wf', S1, 4));
  const h = await started(dir);
  h.walk('backfill', []);      // the store knows nothing: known is empty

  const c1 = await h.nextOf('chunk');
  assert.strictEqual(c1.rel_path, mainRel(S1));
  // The walk is now waiting. The workflow file is last in walk order.
  h.scan([{ rel_path: wfRel(S1, 'wf_one', 'late'), prev: null }]);
  h.ack(c1);

  const c2 = await h.nextOf('chunk');
  assert.strictEqual(c2.rel_path, wfRel(S1, 'wf_one', 'late'), 'the scan request overtakes the walk');
  assert.deepStrictEqual([c2.candidates.length, c2.resumed_from, c2.fullRescan], [4, 0, false]);
  h.ack(c2);

  const c3 = await h.nextOf('chunk');
  assert.strictEqual(c3.rel_path, mainRel(S2), 'then the walk goes on with its next file');
  h.ack(c3);

  // The walk reaches the file it was asked to scan in between. Its known list
  // (empty) is older than the row the worker posted, so it resumes from that
  // row instead of posting the four responses again.
  const c4 = await h.nextOf('chunk');
  assert.strictEqual(c4.rel_path, wfRel(S1, 'wf_one', 'late'));
  assert.deepStrictEqual([c4.candidates.length, c4.fullRescan, c4.last], [0, false, true]);
  assert.strictEqual(c4.resumed_from, c2.fileRow.indexed_bytes);
  assert.strictEqual(c4.fileRow.indexed_bytes, c2.fileRow.indexed_bytes);
  h.ack(c4);
  const done = await h.nextOf('done');
  assert.strictEqual(done.seen.length, 3);
});

test('a scan request overtakes a catch-up walk that never waits for an ack', async () => {
  // In-thread, with the inbox emulated: the walk skips every file, so the only
  // way a request can get in is the inbox check between files.
  const dir = projectsDir();
  const sids = [];
  for (let i = 0; i < 6; i++) {
    const sid = 'dddddddd-0000-4000-8000-' + String(i).padStart(12, '0');
    sids.push(sid);
    place(dir, mainRel(sid), usageLines('q' + i, sid, 1));
  }
  const known = sids.map((sid) => {
    const st = fs.statSync(under(dir, mainRel(sid)));
    return { rel_path: mainRel(sid), size: st.size, mtime_ms: Math.floor(st.mtimeMs), head_hash: 'v1:x', indexed_bytes: st.size, tail_hash: 'y' };
  });
  const inbox = [];
  const posted = [];
  let stats = 0;
  const io = {
    readdirSync: (p, o) => fs.readdirSync(p, o),
    statSync(p) {
      // The request "arrives" while the walk is collecting, after it started.
      if (++stats === 3) inbox.push({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(sids[5]), prev: null }] });
      return fs.statSync(p);
    },
  };
  let scanner = null;
  const finished = new Promise((resolve) => {
    scanner = createScanner({
      projectsDir: dir,
      gen: 1,
      fs: io,
      receive: () => (inbox.length ? { message: inbox.shift() } : undefined),
      post(m) {
        posted.push(m);
        if (m.type === 'chunk') scanner.handle({ type: 'ack', gen: 1, rel_path: m.rel_path, seq: m.seq });
        if (m.type === 'done') resolve(m);
      },
    });
  });
  scanner.handle({ type: 'walk', gen: 1, mode: 'catchup', known });
  const done = await finished;
  assert.strictEqual(done.seen.length, 6);
  const types = posted.map(m => m.type);
  assert.deepStrictEqual(posted.filter(m => m.type === 'chunk').map(c => c.rel_path), [mainRel(sids[5])]);
  assert.ok(types.indexOf('chunk') < types.indexOf('done'));
  // Served before the walk listed its files (the first progress line).
  assert.ok(types.indexOf('chunk') < types.indexOf('progress'));
});

// ---------------------------------------------------------------- catchup ----

test('catchup skips files whose size and mtime match the known list, and scans the rest', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 3));
  await sleep(25);
  place(dir, mainRel(S2), PAD + usageLines('m2', S2, 2));
  place(dir, subRel(S1, 'a1'), PAD + usageLines('a1', S1, 2));

  // A first worker does the backfill; its rows are what the store would hold.
  const first = await started(dir);
  first.walk('backfill', []);
  const r1 = await first.toDone();
  assert.strictEqual(r1.chunks.length, 3);
  const known = r1.chunks.map(c => c.fileRow);
  await first.w.terminate();

  // A new worker (no rows of its own): unchanged files are not opened at all.
  const h = await started(dir);
  h.walk('catchup', known);
  const r2 = await h.toDone();
  assert.strictEqual(r2.chunks.length, 0, 'nothing changed, nothing posted');
  assert.deepStrictEqual(r2.done.seen.slice().sort(), known.map(k => k.rel_path).sort());
  assert.deepStrictEqual(r2.done.missing, []);
  assert.strictEqual(r2.done.mode, 'catchup');

  // One file grows: exactly that file is scanned, resumed from its offset.
  fs.appendFileSync(under(dir, mainRel(S2)), usageLines('m2', S2, 2, 2));
  h.walk('catchup', known);
  const r3 = await h.toDone();
  assert.deepStrictEqual(r3.chunks.map(c => c.rel_path), [mainRel(S2)]);
  const grown = r3.chunks[0];
  const before = known.find(k => k.rel_path === mainRel(S2));
  assert.deepStrictEqual(grown.candidates.map(c => c.message_id), ['m2_2', 'm2_3'], 'only the appended responses');
  assert.strictEqual(grown.resumed_from, before.indexed_bytes);
  assert.strictEqual(grown.fullRescan, false);

  // A row the store marks for a rescan (size -1, see knownFiles in
  // token-usage.js) is never skipped, even though the file has not changed.
  const marked = known.map(k => (k.rel_path === mainRel(S1) ? { ...k, size: -1 } : k))
    .map(k => (k.rel_path === mainRel(S2) ? grown.fileRow : k));
  h.walk('catchup', marked);
  const r4 = await h.toDone();
  assert.deepStrictEqual(r4.chunks.map(c => c.rel_path), [mainRel(S1)]);
  assert.deepStrictEqual([r4.chunks[0].candidates.length, r4.chunks[0].fullRescan], [0, false], 'resumed: nothing new in it');

  // Backfill mode never skips.
  h.walk('backfill', marked);
  const r5 = await h.toDone();
  assert.strictEqual(r5.chunks.length, 3);

  // Same size, another mtime: not "unchanged". The parser cannot resume a file
  // that was touched without growing, so it is read again from byte 0.
  const current = r5.chunks.map(c => c.fileRow);
  const touched = under(dir, subRel(S1, 'a1'));
  const stTouched = fs.statSync(touched);
  fs.utimesSync(touched, stTouched.atime, new Date(stTouched.mtimeMs + 5000));
  h.walk('catchup', current);
  const r6 = await h.toDone();
  assert.deepStrictEqual(r6.chunks.map(c => c.rel_path), [subRel(S1, 'a1')]);
  assert.deepStrictEqual([r6.chunks[0].fullRescan, r6.chunks[0].candidates.length, r6.chunks[0].resumed_from], [true, 2, 0]);
});

// ----------------------------------------------------------------- resume ----

test('a second scan of an unchanged file resumes and reads only the hashes', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 40));
  const size = fs.statSync(under(dir, mainRel(S1))).size;
  assert.ok(size > 4096 + 256);

  // Count what the scan pulls off disk through the parser's own fs seam.
  let bytes = 0;
  const counting = {
    openSync: (p, f) => fs.openSync(p, f),
    fstatSync: fd => fs.fstatSync(fd),
    closeSync: fd => fs.closeSync(fd),
    readSync(fd, buf, off, len, pos) {
      const n = fs.readSync(fd, buf, off, len, pos);
      bytes += n;
      return n;
    },
  };
  const t = inThread(dir, { scan: (abs, prev, pd) => scanTranscript(abs, prev, pd, { fs: counting }) });
  const chunks = () => t.posted.filter(m => m.type === 'chunk');

  t.scanner.handle({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(S1), prev: null }] });
  await until(() => chunks().length === 1);
  const first = chunks()[0];
  assert.strictEqual(first.candidates.length, 40);
  assert.strictEqual(first.fileRow.indexed_bytes, size);
  assert.ok(bytes >= size, 'the first pass reads the whole file');

  bytes = 0;
  t.scanner.handle({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(S1), prev: first.fileRow }] });
  await until(() => chunks().length === 2);
  const second = chunks()[1];
  assert.deepStrictEqual([second.candidates.length, second.fullRescan, second.seq, second.last], [0, false, 0, true]);
  assert.strictEqual(second.resumed_from, size);
  assert.deepStrictEqual(second.fileRow, first.fileRow);
  assert.ok(bytes <= 4096 + 256, 'head and tail hash only, read ' + bytes + ' bytes of ' + size);
});

test('the same through the real worker: an unchanged file posts no candidates, a grown one only the new ones', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 5));
  const h = await started(dir);
  h.scan([{ rel_path: mainRel(S1), prev: null }]);
  const a = await h.nextOf('chunk');
  h.ack(a);
  assert.strictEqual(a.candidates.length, 5);

  h.scan([{ rel_path: mainRel(S1), prev: a.fileRow }]);
  const b = await h.nextOf('chunk');
  h.ack(b);
  assert.deepStrictEqual([b.candidates.length, b.fullRescan, b.resumed_from], [0, false, a.fileRow.indexed_bytes]);
  assert.strictEqual(b.fileRow.head_hash, a.fileRow.head_hash);
  assert.strictEqual(b.fileRow.tail_hash, a.fileRow.tail_hash);

  fs.appendFileSync(under(dir, mainRel(S1)), usageLines('m1', S1, 3, 5));
  h.scan([{ rel_path: mainRel(S1), prev: b.fileRow }]);
  const c = await h.nextOf('chunk');
  h.ack(c);
  assert.deepStrictEqual(c.candidates.map(x => x.message_id), ['m1_5', 'm1_6', 'm1_7']);
  assert.strictEqual(c.resumed_from, a.fileRow.indexed_bytes);

  // A row that does not describe this file: full rescan, flagged for the store.
  h.scan([{ rel_path: mainRel(S1), prev: { ...c.fileRow, head_hash: null } }]);
  const d = await h.nextOf('chunk');
  h.ack(d);
  assert.deepStrictEqual([d.candidates.length, d.fullRescan, d.resumed_from], [8, true, 0]);
});

test('whose row wins: the worker\'s own for a request sent before its ack, the store\'s for one sent after', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 6));
  const h = await started(dir);
  h.scan([{ rel_path: mainRel(S1), prev: null }]);
  const a = await h.nextOf('chunk');
  assert.strictEqual(a.candidates.length, 6);

  // The store posts a second request BEFORE it has stored chunk a: the row it
  // sends (none) is older than the one the worker is about to have confirmed.
  h.scan([{ rel_path: mainRel(S1), prev: null }]);
  h.ack(a);
  const b = await h.nextOf('chunk');
  assert.deepStrictEqual([b.candidates.length, b.resumed_from], [0, a.fileRow.indexed_bytes], 'resumed from the worker\'s own row');
  h.ack(b);
  assert.ok(await h.quiet(150));

  // A request sent after the ack was read from a store that held the row. If
  // the store now says "no row" (a reset), the store is right.
  h.scan([{ rel_path: mainRel(S1), prev: null }]);
  const c = await h.nextOf('chunk');
  assert.deepStrictEqual([c.candidates.length, c.resumed_from, c.fullRescan], [6, 0, false]);
  h.ack(c);
});

test('the same path queued twice before it is served is scanned once, with the later row', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 3));
  await sleep(25);
  place(dir, mainRel(S2), PAD + usageLines('m2', S2, 2));
  const h = await started(dir);
  h.scan([{ rel_path: mainRel(S1), prev: null }]);
  const a = await h.nextOf('chunk');
  // While the worker waits: S2 twice, in two requests.
  h.scan([{ rel_path: mainRel(S2), prev: null }]);
  h.scan([{ rel_path: `${SLUG}\\${S2}.jsonl`, prev: null }]);
  h.ack(a);
  const b = await h.nextOf('chunk');
  assert.strictEqual(b.rel_path, mainRel(S2));
  h.ack(b);
  assert.ok(await h.quiet(300), 'no second pass over the same path');
});

// ----------------------------------------------------------------- errors ----

test('a file that cannot be scanned is reported and the worker carries on', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 2));
  place(dir, `${SLUG}/notes.jsonl`, usageLines('n', S1, 2));
  const h = await started(dir);
  h.scan([
    { rel_path: mainRel(S3), prev: null },                 // a transcript path with no file behind it
    { rel_path: `${SLUG}/notes.jsonl`, prev: null },       // not a transcript: ignored without a word
    { rel_path: 'stray.jsonl', prev: null },
    { rel_path: `${SLUG}/${S1}/subagents/workflows/../agent-x.jsonl`, prev: null },
    { rel_path: 12345, prev: null },
    { rel_path: mainRel(S1), prev: null },
  ]);
  const warn = await h.next();
  assert.deepStrictEqual(
    { type: warn.type, gen: warn.gen, rel_path: warn.rel_path, code: warn.code },
    { type: 'progress', gen: 1, rel_path: mainRel(S3), code: 'ENOENT' });
  assert.match(warn.warn, /cannot scan .*: ENOENT$/);
  const c = await h.next();
  assert.deepStrictEqual([c.type, c.rel_path, c.candidates.length], ['chunk', mainRel(S1), 2]);
  h.ack(c);
  assert.ok(await h.quiet(200));
  assert.strictEqual(h.exitCode, undefined, 'still running');

  // Malformed requests do not kill it either.
  h.w.postMessage(null);
  h.w.postMessage('walk');
  h.w.postMessage({ type: 'scan', gen: 1, files: 'nope' });
  h.w.postMessage({ type: 'scan', gen: 1 });
  h.w.postMessage({ type: 'ack', gen: 1 });
  h.w.postMessage({ type: 'unknown', gen: 1 });
  h.scan([{ rel_path: mainRel(S1), prev: c.fileRow }]);
  const again = await h.next();
  assert.deepStrictEqual([again.type, again.candidates.length], ['chunk', 0]);
  h.ack(again);
});

test('an exception in the scan of one file does not stop the walk', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 1));
  await sleep(25);
  place(dir, mainRel(S2), usageLines('m2', S2, 1));
  await sleep(25);
  place(dir, mainRel(S3), usageLines('m3', S3, 1));
  const bad = under(dir, mainRel(S2));
  const t = inThread(dir, {
    scan(abs, prev, pd) {
      if (abs === bad) throw new TypeError('boom in the parser');
      return scanTranscript(abs, prev, pd);
    },
  });
  t.scanner.handle({ type: 'walk', gen: 1, mode: 'backfill', known: [] });
  const done = await t.finished;
  assert.deepStrictEqual(done.seen.slice().sort(), [mainRel(S1), mainRel(S2), mainRel(S3)]);
  assert.deepStrictEqual(t.posted.filter(m => m.type === 'chunk').map(c => c.rel_path), [mainRel(S1), mainRel(S3)]);
  const warns = t.posted.filter(m => m.type === 'progress' && m.warn);
  assert.strictEqual(warns.length, 1);
  assert.deepStrictEqual([warns[0].rel_path, warns[0].code], [mainRel(S2), 'EUNKNOWN']);
  assert.match(warns[0].warn, /TypeError: boom in the parser/);
  const lastP = t.posted.filter(m => m.type === 'progress' && !m.warn).pop();
  assert.deepStrictEqual([lastP.done, lastP.total], [3, 3], 'the failed file still counts as processed');
});

test('a walk that hits a bug still posts done, with nothing reported gone', async () => {
  // The store ends its walk state only on done; a walk that died silently
  // would leave it "walking" until the worker is replaced.
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 1));
  const slugDir = path.join(dir, SLUG);
  const io = {
    readdirSync(p, o) {
      // An entry no real readdir returns: its name is not a string.
      if (p === slugDir) return [{ name: undefined, isDirectory: () => false, isSymbolicLink: () => false }];
      return fs.readdirSync(p, o);
    },
    statSync() { throw codeError('ENOENT'); },
  };
  const t = inThread(dir, { fs: io });
  t.scanner.handle({ type: 'walk', gen: 1, mode: 'backfill', known: [{ rel_path: mainRel(S2), size: 1, mtime_ms: 1, head_hash: 'v1:x', indexed_bytes: 1, tail_hash: 'y' }] });
  const done = await t.finished;
  assert.deepStrictEqual(done, { type: 'done', gen: 1, mode: 'backfill', seen: [], missing: [] });
  const warns = t.posted.filter(m => m.type === 'progress' && m.warn);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0].warn, /^walk stopped early: TypeError/);

  // And the scanner still works afterwards.
  const t2chunks = () => t.posted.filter(m => m.type === 'chunk');
  t.scanner.handle({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(S1), prev: null }] });
  await until(() => t2chunks().length === 1);
  assert.strictEqual(t2chunks()[0].candidates.length, 1);
});

test('a discarded pass posts one chunk with discarded true and is not remembered', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 3));
  let calls = 0;
  const seenPrev = [];
  const t = inThread(dir, {
    scan(abs, prev, pd) {
      seenPrev.push(prev);
      const real = scanTranscript(abs, prev, pd);
      if (++calls !== 1) return real;
      // The shape the parser returns when the file changed under the read.
      return { discarded: true, fullRescan: false, fileRow: { ...real.fileRow, head_hash: null, indexed_bytes: 0, tail_hash: null }, candidates: [], compactions: [], lines_skipped: 0 };
    },
  });
  const chunks = () => t.posted.filter(m => m.type === 'chunk');
  t.scanner.handle({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(S1), prev: null }] });
  await until(() => chunks().length === 1);
  const d = chunks()[0];
  assert.deepStrictEqual(
    { discarded: d.discarded, seq: d.seq, last: d.last, n: d.candidates.length, comp: d.compactions.length, full: d.fullRescan, rel: d.rel_path, gen: d.gen },
    { discarded: true, seq: 0, last: true, n: 0, comp: 0, full: false, rel: mainRel(S1), gen: 1 });

  // The retry starts from what the store sends (nothing), not from the discarded pass.
  t.scanner.handle({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(S1), prev: null }] });
  await until(() => chunks().length === 2);
  assert.strictEqual(seenPrev[1], null);
  assert.deepStrictEqual([chunks()[1].discarded, chunks()[1].candidates.length], [undefined, 3]);
});

test('compactions travel with seq 0 and lines_skipped with every chunk', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), 'x');
  const cands = [];
  for (let i = 0; i < 501; i++) cands.push({ message_id: 'c' + i });
  const fileRow = { rel_path: mainRel(S1), kind: 'main', slug: SLUG, session_id: S1, agent_id: null, wf_id: null, size: 1, mtime_ms: 1, birthtime_ms: 1, head_hash: 'v1:h', indexed_bytes: 1, tail_hash: 't' };
  const t = inThread(dir, {
    scan: () => ({ discarded: false, fullRescan: true, fileRow, candidates: cands, compactions: [{ uuid: 'k1' }, { uuid: 'k2' }], lines_skipped: 4 }),
  });
  const chunks = () => t.posted.filter(m => m.type === 'chunk');
  t.scanner.handle({ type: 'scan', gen: 1, files: [{ rel_path: mainRel(S1), prev: { head_hash: 'v1:old', indexed_bytes: 9, tail_hash: 'o', mtime_ms: 0 } }] });
  await until(() => chunks().length === 2);
  const [c0, c1] = chunks();
  assert.deepStrictEqual([c0.candidates.length, c0.compactions.length, c0.last, c0.fullRescan, c0.lines_skipped, c0.resumed_from], [500, 2, false, true, 4, 0]);
  assert.deepStrictEqual([c1.candidates.length, c1.compactions.length, c1.last, c1.fullRescan, c1.lines_skipped, c1.seq], [1, 0, true, true, 4, 1]);
});

// ------------------------------------------------------------- generation ----

test('a request of an older generation is ignored; a newer one drops the work in flight and its rows', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), PAD + usageLines('m1', S1, 2));
  await sleep(25);
  place(dir, mainRel(S2), PAD + usageLines('m2', S2, 2));
  const h = await started(dir, 5);

  h.walk('backfill', [], 4);
  h.scan([{ rel_path: mainRel(S1), prev: null }], 4);
  assert.ok(await h.quiet(300), 'generation 4 is over');

  h.walk('backfill', [], 5);
  const c1 = await h.nextOf('chunk');
  assert.deepStrictEqual([c1.gen, c1.rel_path], [5, mainRel(S1)]);
  // The store rebuilt: it never acks the old chunk, and asks again as generation 6.
  h.walk('backfill', [], 6);
  const r = await h.toDone();
  assert.ok(r.all.every(m => m.gen === 6), 'nothing more from generation 5');
  assert.deepStrictEqual(r.chunks.map(c => c.rel_path), [mainRel(S1), mainRel(S2)]);
  assert.ok(r.chunks.every(c => c.candidates.length === 2 && c.resumed_from === 0), 'rows of the old generation are forgotten');
  assert.strictEqual(r.all.filter(m => m.type === 'done').length, 1, 'the abandoned walk posts no done');

  // A late ack of the old generation does nothing.
  h.ack(c1);
  assert.ok(await h.quiet(200));
});

// -------------------------------------------------------------- lifetime ----

test('the worker stays alive until terminate()', async () => {
  const dir = projectsDir();
  place(dir, mainRel(S1), usageLines('m1', S1, 1));
  const h = await started(dir);
  h.walk('backfill', []);
  const r = await h.toDone();
  assert.strictEqual(r.chunks.length, 1);

  await sleep(500);
  assert.strictEqual(h.exitCode, undefined, 'no exit after done');
  assert.strictEqual(h.error, null);

  // Still serving.
  h.scan([{ rel_path: mainRel(S1), prev: r.chunks[0].fileRow }]);
  const c = await h.nextOf('chunk');
  h.ack(c);
  await sleep(200);
  assert.strictEqual(h.exitCode, undefined);

  const exited = new Promise(res => h.w.once('exit', res));
  await h.w.terminate();
  await exited;
  assert.notStrictEqual(h.exitCode, undefined, 'exits on terminate()');
});

test('requiring the worker file outside a worker thread starts nothing', () => {
  assert.strictEqual(typeof createScanner, 'function');
  // No database, no file writes: the module needs only built-ins and the parser.
  const src = fs.readFileSync(WORKER, 'utf8');
  const required = Array.from(src.matchAll(/require\('([^']+)'\)/g)).map(m => m[1]).sort();
  assert.deepStrictEqual(required, ['../token-usage-parse', 'fs', 'path', 'worker_threads']);
  assert.ok(!/writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|renameSync/.test(src), 'the worker never writes');
});
