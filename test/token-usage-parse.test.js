const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PARSE_VERSION, classifyPath, parseUsageLine, parseCompaction, decideUpsert, reduceFile,
  scanTranscript, COUNTER_FIELDS, OWNER_FIELDS,
} = require('../token-usage-parse');

// Plain node, no database. Fixtures are static .jsonl files (a .js file under
// test/ would be run by `node --test`); each test copies what it needs into a
// temp projects tree, because the kind and the owner come from the path.

const FIX = path.join(__dirname, 'fixtures', 'token');
const SLUG = 'C--fixture-proj';
const S_O = 'aaaaaaaa-0000-4000-8000-000000000001';   // the original session
const S_C = 'aaaaaaaa-0000-4000-8000-000000000002';   // its continuation
const S_F = 'aaaaaaaa-0000-4000-8000-000000000003';   // a fork

const fixture = name => fs.readFileSync(path.join(FIX, name));

const roots = [];
function projectsDir() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tokparse-')));
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())), 'fixture tree must be under the temp dir');
  roots.push(root);
  return root;
}
test.after(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
});

function place(dir, rel, body) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

const mainRel = sid => `${SLUG}/${sid}.jsonl`;

/** Byte offsets just past each newline. */
function lineEnds(buf) {
  const ends = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0A) ends.push(i + 1);
  return ends;
}

/** A stand-in for the store: one row per message_id, every sighting decided by
 *  decideUpsert in the order given. */
function applyScans(scans) {
  const rows = new Map();
  for (const s of scans) {
    for (const c of s.candidates) rows.set(c.message_id, decideUpsert(rows.get(c.message_id), c).row);
  }
  return rows;
}

const sorted = rows => Array.from(rows.values()).sort((a, b) => (a.message_id < b.message_id ? -1 : 1));

function sumBy(rows, key, field) {
  const out = {};
  for (const r of rows.values()) out[r[key]] = (out[r[key]] || 0) + r[field];
  return out;
}

/**
 * fs with a few answers replaced. Birthtimes cannot be set on Windows files,
 * so the tests that depend on one inject it here instead of trusting the clock.
 *   births   absolute path -> birthtimeMs
 *   patch    (callIndex, stat, absPath) -> fields to override on that fstat
 * `bytesRead` counts what readSync pulled off disk.
 */
function fakeFs({ births, patch } = {}) {
  const paths = new Map();
  const calls = new Map();
  const io = {
    bytesRead: 0,
    openSync(p, flags) {
      const fd = fs.openSync(p, flags);
      paths.set(fd, path.resolve(p));
      calls.set(fd, 0);
      return fd;
    },
    fstatSync(fd) {
      const real = fs.fstatSync(fd);
      const p = paths.get(fd);
      const st = { size: real.size, mtimeMs: real.mtimeMs, birthtimeMs: real.birthtimeMs, dev: real.dev, ino: real.ino };
      if (births && births[p] !== undefined) st.birthtimeMs = births[p];
      const n = calls.get(fd);
      calls.set(fd, n + 1);
      if (patch) Object.assign(st, patch(n, st, p) || {});
      return st;
    },
    readSync(fd, buf, off, len, pos) {
      const n = fs.readSync(fd, buf, off, len, pos);
      io.bytesRead += n;
      return n;
    },
    closeSync(fd) { paths.delete(fd); calls.delete(fd); return fs.closeSync(fd); },
  };
  return io;
}

const MAIN_FILE = { kind: 'main', slug: SLUG, sessionId: S_O, agentId: null, wfId: null, birthMs: 1000 };

function usageLine(over = {}, usage = {}) {
  return {
    type: 'assistant',
    sessionId: 'ffffffff-0000-4000-8000-00000000000f',
    timestamp: '2026-10-03T12:00:00.000Z',
    message: {
      id: 'msg_unit1', model: 'claude-opus-4-5-20251101', stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, ...usage },
      ...over.message,
    },
    ...over.top,
  };
}

function cand(over = {}) {
  return {
    message_id: 'msg_x', session_id: S_O, kind: 'main', slug: SLUG, wf_id: null, agent_id: null,
    owner_birth_ms: 1000, model: 'm', ts_ms: 5000, input: 1, output: 10, cache_write: 2,
    cache_write_5m: 2, cache_write_1h: 0, cache_read: 3, thinking: null, finalized: 0, stop_reason: null,
    ...over,
  };
}

// --- classifyPath ---

test('classifyPath: the three shapes, both separators', () => {
  assert.equal(PARSE_VERSION, 1);
  assert.deepStrictEqual(classifyPath(`${SLUG}/${S_O}.jsonl`),
    { kind: 'main', slug: SLUG, sessionId: S_O, agentId: null, wfId: null });
  assert.deepStrictEqual(classifyPath(`${SLUG}/${S_O}/subagents/agent-a1b2c3.jsonl`),
    { kind: 'subagent', slug: SLUG, sessionId: S_O, agentId: 'agent-a1b2c3', wfId: null });
  assert.deepStrictEqual(classifyPath(`${SLUG}/${S_O}/subagents/workflows/wf_1/agent-a1b2c3.jsonl`),
    { kind: 'workflow', slug: SLUG, sessionId: S_O, agentId: 'agent-a1b2c3', wfId: 'wf_1' });
  assert.deepStrictEqual(classifyPath(`${SLUG}\\${S_O}\\subagents\\workflows\\wf_1\\agent-a1b2c3.jsonl`),
    classifyPath(`${SLUG}/${S_O}/subagents/workflows/wf_1/agent-a1b2c3.jsonl`));
  assert.deepStrictEqual(classifyPath(`${SLUG}\\${S_O}.jsonl`), classifyPath(`${SLUG}/${S_O}.jsonl`));
});

test('classifyPath: everything else is ignored', () => {
  const no = [
    `${SLUG}/journal.jsonl`,
    `${SLUG}/sessions-index.json`,
    `${SLUG}/${S_O}/subagents/agent-x.meta.json`,
    `${SLUG}/${S_O}/subagents/workflows/wf_1.json`,
    `${SLUG}/${S_O}/subagents/workflows/wf_1/journal.jsonl`,   // four levels deep, not an agent file
    `${SLUG}/${S_O}/subagents/workflows/wf_1/deeper/agent-x.jsonl`,
    `${SLUG}/${S_O}/subagents/notes.jsonl`,
    `${SLUG}/${S_O}/tool-results/toolu_1.jsonl`,
    `${SLUG}/memory/MEMORY.md`,
    '.git/config',
    '.git/objects/ab/cdef.jsonl',
    `${S_O}.jsonl`,                                            // no slug folder
    `../${S_O}.jsonl`,                                         // outside the projects dir
    `${SLUG}/${S_O.toUpperCase()}.jsonl`,                      // upper-case hex is rejected
    `${SLUG}/${S_O.slice(1)}.jsonl`,                           // 35 characters
    `C:/Users/x/.claude/projects/${SLUG}/${S_O}.jsonl`,        // not relative
    '', null, undefined, 42,
  ];
  for (const p of no) assert.equal(classifyPath(p), null, String(p));
});

// --- parseUsageLine ---

test('parseUsageLine: an assistant line with usage becomes a candidate', () => {
  const c = parseUsageLine(usageLine({}, {
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    output_tokens_details: { thinking_tokens: 7 },
  }), MAIN_FILE);
  assert.deepStrictEqual(c, {
    message_id: 'msg_unit1', session_id: S_O, kind: 'main', slug: SLUG, wf_id: null, agent_id: null,
    owner_birth_ms: 1000, model: 'claude-opus-4-5-20251101', ts_ms: Date.parse('2026-10-03T12:00:00.000Z'),
    input: 10, output: 20, cache_write: 30, cache_write_5m: 10, cache_write_1h: 20, cache_read: 40,
    thinking: 7, finalized: 1, stop_reason: 'end_turn',
  });
  assert.ok(!('local_day' in c), 'the store stamps local_day, not the parser');
});

test('parseUsageLine: finalized follows stop_reason, thinking is null when absent', () => {
  const nul = parseUsageLine(usageLine({ message: { stop_reason: null } }), MAIN_FILE);
  assert.equal(nul.finalized, 0);
  assert.equal(nul.stop_reason, null);
  assert.equal(nul.thinking, null);
  const line = usageLine();
  delete line.message.stop_reason;
  assert.equal(parseUsageLine(line, MAIN_FILE).finalized, 0);
  assert.equal(parseUsageLine(usageLine({ message: { stop_reason: 'tool_use' } }), MAIN_FILE).finalized, 1);
});

test('parseUsageLine: lines that are not a counted response give null without counting a skip', () => {
  const stats = { skipped: 0 };
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const cases = {
    synthetic: usageLine({ message: { model: '<synthetic>' } }),
    'all four counters zero': usageLine({}, zero),
    // Real numbers only in usage.iterations: must never be consulted.
    'zeroed copy with iterations': usageLine({}, { ...zero,
      iterations: [{ input_tokens: 6, output_tokens: 396, cache_creation_input_tokens: 300, cache_read_input_tokens: 51200 }] }),
    'user line with toolUseResult.usage': { type: 'user', timestamp: '2026-10-03T12:00:00.000Z',
      message: { role: 'user', content: 'x' }, toolUseResult: { usage: { input_tokens: 9, output_tokens: 9 } } },
    'attachment.usage': { type: 'attachment', timestamp: '2026-10-03T12:00:00.000Z',
      attachment: { usage: { input_tokens: 9, output_tokens: 9 } } },
    'assistant without usage': { type: 'assistant', timestamp: '2026-10-03T12:00:00.000Z', message: { id: 'm', model: 'x' } },
    'message is a string': { type: 'assistant', message: 'usage' },
    'not an object': 'assistant',
    null: null,
  };
  for (const [name, obj] of Object.entries(cases)) {
    assert.equal(parseUsageLine(obj, MAIN_FILE, stats), null, name);
  }
  assert.equal(stats.skipped, 0);
});

test('parseUsageLine: field hardening', () => {
  const stats = { skipped: 0 };
  const noId = usageLine();
  delete noId.message.id;
  assert.equal(parseUsageLine(noId, MAIN_FILE, stats), null);
  assert.equal(parseUsageLine(usageLine({ message: { id: '' } }), MAIN_FILE, stats), null);
  assert.equal(parseUsageLine(usageLine({ message: { id: 7 } }), MAIN_FILE, stats), null);
  assert.equal(stats.skipped, 3, 'a usage line without a message id is skipped and counted');

  const noTs = usageLine();
  delete noTs.timestamp;
  assert.equal(parseUsageLine(noTs, MAIN_FILE, stats), null);
  assert.equal(parseUsageLine(usageLine({ top: { timestamp: 'not a time' } }), MAIN_FILE, stats), null);
  // Date.parse(12345) would coerce to a string and return a real date.
  assert.equal(parseUsageLine(usageLine({ top: { timestamp: 12345 } }), MAIN_FILE, stats), null);
  assert.equal(stats.skipped, 6, 'an unparseable timestamp is skipped and counted');

  const noModel = usageLine();
  delete noModel.message.model;
  assert.equal(parseUsageLine(noModel, MAIN_FILE).model, 'unknown');
  assert.equal(parseUsageLine(usageLine({ message: { model: 42 } }), MAIN_FILE).model, 'unknown');

  const c = parseUsageLine(usageLine({}, {
    input_tokens: -5, output_tokens: 12.5, cache_creation_input_tokens: '30', cache_read_input_tokens: 1e20,
    output_tokens_details: { thinking_tokens: -1 },
  }), MAIN_FILE, stats);
  assert.equal(c, null, 'every counter clamped to 0 leaves nothing to store');
  assert.equal(stats.skipped, 7, 'zero only because of the clamp is counted, unlike a genuine zero line');

  const part = parseUsageLine(usageLine({}, { input_tokens: -5, output_tokens: 12.5, cache_read_input_tokens: 900,
    output_tokens_details: { thinking_tokens: 'many' } }), MAIN_FILE, stats);
  assert.deepStrictEqual([part.input, part.output, part.cache_write, part.cache_read, part.thinking], [0, 0, 30, 900, null]);
  assert.equal(stats.skipped, 7);

  // Totals already pass 2^31; the counters must stay plain numbers.
  const big = parseUsageLine(usageLine({}, { cache_read_input_tokens: 31400000000 }), MAIN_FILE);
  assert.equal(big.cache_read, 31400000000);

  // The stats argument is optional.
  assert.equal(parseUsageLine(noId, MAIN_FILE), null);
});

test('parseUsageLine: the 5m/1h split always adds up to cache_write', () => {
  const split = (usage) => {
    const c = parseUsageLine(usageLine({}, usage), MAIN_FILE);
    return [c.cache_write, c.cache_write_5m, c.cache_write_1h];
  };
  // The two fallback responses: counter 0, the abandoned attempt's split beside it.
  assert.deepStrictEqual(split({ cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1968, ephemeral_1h_input_tokens: 0 } }), [0, 0, 0]);
  assert.deepStrictEqual(split({ cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 } }), [500, 500, 0]);
  assert.deepStrictEqual(split({ cache_creation_input_tokens: 500 }), [500, 500, 0]);
  assert.deepStrictEqual(split({ cache_creation_input_tokens: 500, cache_creation: 'x' }), [500, 500, 0]);
  assert.deepStrictEqual(split({ cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 } }), [500, 0, 500]);
  assert.deepStrictEqual(split({ cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 } }), [500, 200, 300]);
});

test('parseUsageLine: owner fields by kind', () => {
  const lineSid = 'ffffffff-0000-4000-8000-00000000000f';
  // Main: copied lines are re-stamped, so only the path says whose the line is.
  assert.equal(parseUsageLine(usageLine(), MAIN_FILE).session_id, S_O);

  const sub = { kind: 'subagent', slug: SLUG, sessionId: S_C, agentId: 'agent-a1', wfId: null, birthMs: 2000 };
  const s = parseUsageLine(usageLine(), sub);
  assert.deepStrictEqual([s.session_id, s.kind, s.agent_id, s.wf_id, s.owner_birth_ms], [lineSid, 'subagent', 'agent-a1', null, 2000]);

  const wf = { kind: 'workflow', slug: SLUG, sessionId: S_C, agentId: 'agent-a1', wfId: 'wf_9', birthMs: 2000 };
  const w = parseUsageLine(usageLine(), wf);
  assert.deepStrictEqual([w.session_id, w.kind, w.agent_id, w.wf_id], [lineSid, 'workflow', 'agent-a1', 'wf_9']);

  // An agent line that has lost its sessionId falls back to the directory uuid.
  const lost = usageLine();
  delete lost.sessionId;
  assert.equal(parseUsageLine(lost, sub).session_id, S_C);
  assert.equal(parseUsageLine(usageLine({ top: { sessionId: 99 } }), wf).session_id, S_C);
});

// --- parseCompaction ---

test('parseCompaction: a boundary in a main file, and what is skipped', () => {
  const stats = { skipped: 0 };
  const b = {
    type: 'system', subtype: 'compact_boundary', uuid: 'cb-1', timestamp: '2026-10-03T12:00:00.000Z',
    sessionId: 'ffffffff-0000-4000-8000-00000000000f',
    compactMetadata: { trigger: 'manual', preTokens: 167000, postTokens: 8200 },
  };
  assert.deepStrictEqual(parseCompaction(b, MAIN_FILE, stats), {
    uuid: 'cb-1', session_id: S_O, slug: SLUG, ts_ms: Date.parse('2026-10-03T12:00:00.000Z'),
    trigger: 'manual', pre_tokens: 167000, post_tokens: 8200,
  });
  const bare = parseCompaction({ ...b, compactMetadata: undefined }, MAIN_FILE, stats);
  assert.deepStrictEqual([bare.trigger, bare.pre_tokens, bare.post_tokens], [null, null, null]);
  assert.equal(stats.skipped, 0);

  assert.equal(parseCompaction({ ...b, uuid: undefined }, MAIN_FILE, stats), null);
  assert.equal(parseCompaction({ ...b, timestamp: 'never' }, MAIN_FILE, stats), null);
  assert.equal(stats.skipped, 2, 'no uuid or no time: skipped and counted');

  // Main files only, and only this subtype; neither counts as a skip.
  assert.equal(parseCompaction(b, { ...MAIN_FILE, kind: 'subagent' }, stats), null);
  assert.equal(parseCompaction({ ...b, subtype: 'turn_duration' }, MAIN_FILE, stats), null);
  assert.equal(parseCompaction(usageLine(), MAIN_FILE, stats), null);
  assert.equal(stats.skipped, 2);
});

// --- decideUpsert ---

test('decideUpsert: the counter rule', () => {
  const ins = decideUpsert(undefined, cand());
  assert.deepStrictEqual([ins.action, ins.counters, ins.owner], ['insert', true, true]);
  assert.deepStrictEqual(ins.row, cand());
  assert.equal(decideUpsert(null, cand()).action, 'insert');

  // Unfinalised then finalised: replace, even though the finalised output is smaller.
  let d = decideUpsert(cand({ output: 50 }), cand({ output: 9, finalized: 1, stop_reason: 'end_turn', model: 'n', ts_ms: 4000 }));
  assert.deepStrictEqual([d.action, d.counters, d.owner], ['update', true, false]);
  assert.deepStrictEqual([d.row.output, d.row.finalized, d.row.stop_reason, d.row.model, d.row.ts_ms], [9, 1, 'end_turn', 'n', 4000]);

  // Finalised then unfinalised: keep, whatever the output.
  const fin = cand({ output: 9, finalized: 1, stop_reason: 'end_turn' });
  d = decideUpsert(fin, cand({ output: 5000 }));
  assert.deepStrictEqual([d.action, d.counters, d.owner], ['keep', false, false]);
  assert.strictEqual(d.row, fin);

  // Both finalised, larger output: replace. Smaller: keep.
  assert.equal(decideUpsert(fin, cand({ output: 10, finalized: 1, stop_reason: 'tool_use' })).row.stop_reason, 'tool_use');
  assert.equal(decideUpsert(fin, cand({ output: 8, finalized: 1 })).action, 'keep');
  // Both unfinalised, smaller output: keep. Larger: replace.
  assert.equal(decideUpsert(cand({ output: 8 }), cand({ output: 5 })).action, 'keep');
  assert.equal(decideUpsert(cand({ output: 5 }), cand({ output: 8 })).row.output, 8);

  // Equal output: the later timestamp wins, so the stored time does not depend on order.
  const early = cand({ ts_ms: 5000, input: 1 });
  const late = cand({ ts_ms: 6000, input: 2 });
  assert.equal(decideUpsert(early, late).row.ts_ms, 6000);
  assert.equal(decideUpsert(late, early).row.ts_ms, 6000);
  assert.equal(decideUpsert(early, { ...early }).action, 'keep', 'an identical sighting changes nothing');

  // 0/1 from SQLite and booleans mean the same thing.
  assert.equal(decideUpsert(cand({ finalized: false }), cand({ finalized: true, output: 1 })).counters, true);
});

test('decideUpsert: counters are taken from one line as a unit', () => {
  const stored = cand({ input: 900, cache_read: 900, cache_write: 900, cache_write_5m: 900, output: 4, thinking: 3 });
  const better = cand({ input: 1, cache_read: 2, cache_write: 0, cache_write_5m: 0, output: 400, thinking: null,
    finalized: 1, stop_reason: 'end_turn' });
  const row = decideUpsert(stored, better).row;
  for (const f of COUNTER_FIELDS) assert.strictEqual(row[f], better[f], f);
});

test('decideUpsert: owner fields are never part of a counter replacement', () => {
  const stored = cand({ session_id: S_O, kind: 'subagent', agent_id: 'agent-o', wf_id: null, owner_birth_ms: 9000 });
  const c = cand({ session_id: S_C, kind: 'workflow', slug: 'other', agent_id: 'agent-c', wf_id: 'wf', owner_birth_ms: 1,
    output: 999, finalized: 1, stop_reason: 'end_turn' });
  const d = decideUpsert(stored, c);
  assert.deepStrictEqual([d.action, d.counters, d.owner], ['update', true, false]);
  for (const f of OWNER_FIELDS) assert.strictEqual(d.row[f], stored[f], f);
  assert.equal(d.row.output, 999);
  assert.deepStrictEqual(stored.output, 10, 'the stored row is not mutated');
});

test('decideUpsert: ownership takeover is independent of the counter rule', () => {
  const later = cand({ session_id: S_C, owner_birth_ms: 3000, output: 300, finalized: 1, stop_reason: 'end_turn' });
  const earlierPlaceholder = cand({ session_id: S_O, owner_birth_ms: 1000, output: 4 });

  // Owner moves, counters kept.
  let d = decideUpsert(later, earlierPlaceholder);
  assert.deepStrictEqual([d.action, d.counters, d.owner], ['update', false, true]);
  assert.deepStrictEqual([d.row.session_id, d.row.owner_birth_ms, d.row.output, d.row.finalized], [S_O, 1000, 300, 1]);

  // Counters move, owner kept.
  d = decideUpsert(earlierPlaceholder, later);
  assert.deepStrictEqual([d.action, d.counters, d.owner], ['update', true, false]);
  assert.deepStrictEqual([d.row.session_id, d.row.owner_birth_ms, d.row.output, d.row.finalized], [S_O, 1000, 300, 1]);

  // Both at once.
  d = decideUpsert(cand({ session_id: S_C, owner_birth_ms: 3000, output: 4 }),
    cand({ session_id: S_O, owner_birth_ms: 1000, output: 300, finalized: 1, stop_reason: 'end_turn' }));
  assert.deepStrictEqual([d.counters, d.owner, d.row.session_id, d.row.output], [true, true, S_O, 300]);

  // Later-born or same-born main file: no takeover.
  assert.equal(decideUpsert(earlierPlaceholder, cand({ session_id: S_C, owner_birth_ms: 3000, output: 4 })).action, 'keep');
  assert.equal(decideUpsert(earlierPlaceholder, cand({ session_id: S_C, owner_birth_ms: 1000, output: 4 })).action, 'keep');

  // Main lines only, on both sides.
  const agentRow = cand({ kind: 'subagent', agent_id: 'agent-a', owner_birth_ms: 3000 });
  assert.equal(decideUpsert(agentRow, cand({ kind: 'subagent', agent_id: 'agent-b', owner_birth_ms: 1 })).owner, false);
  assert.equal(decideUpsert(agentRow, cand({ kind: 'main', owner_birth_ms: 1 })).owner, false);
  assert.equal(decideUpsert(cand({ owner_birth_ms: 3000 }), cand({ kind: 'workflow', owner_birth_ms: 1 })).owner, false);
});

test('decideUpsert: local_day rides with the counters and file_id with the owner', () => {
  const stored = { ...cand({ owner_birth_ms: 3000, output: 4 }), file_id: 7, local_day: '2026-10-01' };
  const counters = decideUpsert(stored, { ...cand({ owner_birth_ms: 3000, output: 9 }), file_id: 8, local_day: '2026-10-02' }).row;
  assert.deepStrictEqual([counters.file_id, counters.local_day], [7, '2026-10-02']);
  const owner = decideUpsert(stored, { ...cand({ owner_birth_ms: 1000, output: 4 }), file_id: 8, local_day: '2026-10-02' }).row;
  assert.deepStrictEqual([owner.file_id, owner.local_day], [8, '2026-10-01']);
});

test('reduceFile: at most one candidate per message id, first-seen order', () => {
  const input = [
    cand({ message_id: 'b', output: 3 }),
    cand({ message_id: 'a', output: 8 }),
    cand({ message_id: 'b', output: 5 }),
    cand({ message_id: 'b', output: 405, finalized: 1, stop_reason: 'end_turn' }),
    cand({ message_id: 'a', output: 396, finalized: 1, stop_reason: 'tool_use' }),
    cand({ message_id: 'b', output: 9000 }),   // a late placeholder never beats the finalised line
  ];
  const out = reduceFile(input);
  assert.deepStrictEqual(out.map(c => [c.message_id, c.output, c.finalized]), [['b', 405, 1], ['a', 396, 1]]);
  assert.equal(input[0].output, 3, 'input is not mutated');
  assert.deepStrictEqual(reduceFile([]), []);
});

// --- scanTranscript: fixture A ---

test('fixture A: 3+5+405 and 8+396 become two rows, 801 not 817', () => {
  const dir = projectsDir();
  const p = place(dir, mainRel(S_O), fixture('transcript-a.jsonl'));

  // What a per-line sum would report: the over-count, in miniature.
  let naive = 0;
  for (const l of fixture('transcript-a.jsonl').toString('utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l);
    if (o.type === 'assistant') naive += o.message.usage.output_tokens;
  }
  assert.equal(naive, 3 + 5 + 405 + 8 + 396);
  assert.equal(naive, 817);

  const r = scanTranscript(p, null, dir);
  assert.equal(r.discarded, false);
  assert.equal(r.fullRescan, false, 'a first scan has nothing to delete');
  assert.equal(r.lines_skipped, 0);
  assert.equal(r.candidates.length, 2);
  assert.deepStrictEqual(r.candidates.map(c => [c.message_id, c.output, c.finalized, c.stop_reason]),
    [['msg_fixA1', 405, 1, 'end_turn'], ['msg_fixA2', 396, 1, 'tool_use']]);
  const deduped = r.candidates.reduce((n, c) => n + c.output, 0);
  assert.equal(deduped, 801);
  assert.notEqual(deduped, naive);

  const [a1, a2] = r.candidates;
  // Counters and time come from the finalised line as a unit.
  assert.deepStrictEqual(
    [a1.input, a1.cache_write, a1.cache_write_5m, a1.cache_write_1h, a1.cache_read, a1.thinking, a1.ts_ms],
    [3, 1200, 0, 1200, 50000, 120, Date.parse('2026-10-01T17:00:03.000Z')]);
  assert.deepStrictEqual([a2.input, a2.cache_write, a2.cache_write_5m, a2.cache_write_1h, a2.cache_read, a2.thinking],
    [6, 300, 300, 0, 51200, null]);
  for (const c of r.candidates) {
    assert.deepStrictEqual([c.session_id, c.kind, c.slug, c.wf_id, c.agent_id], [S_O, 'main', SLUG, null, null]);
    assert.equal(c.owner_birth_ms, r.fileRow.birthtime_ms);
    assert.equal(c.cache_write_5m + c.cache_write_1h, c.cache_write);
    assert.ok(!('local_day' in c));
  }

  assert.deepStrictEqual(r.compactions, [{
    uuid: 'cb-fix-0001', session_id: S_O, slug: SLUG, ts_ms: Date.parse('2026-10-01T17:00:08.000Z'),
    trigger: 'auto', pre_tokens: 167000, post_tokens: 8200,
  }]);
});

test('scanTranscript: the file row', () => {
  const dir = projectsDir();
  const body = fixture('transcript-a.jsonl');
  const p = place(dir, mainRel(S_O), body);
  const st = fs.statSync(p);
  const r = scanTranscript(p, null, dir);

  assert.deepStrictEqual(Object.keys(r).sort(),
    ['candidates', 'compactions', 'discarded', 'fileRow', 'fullRescan', 'lines_skipped']);
  assert.deepStrictEqual(Object.keys(r.fileRow), ['rel_path', 'kind', 'slug', 'session_id', 'agent_id', 'wf_id',
    'size', 'mtime_ms', 'birthtime_ms', 'head_hash', 'indexed_bytes', 'tail_hash']);
  assert.equal(r.fileRow.rel_path, mainRel(S_O), 'relative to the projects dir, forward slashes');
  assert.deepStrictEqual([r.fileRow.kind, r.fileRow.slug, r.fileRow.session_id, r.fileRow.agent_id, r.fileRow.wf_id],
    ['main', SLUG, S_O, null, null]);
  assert.equal(r.fileRow.size, body.length);
  assert.equal(r.fileRow.indexed_bytes, body.length);
  assert.equal(r.fileRow.mtime_ms, Math.floor(st.mtimeMs));
  assert.equal(r.fileRow.birthtime_ms, Math.floor(st.birthtimeMs));
  assert.ok(Number.isInteger(r.fileRow.mtime_ms) && Number.isInteger(r.fileRow.birthtime_ms));

  // The head hash of harnesses/claude.js: 'v1:' + sha1(dev:ino: + first 4096 bytes).
  const head = 'v1:' + crypto.createHash('sha1').update(`${st.dev}:${st.ino}:`).update(body.subarray(0, 4096)).digest('hex');
  assert.equal(r.fileRow.head_hash, head);
  assert.equal(r.fileRow.tail_hash,
    crypto.createHash('sha1').update(body.subarray(body.length - 256)).digest('hex'));
});

test('scanTranscript: agent files take kind from the path; errors carry a code', () => {
  const dir = projectsDir();
  const sub = place(dir, `${SLUG}/${S_C}/subagents/agent-a1b2c3.jsonl`, fixture('agent-copy.jsonl'));
  const wf = place(dir, `${SLUG}/${S_C}/subagents/workflows/wf_fix1/agent-a1b2c3.jsonl`, fixture('agent-copy.jsonl'));
  const s = scanTranscript(sub, null, dir);
  assert.deepStrictEqual([s.fileRow.kind, s.fileRow.session_id, s.fileRow.agent_id, s.fileRow.wf_id],
    ['subagent', S_C, 'agent-a1b2c3', null]);
  const w = scanTranscript(wf, null, dir);
  assert.deepStrictEqual([w.fileRow.kind, w.fileRow.session_id, w.fileRow.agent_id, w.fileRow.wf_id],
    ['workflow', S_C, 'agent-a1b2c3', 'wf_fix1']);
  assert.deepStrictEqual(w.candidates.map(c => [c.kind, c.wf_id, c.agent_id, c.session_id]),
    [['workflow', 'wf_fix1', 'agent-a1b2c3', S_O], ['workflow', 'wf_fix1', 'agent-a1b2c3', S_O]]);

  // A boundary is a compaction only in a main file.
  const b = place(dir, `${SLUG}/${S_C}/subagents/agent-bbbb.jsonl`, fixture('transcript-a.jsonl'));
  assert.deepStrictEqual(scanTranscript(b, null, dir).compactions, []);

  assert.throws(() => scanTranscript(path.join(dir, SLUG, `${S_F}.jsonl`), null, dir), e => e.code === 'ENOENT');
  const stray = place(dir, `${SLUG}/journal.jsonl`, fixture('transcript-a.jsonl'));
  assert.throws(() => scanTranscript(stray, null, dir), e => e.code === 'EINVAL');
});

test('scanTranscript: an empty file and a file with no complete line', () => {
  const dir = projectsDir();
  const empty = scanTranscript(place(dir, mainRel(S_O), ''), null, dir);
  assert.deepStrictEqual([empty.discarded, empty.fileRow.size, empty.fileRow.indexed_bytes, empty.fileRow.head_hash,
    empty.candidates.length], [false, 0, 0, '', 0]);

  const firstLine = fixture('own-original.jsonl').subarray(0, 200);
  assert.ok(!firstLine.includes(0x0A));
  const partial = scanTranscript(place(dir, mainRel(S_C), firstLine), null, dir);
  assert.deepStrictEqual([partial.fileRow.size, partial.fileRow.indexed_bytes, partial.candidates.length, partial.lines_skipped],
    [200, 0, 0, 0]);
});

// --- Cross-file ---

test('cross-file: a continuation copies the history; each id is counted once, for the first file', () => {
  const dir = projectsDir();
  const o = place(dir, mainRel(S_O), fixture('transcript-a.jsonl'));
  const c = place(dir, mainRel(S_C), fixture('continuation.jsonl'));
  const io = fakeFs({ births: { [o]: 1000000, [c]: 1020000 } });
  const so = scanTranscript(o, null, dir, { fs: io });
  const sc = scanTranscript(c, null, dir, { fs: io });

  // The copy re-stamps sessionId on every line, so the path is the only truth.
  assert.ok(fixture('continuation.jsonl').toString('utf8').includes(`"sessionId":"${S_C}"`));
  assert.ok(!fixture('continuation.jsonl').toString('utf8').includes(S_O));
  assert.ok(sc.candidates.every(x => x.session_id === S_C));

  // The zeroed copy sits after the boundary and repeats msg_fixA2 with all four
  // counters 0 and the real numbers only in usage.iterations.
  const lines = fixture('continuation.jsonl').toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const zeroed = lines.filter(l => l.type === 'assistant' && l.message.id === 'msg_fixA2' && l.message.usage.iterations);
  assert.equal(zeroed.length, 1);
  assert.equal(zeroed[0].message.usage.iterations[0].output_tokens, 396);
  assert.equal(parseUsageLine(zeroed[0], { ...MAIN_FILE, sessionId: S_C }), null);
  assert.deepStrictEqual(sc.candidates.map(x => [x.message_id, x.output]),
    [['msg_fixA1', 405], ['msg_fixA2', 396], ['msg_fixC1', 250]], 'the zeroed copy changes nothing');
  assert.equal(sc.lines_skipped, 0);

  // Birthtime order, the order the backfill uses.
  const rows = applyScans([so, sc]);
  assert.equal(rows.size, 3, 'one row per id');
  assert.deepStrictEqual(sorted(rows).map(r => [r.message_id, r.session_id, r.owner_birth_ms, r.output]), [
    ['msg_fixA1', S_O, 1000000, 405],
    ['msg_fixA2', S_O, 1000000, 396],
    ['msg_fixC1', S_C, 1020000, 250],
  ]);
  assert.deepStrictEqual(sumBy(rows, 'session_id', 'output'), { [S_O]: 801, [S_C]: 250 });
  // And the other order gives the same rows.
  assert.deepStrictEqual(sorted(applyScans([sc, so])), sorted(rows));

  // The copied boundary keeps its uuid, which is what the store dedupes on.
  assert.deepStrictEqual(sc.compactions.map(k => k.uuid), so.compactions.map(k => k.uuid));
});

test('subagent copy: the same agent file under two session folders belongs to the line\'s session', () => {
  const dir = projectsDir();
  const first = place(dir, `${SLUG}/${S_O}/subagents/agent-a1b2c3.jsonl`, fixture('agent-copy.jsonl'));
  const copy = place(dir, `${SLUG}/${S_C}/subagents/agent-a1b2c3.jsonl`, fixture('agent-copy.jsonl'));
  const io = fakeFs({ births: { [first]: 1000000, [copy]: 1020000 } });
  const s1 = scanTranscript(first, null, dir, { fs: io });
  const s2 = scanTranscript(copy, null, dir, { fs: io });
  assert.equal(s2.fileRow.session_id, S_C, 'the file row keeps the directory uuid');

  for (const order of [[s1, s2], [s2, s1]]) {
    const rows = applyScans(order);
    assert.equal(rows.size, 2);
    assert.deepStrictEqual(sorted(rows).map(r => [r.message_id, r.session_id, r.kind, r.agent_id, r.output, r.finalized]), [
      ['msg_fixG1', S_O, 'subagent', 'agent-a1b2c3', 120, 1],
      ['msg_fixG2', S_O, 'subagent', 'agent-a1b2c3', 7, 0],   // no finalised line: kept as a lower bound
    ]);
    assert.deepStrictEqual(sumBy(rows, 'session_id', 'output'), { [S_O]: 127 });
  }
});

// --- Ownership ---

test('ownership: original, fork and continuation in all six scan orders', () => {
  const dir = projectsDir();
  const T0 = 1790000000000;
  const files = {
    O: place(dir, mainRel(S_O), fixture('own-original.jsonl')),
    A: place(dir, mainRel(S_F), fixture('own-fork.jsonl')),
    C: place(dir, mainRel(S_C), fixture('own-continuation.jsonl')),
  };
  // Fractional on purpose: birthtimeMs is fractional on real files and the
  // stored value must be the floor.
  const io = fakeFs({ births: { [files.O]: T0 + 0.75, [files.A]: T0 + 10000 + 0.25, [files.C]: T0 + 20000 + 0.5 } });
  const scans = {};
  for (const k of Object.keys(files)) scans[k] = scanTranscript(files[k], null, dir, { fs: io });
  assert.deepStrictEqual([scans.O.fileRow.birthtime_ms, scans.A.fileRow.birthtime_ms, scans.C.fileRow.birthtime_ms],
    [T0, T0 + 10000, T0 + 20000]);

  const expected = [
    ['msg_ownA1', S_F, T0 + 10000, 70, 1],
    ['msg_ownC1', S_C, T0 + 20000, 90, 1],
    ['msg_ownO4', S_O, T0, 50, 1],
    ['msg_ownS1', S_O, T0, 100, 1],
    ['msg_ownS2', S_O, T0, 200, 1],
    // The original holds only the placeholder; the finalised line lives in the
    // continuation. Owner from O, counters from C, in every order.
    ['msg_ownS3', S_O, T0, 300, 1],
  ];
  const orders = [['O', 'A', 'C'], ['O', 'C', 'A'], ['A', 'O', 'C'], ['A', 'C', 'O'], ['C', 'O', 'A'], ['C', 'A', 'O']];
  let reference = null;
  for (const order of orders) {
    const rows = applyScans(order.map(k => scans[k]));
    const name = order.join('');
    assert.deepStrictEqual(sorted(rows).map(r => [r.message_id, r.session_id, r.owner_birth_ms, r.output, r.finalized]),
      expected, name);
    for (const f of ['input', 'output', 'cache_write', 'cache_read']) {
      const want = { output: { [S_O]: 650, [S_F]: 70, [S_C]: 90 } }[f];
      if (want) assert.deepStrictEqual(sumBy(rows, 'session_id', f), want, `${name} ${f}`);
    }
    // Every field of every row, not only the ones listed above.
    if (!reference) reference = sorted(rows);
    else assert.deepStrictEqual(sorted(rows), reference, name);
  }

  // "First insert wins" would have failed this: scanned first, C inserts the shared ids.
  assert.ok(scans.C.candidates.some(c => c.message_id === 'msg_ownS1' && c.session_id === S_C));
});

// --- Resume ---

test('resume: a cut line is re-read, nothing is counted twice, the offset never passes a partial line', () => {
  const dir = projectsDir();
  const body = fixture('resume.jsonl');
  const ends = lineEnds(body);
  assert.equal(ends.length, 7);
  assert.ok(ends[0] > 4096, 'the first line alone must exceed the head window');
  // Two and a half lines: the third (the finalised line of R1) is cut in the middle.
  const cut = ends[1] + Math.floor((ends[2] - ends[1]) / 2);
  const p = place(dir, mainRel(S_O), body.subarray(0, cut));

  const first = scanTranscript(p, null, dir);
  assert.equal(first.fullRescan, false);
  assert.equal(first.fileRow.size, cut);
  assert.equal(first.fileRow.indexed_bytes, ends[1], 'stops at the last newline, not at the end of the file');
  assert.deepStrictEqual(first.candidates.map(c => [c.message_id, c.output, c.finalized]), [['msg_resR1', 3, 0]]);
  assert.equal(first.lines_skipped, 0, 'a partial last line is not a skipped line');
  assert.equal(first.fileRow.tail_hash,
    crypto.createHash('sha1').update(body.subarray(ends[1] - 256, ends[1])).digest('hex'));

  fs.appendFileSync(p, body.subarray(cut));
  const io = fakeFs();
  const second = scanTranscript(p, first.fileRow, dir, { fs: io });
  assert.equal(second.discarded, false);
  assert.equal(second.fullRescan, false, 'the stored offset is resumed');
  assert.equal(second.fileRow.indexed_bytes, body.length);
  assert.equal(io.bytesRead, 4096 + 256 + (body.length - ends[1]) + 256,
    'head, tail check, only the new bytes, then the new tail');
  // Only lines from the offset on: the cut line whole, then the rest.
  assert.deepStrictEqual(second.candidates.map(c => [c.message_id, c.output, c.finalized]),
    [['msg_resR1', 210, 1], ['msg_resR2', 95, 1], ['msg_resR3', 60, 1]]);
  assert.deepStrictEqual(second.compactions.map(k => [k.uuid, k.trigger, k.pre_tokens, k.post_tokens]),
    [['cb-fix-0002', 'manual', 9000, 1200]]);

  const full = scanTranscript(p, null, dir);
  assert.deepStrictEqual(sorted(applyScans([first, second])), sorted(applyScans([full])),
    'two passes give the rows of one full scan');
  assert.deepStrictEqual(second.fileRow, full.fileRow);
  // Applying the same pass again changes nothing.
  assert.deepStrictEqual(sorted(applyScans([first, second, second, first])), sorted(applyScans([full])));
});

test('resume: an unchanged file costs the head and one tail read', () => {
  const dir = projectsDir();
  const p = place(dir, mainRel(S_O), fixture('resume.jsonl'));
  const full = scanTranscript(p, null, dir);

  const io = fakeFs();
  const again = scanTranscript(p, full.fileRow, dir, { fs: io });
  assert.equal(io.bytesRead, 4096 + 256);
  assert.deepStrictEqual([again.discarded, again.fullRescan, again.candidates.length, again.compactions.length, again.lines_skipped],
    [false, false, 0, 0, 0]);
  assert.deepStrictEqual(again.fileRow, full.fileRow);
});

test('resume: mtime and birthtime are floored on both sides of every comparison', () => {
  const dir = projectsDir();
  const p = place(dir, mainRel(S_O), fixture('resume.jsonl'));
  // What NTFS reports here: a fractional mtimeMs. Stored, it is an integer.
  const frac = { mtimeMs: 1791042385203.294, birthtimeMs: 1791042000000.75 };
  const io = fakeFs({ patch: () => frac });
  const full = scanTranscript(p, null, dir, { fs: io });
  assert.equal(full.discarded, false, 'the second fstat of the same pass must compare equal');
  assert.deepStrictEqual([full.fileRow.mtime_ms, full.fileRow.birthtime_ms], [1791042385203, 1791042000000]);
  assert.ok(full.candidates.every(c => c.owner_birth_ms === 1791042000000));

  // Fully indexed and untouched: the stored integer must match the raw float.
  io.bytesRead = 0;
  const again = scanTranscript(p, full.fileRow, dir, { fs: io });
  assert.equal(again.fullRescan, false);
  assert.equal(io.bytesRead, 4096 + 256);

  // A stored row that was never floored (a float) is floored before comparing too.
  assert.equal(scanTranscript(p, { ...full.fileRow, mtime_ms: 1791042385203.9 }, dir, { fs: io }).fullRescan, false);

  // A real mtime change with no growth fails the gate.
  const touched = fakeFs({ patch: () => ({ ...frac, mtimeMs: 1791042385204.1 }) });
  const re = scanTranscript(p, full.fileRow, dir, { fs: touched });
  assert.equal(re.fullRescan, true);
  assert.equal(re.candidates.length, 3);
});

test('resume: a file under the head window is always read in full', () => {
  const dir = projectsDir();
  const body = fixture('own-original.jsonl');
  assert.ok(body.length < 4096);
  const ends = lineEnds(body);
  const p = place(dir, mainRel(S_O), body.subarray(0, ends[2]));
  const first = scanTranscript(p, null, dir);
  fs.appendFileSync(p, body.subarray(ends[2]));
  const second = scanTranscript(p, first.fileRow, dir);
  assert.equal(second.fullRescan, true, 'the head hash covers the whole file, so an append changes it');
  assert.deepStrictEqual(second.candidates.map(c => c.message_id), ['msg_ownS1', 'msg_ownS2', 'msg_ownS3', 'msg_ownO4']);
});

// --- Shrink / rewrite ---

test('shrink: a file shorter than the stored offset is rescanned from the start', () => {
  const dir = projectsDir();
  const body = fixture('resume.jsonl');
  const ends = lineEnds(body);
  const p = place(dir, mainRel(S_O), body);
  const full = scanTranscript(p, null, dir);

  fs.truncateSync(p, ends[3]);   // still past 4 KB, so the head hash is unchanged
  const re = scanTranscript(p, full.fileRow, dir);
  assert.equal(re.fileRow.head_hash, full.fileRow.head_hash);
  assert.equal(re.fullRescan, true);
  assert.equal(re.fileRow.indexed_bytes, ends[3]);
  assert.deepStrictEqual(re.candidates.map(c => [c.message_id, c.output, c.finalized]),
    [['msg_resR1', 210, 1], ['msg_resR2', 5, 0]]);
});

test('rewrite: bytes just before the offset changed with size, head and mtime the same', () => {
  const dir = projectsDir();
  const body = fixture('resume.jsonl');
  const p = place(dir, mainRel(S_O), body);
  // Pin the mtime so the tail hash is the only guard left to notice.
  const pinned = { mtimeMs: 1791042385203.294 };
  const io = fakeFs({ patch: () => pinned });
  const full = scanTranscript(p, null, dir, { fs: io });

  // Control: nothing rewritten, same pinned mtime: resumes.
  assert.equal(scanTranscript(p, full.fileRow, dir, { fs: io }).fullRescan, false);

  // Change one output count inside the last line, same length ("60" -> "61").
  const edited = Buffer.from(body);
  const at = edited.lastIndexOf('"output_tokens":60');
  assert.ok(at > body.length - 256, 'the edit must fall inside the tail window');
  edited.write('"output_tokens":61', at);
  assert.equal(edited.length, body.length);
  fs.writeFileSync(p, edited);

  const re = scanTranscript(p, full.fileRow, dir, { fs: io });
  assert.equal(re.fileRow.size, full.fileRow.size);
  assert.equal(re.fileRow.head_hash, full.fileRow.head_hash);
  assert.equal(re.fileRow.mtime_ms, full.fileRow.mtime_ms);
  assert.equal(re.fullRescan, true, 'tail hash mismatch');
  assert.notEqual(re.fileRow.tail_hash, full.fileRow.tail_hash);
  assert.equal(re.candidates.find(c => c.message_id === 'msg_resR3').output, 61);
});

test('rewrite: the tail hash also guards a file that grew', () => {
  const dir = projectsDir();
  const body = fixture('resume.jsonl');
  const ends = lineEnds(body);
  const p = place(dir, mainRel(S_O), body.subarray(0, ends[4]));
  const first = scanTranscript(p, null, dir);
  assert.equal(first.fileRow.indexed_bytes, ends[4]);

  const edited = Buffer.from(body);
  const at = edited.lastIndexOf('"output_tokens":95', ends[4]);
  assert.ok(at > ends[4] - 256 && at < ends[4]);
  edited.write('"output_tokens":96', at);
  fs.writeFileSync(p, edited);

  const re = scanTranscript(p, first.fileRow, dir);
  assert.equal(re.fileRow.head_hash, first.fileRow.head_hash);
  assert.equal(re.fullRescan, true);
  assert.equal(re.candidates.find(c => c.message_id === 'msg_resR2').output, 96);
});

test('a previous row that cannot be resumed is a full rescan', () => {
  const dir = projectsDir();
  const p = place(dir, mainRel(S_O), fixture('resume.jsonl'));
  const full = scanTranscript(p, null, dir);
  // What the store writes to force a rescan of a file whose owner was rescanned.
  const forced = { ...full.fileRow, indexed_bytes: 0, head_hash: null, tail_hash: null };
  assert.equal(scanTranscript(p, forced, dir).fullRescan, true);
  assert.equal(scanTranscript(p, { ...full.fileRow, head_hash: 'v1:' + '0'.repeat(40) }, dir).fullRescan, true);
  assert.equal(scanTranscript(p, { ...full.fileRow, tail_hash: null }, dir).fullRescan, true);
  assert.equal(scanTranscript(p, { ...full.fileRow, indexed_bytes: full.fileRow.size + 1 }, dir).fullRescan, true);
  assert.equal(scanTranscript(p, null, dir).fullRescan, false);
});

// --- Changed during scan ---

test('changed during scan: the pass is discarded and cannot move the offset', () => {
  const dir = projectsDir();
  const body = fixture('resume.jsonl');
  const p = place(dir, mainRel(S_O), body);
  const good = scanTranscript(p, null, dir);

  // The second fstat on the descriptor reports a smaller file.
  const shrunk = fakeFs({ patch: (n, st) => (n === 1 ? { size: st.size - 10 } : null) });
  const d = scanTranscript(p, null, dir, { fs: shrunk });
  assert.equal(d.discarded, true);
  assert.equal(d.fullRescan, false);
  assert.deepStrictEqual([d.candidates, d.compactions, d.lines_skipped], [[], [], 0]);
  assert.deepStrictEqual([d.fileRow.rel_path, d.fileRow.head_hash, d.fileRow.indexed_bytes, d.fileRow.tail_hash],
    [mainRel(S_O), null, 0, null]);

  // With a previous row, the previous resume state is what comes back.
  const prev = { ...good.fileRow, indexed_bytes: lineEnds(body)[1], tail_hash: 'x'.repeat(40) };
  const d2 = scanTranscript(p, prev, dir, { fs: shrunk });
  assert.equal(d2.discarded, true);
  assert.deepStrictEqual([d2.fileRow.head_hash, d2.fileRow.indexed_bytes, d2.fileRow.tail_hash],
    [prev.head_hash, prev.indexed_bytes, prev.tail_hash]);

  // Same size, another mtime: bytes inside the range may have changed.
  const touched = fakeFs({ patch: (n, st) => (n === 1 ? { mtimeMs: st.mtimeMs + 5 } : null) });
  assert.equal(scanTranscript(p, null, dir, { fs: touched }).discarded, true);

  // Growth alone is fine: the next pass picks it up.
  const grown = fakeFs({ patch: (n, st) => (n === 1 ? { size: st.size + 500, mtimeMs: st.mtimeMs + 5 } : null) });
  const g = scanTranscript(p, null, dir, { fs: grown });
  assert.equal(g.discarded, false);
  assert.equal(g.fileRow.size, body.length, 'the row records the size that was read');
  assert.deepStrictEqual(g.candidates, good.candidates);

  // The file is shorter than the first fstat said: a read comes back empty.
  const lied = fakeFs({ patch: (n, st) => (n === 0 ? { size: st.size + 4096 } : null) });
  assert.equal(scanTranscript(p, null, dir, { fs: lied }).discarded, true);
});

// --- Prefilter ---

test('prefilter: runs on bytes; a boundary without "usage" is recognised; other lines are never decoded', () => {
  const dir = projectsDir();
  const body = fixture('prefilter.jsonl');
  const text = body.toString('utf8').split('\n').filter(Boolean);
  assert.equal(text.length, 6);

  // The boundary line is the real shape: no "usage" anywhere in it.
  const boundary = text.filter(l => l.includes('"subtype":"compact_boundary"'));
  assert.equal(boundary.length, 1);
  assert.ok(!boundary[0].includes('usage'));
  assert.ok(JSON.parse(boundary[0]).compactMetadata.preservedSegment);

  const p = place(dir, mainRel(S_O), body);
  const decoded = [];
  const r = scanTranscript(p, null, dir, { decode: (buf) => { const s = buf.toString('utf8'); decoded.push(s); return s; } });

  assert.deepStrictEqual(r.compactions.map(k => k.uuid), ['cb-fix-0003']);
  assert.deepStrictEqual(r.candidates.map(c => [c.message_id, c.output]), [['msg_preP1', 33]]);
  // Decoded: the boundary, the assistant line, and an attachment that carries a
  // "usage" key (passes the prefilter, is not a response).
  assert.equal(decoded.length, 3);
  assert.deepStrictEqual(decoded.map(s => JSON.parse(s).type), ['system', 'assistant', 'attachment']);
  // Never decoded: plain user lines, and one whose text says usage without the
  // quotes and \"usage\" with escaped ones.
  const never = text.filter(l => !decoded.includes(l));
  assert.equal(never.length, 3);
  assert.ok(never.some(l => l.includes('token usage looks high') && l.includes('\\"usage\\"')));
  // Lines that fail the prefilter still advance the offset.
  assert.equal(r.fileRow.indexed_bytes, body.length);
  assert.equal(r.lines_skipped, 0);
});

test('prefilter: a line longer than one read chunk is assembled before it is tested', () => {
  const dir = projectsDir();
  const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'z'.repeat(700 * 1024) } }) + '\n';
  const lines = fixture('transcript-a.jsonl').toString('utf8').split('\n').filter(Boolean);
  // A response line that itself spans several 256 KB chunks.
  const bigObj = JSON.parse(lines[3]);
  bigObj.message.content = [{ type: 'text', text: 'y'.repeat(600 * 1024) }];
  const body = Buffer.from(filler + lines[1] + '\n' + filler + JSON.stringify(bigObj) + '\n' + filler);
  const p = place(dir, mainRel(S_O), body);

  let decodes = 0;
  const r = scanTranscript(p, null, dir, { decode: (buf) => { decodes++; return buf.toString('utf8'); } });
  assert.equal(decodes, 2);
  assert.deepStrictEqual(r.candidates.map(c => [c.message_id, c.output, c.finalized]), [['msg_fixA1', 405, 1]]);
  assert.equal(r.fileRow.indexed_bytes, body.length);
});

// --- Hardening / normalisation through a file ---

test('hardening: odd lines are skipped and counted, the rest of the file is still stored', () => {
  const dir = projectsDir();
  const p = place(dir, mainRel(S_O), fixture('hardening.jsonl'));
  const r = scanTranscript(p, null, dir);
  assert.equal(r.discarded, false);

  const by = Object.fromEntries(r.candidates.map(c => [c.message_id, c]));
  assert.deepStrictEqual(Object.keys(by),
    ['msg_hardH1', 'msg_hardH3', 'msg_hardH4', 'msg_hardH5', 'msg_hardH6', 'msg_hardH7', 'msg_hardH8']);
  // No timestamp, no message id, broken JSON, boundary without uuid, boundary
  // with an unparseable time, and a line whose every counter was unusable.
  assert.equal(r.lines_skipped, 6);
  assert.deepStrictEqual(r.compactions, []);

  assert.equal(by.msg_hardH3.model, 'unknown');
  assert.deepStrictEqual([by.msg_hardH4.input, by.msg_hardH4.output, by.msg_hardH4.cache_read], [0, 0, 900]);
  assert.deepStrictEqual([by.msg_hardH8.input, by.msg_hardH8.output], [5, 0], 'a string counter is not a number');
  // Normalisation: counter 0 beside a split of 1968 stores no split at all.
  assert.deepStrictEqual([by.msg_hardH5.cache_write, by.msg_hardH5.cache_write_5m, by.msg_hardH5.cache_write_1h], [0, 0, 0]);
  assert.deepStrictEqual([by.msg_hardH6.cache_write, by.msg_hardH6.cache_write_5m, by.msg_hardH6.cache_write_1h], [500, 500, 0]);
  // Lines after the bad ones are stored.
  assert.equal(by.msg_hardH7.output, 105);

  // Nothing here could fail a NOT NULL or integer column.
  for (const c of r.candidates) {
    assert.ok(typeof c.model === 'string' && c.model, c.message_id);
    for (const f of ['ts_ms', 'input', 'output', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'owner_birth_ms']) {
      assert.ok(Number.isSafeInteger(c[f]) && c[f] >= 0, `${c.message_id} ${f}`);
    }
    assert.equal(c.cache_write_5m + c.cache_write_1h, c.cache_write, c.message_id);
  }
});
