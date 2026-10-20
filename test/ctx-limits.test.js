'use strict';
// The ctx-handoff hook's per-project limits: ctx-limits.js (read, validate,
// atomic write of <ctx dir>/limits.json), the numbers ctx-handoff.js and the
// token chart take from a state file or from that file, and the 400K / 150K
// they fall back to. Every file lives in a fresh folder under os.tmpdir(): the
// real claude-ctx folder is never named.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ctxLimits = require('../ctx-limits');
const { handoffLimits, autoOnTitle, AUTO_ON_TITLE, autoHandoffModel, chipLevel, meterModel, chipState } = require('../public/ctx-handoff');
const { readHandoffTrigger } = require('../token-usage-queries');
const { encodeProjectPath } = require('../encode-project-path');

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PO = 'C--Users-jhack-Bitbucket-tools-po-project';
const OTHER = 'C--Users-jhack-Bitbucket-other';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-limits-'));
  return { dir, file: path.join(dir, 'limits.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ── validation ──────────────────────────────────────────────────────────────

test('ctx-limits: limit 100000..950000 and rearm 25000..500000, integers only, booleans and strings refused', () => {
  for (const v of [100000, 400000, 950000]) assert.equal(ctxLimits.validLimit(v), true, String(v));
  for (const v of [99999, 950001, 400000.5, '400000', true, false, null, undefined, NaN, Infinity, -400000, [400000], {}]) {
    assert.equal(ctxLimits.validLimit(v), false, JSON.stringify(v));
  }
  for (const v of [25000, 150000, 500000]) assert.equal(ctxLimits.validRearm(v), true, String(v));
  for (const v of [24999, 500001, 150000.5, '150000', true, null]) assert.equal(ctxLimits.validRearm(v), false, JSON.stringify(v));
  assert.equal(ctxLimits.validationError(null, null), '');
  assert.equal(ctxLimits.validationError(500000, undefined), '');
  assert.match(ctxLimits.validationError(99000, null), /100K to 950K/);
  assert.match(ctxLimits.validationError(null, 600000), /25K to 500K/);
  assert.match(ctxLimits.validationError(true, null), /100K to 950K/);
});

test('ctx-limits: an invalid value is refused with a message and nothing is written', () => {
  const t = tempDir();
  try {
    fs.writeFileSync(t.file, '{"version":1,"projects":{"x":{"limit":300000}}}');
    for (const [limit, rearm] of [[99999, null], [951000, null], [null, 24000], [null, 501000], [true, null], ['500000', null], [500000.5, null]]) {
      const r = ctxLimits.writeProjectLimits(t.dir, PO, limit, rearm);
      assert.equal(r.ok, false, JSON.stringify([limit, rearm]));
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0);
    }
    assert.equal(ctxLimits.writeProjectLimits(t.dir, '..\\x', 500000, null).ok, false, 'a slug that is not a folder name');
    assert.equal(fs.readFileSync(t.file, 'utf8'), '{"version":1,"projects":{"x":{"limit":300000}}}');
    assert.deepEqual(fs.readdirSync(t.dir), ['limits.json'], 'no temp file left behind');
  } finally { t.cleanup(); }
});

// ── the write ───────────────────────────────────────────────────────────────

test('ctx-limits: a write changes one entry and keeps other projects, unknown keys and unknown entry keys', () => {
  const t = tempDir();
  try {
    const before = {
      version: 1, comment: 'kept', default: { limit: 420000, rearm: 140000, extra: 1 },
      projects: { [OTHER]: { limit: 600000 }, [PO]: { limit: 300000, note: 'mine' } },
      future: { a: [1, 2] },
    };
    fs.writeFileSync(t.file, JSON.stringify(before));
    const r = ctxLimits.writeProjectLimits(t.dir, PO, 500000, 150000);
    assert.equal(r.ok, true, r.error);
    const after = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.deepEqual(after, {
      ...before, projects: { [OTHER]: { limit: 600000 }, [PO]: { limit: 500000, note: 'mine', rearm: 150000 } },
    });
    assert.deepEqual(r.own, { limit: 500000, rearm: 150000 });
    assert.deepEqual([r.effective.limit, r.effective.rearm, r.effective.source], [500000, 150000, 'project']);
    assert.deepEqual(fs.readdirSync(t.dir), ['limits.json'], 'the temp file was renamed, not left');

    // Blank = the default's: the key goes; an entry left with nothing goes too.
    assert.equal(ctxLimits.writeProjectLimits(t.dir, PO, null, null).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, 'utf8')).projects[PO], { note: 'mine' });
    assert.equal(ctxLimits.writeProjectLimits(t.dir, OTHER, null, null).ok, true);
    assert.equal(OTHER in JSON.parse(fs.readFileSync(t.file, 'utf8')).projects, false);
  } finally { t.cleanup(); }
});

test('ctx-limits: with no file the write makes {version:1, projects:{slug:...}}; the plan\'s po-project example', () => {
  const t = tempDir();
  try {
    const r = ctxLimits.writeProjectLimits(t.dir, PO, 500000, 150000);
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, 'utf8')), { version: 1, projects: { [PO]: { limit: 500000, rearm: 150000 } } });
  } finally { t.cleanup(); }
});

test('ctx-limits: the write goes to a temp file in the same folder, renamed over limits.json', () => {
  const t = tempDir();
  try {
    const calls = [];
    const spy = {
      ...fs,
      readFileSync: (...a) => fs.readFileSync(...a),
      mkdirSync: (...a) => fs.mkdirSync(...a),
      writeFileSync: (p, ...rest) => { calls.push(['write', p]); return fs.writeFileSync(p, ...rest); },
      renameSync: (a, b) => { calls.push(['rename', a, b]); return fs.renameSync(a, b); },
      unlinkSync: (p) => fs.unlinkSync(p),
    };
    assert.equal(ctxLimits.writeProjectLimits(t.dir, PO, 500000, null, spy).ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'write');
    assert.equal(path.dirname(calls[0][1]), t.dir);
    assert.notEqual(calls[0][1], t.file);
    assert.deepEqual(calls[1], ['rename', calls[0][1], t.file]);

    // A failed rename leaves the old file and no temp file.
    const before = fs.readFileSync(t.file, 'utf8');
    const broken = { ...spy, renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
    const r = ctxLimits.writeProjectLimits(t.dir, PO, 600000, null, broken);
    assert.equal(r.ok, false);
    assert.match(r.error, /EBUSY/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(t.dir), ['limits.json']);
  } finally { t.cleanup(); }
});

// ── reading ─────────────────────────────────────────────────────────────────

test('ctx-limits: a corrupt, non-object or missing file reads as the built-in 400K / 150K, and a corrupt one is not overwritten', () => {
  const t = tempDir();
  try {
    for (const [text, code] of [['{not json', 'EPARSE'], ['[1,2]', 'ESHAPE'], ['"x"', 'ESHAPE'], ['', 'EPARSE']]) {
      fs.writeFileSync(t.file, text);
      const r = ctxLimits.readProjectLimits(t.dir, PO);
      assert.deepEqual([r.effective.limit, r.effective.rearm, r.effective.source], [400000, 150000, 'builtin'], text);
      assert.deepEqual(r.own, { limit: null, rearm: null });
      assert.equal(r.code, code);
      const w = ctxLimits.writeProjectLimits(t.dir, PO, 500000, null);
      assert.equal(w.ok, false, 'refused: ' + text);
      assert.equal(fs.readFileSync(t.file, 'utf8'), text, 'left as it was');
    }
    fs.rmSync(t.file);
    const none = ctxLimits.readProjectLimits(t.dir, PO);
    assert.deepEqual([none.effective.limit, none.effective.rearm, none.code], [400000, 150000, null]);
  } finally { t.cleanup(); }
});

test('ctx-limits: per value: a project key wins, an absent one is the default\'s, an invalid one is the built-in', () => {
  const doc = { default: { limit: 450000, rearm: 100000 }, projects: { [PO]: { limit: 500000 }, bad: { limit: 5, rearm: true }, odd: 7 } };
  assert.deepEqual(ctxLimits.effectiveLimits(doc, PO), { limit: 500000, rearm: 100000, source: 'project', rearmSource: 'default' });
  assert.deepEqual(ctxLimits.effectiveLimits(doc, 'bad'), { limit: 400000, rearm: 150000, source: 'builtin', rearmSource: 'builtin' });
  assert.deepEqual(ctxLimits.effectiveLimits(doc, 'odd'), { limit: 450000, rearm: 100000, source: 'default', rearmSource: 'default' });
  assert.deepEqual(ctxLimits.effectiveLimits(doc, 'unknown'), { limit: 450000, rearm: 100000, source: 'default', rearmSource: 'default' });
  assert.deepEqual(ctxLimits.effectiveLimits({ default: { limit: 'x' } }, PO).limit, 400000);
  assert.deepEqual(ctxLimits.effectiveLimits(null, PO), { limit: 400000, rearm: 150000, source: 'builtin', rearmSource: 'builtin' });
  assert.equal(ctxLimits.effectiveLimits({ projects: {} }, '__proto__').limit, 400000, 'no prototype key is an entry');
});

test('ctx-limits: the slug main writes under is Claude Code\'s folder name for the project path', () => {
  assert.equal(encodeProjectPath('C:\\Users\\jhack\\Bitbucket\\tools\\po-project'), PO);
  assert.equal(ctxLimits.SLUG_RE.test(PO), true);
});

// ── the numbers the renderer shows ──────────────────────────────────────────

test('handoffLimits: the state file\'s next_trigger, limit and rearm first, then the project\'s, then 400K / 150K', () => {
  // From the state file (the hook writes limit and rearm; next_trigger past a handoff).
  const fromState = handoffLimits({ limit: 500000, rearm: 150000, next_trigger: 660000 }, { limit: 300000, rearm: 50000 });
  assert.deepEqual(fromState, { limit: 500000, rearm: 150000, nextTrigger: 660000, dueAt: 660000, warnAt: 400000, source: 'state' });
  // From limits.json, through main's read-ctx-limits `effective`.
  const fromProject = handoffLimits({ pending: false }, { limit: 500000, rearm: 100000, source: 'project' });
  assert.deepEqual(fromProject, { limit: 500000, rearm: 100000, nextTrigger: 500000, dueAt: 500000, warnAt: 400000, source: 'project' });
  // Nothing: today's numbers.
  const builtin = handoffLimits(null, null);
  assert.deepEqual(builtin, { limit: 400000, rearm: 150000, nextTrigger: 400000, dueAt: 400000, warnAt: 300000, source: 'builtin' });
  // An old hook's state: next_trigger only.
  assert.equal(handoffLimits({ next_trigger: 560000 }, null).dueAt, 560000);
  // Invalid values are skipped, booleans included.
  assert.deepEqual(handoffLimits({ limit: true, rearm: 1 }, { limit: 99, rearm: '5' }).limit, 400000);
});

test('the due colour and the auto switch tooltip carry the session\'s numbers', () => {
  const sidecar = (n) => ({ total_input_tokens: n, context_window_size: 1000000 });
  const fromState = handoffLimits({ limit: 500000, rearm: 150000, next_trigger: 660000 }, null);
  assert.equal(chipLevel(399999, fromState), '');
  assert.equal(chipLevel(400000, fromState), 'warn');
  assert.equal(chipLevel(659999, fromState), 'warn');
  assert.equal(chipLevel(660000, fromState), 'danger');
  assert.equal(meterModel(sidecar(450000), fromState).level, 'warn');
  assert.equal(chipState({ running: true, sidecar: sidecar(660000), limits: fromState }).level, 'danger');
  assert.equal(autoOnTitle(fromState),
    'Automatic handoff prompts are on: the hook asks this session for a handoff when its context passes its next trigger, 660K (the trigger is 500K, then 150K past each handoff). Click to turn them off for this session. Hand off and Update still work.');

  const fromProject = handoffLimits(null, { limit: 500000, rearm: 100000 });
  assert.equal(chipLevel(499999, fromProject), 'warn');
  assert.equal(chipLevel(500000, fromProject), 'danger');
  assert.match(autoOnTitle(fromProject), /passes the trigger \(500K, then 100K past each handoff\)/);
  const model = autoHandoffModel({ running: true, hookSeen: true, off: false, limits: fromProject });
  assert.match(model.title, /\(500K, then 100K past each handoff\)/);

  // The fallback: the old text and the old thresholds, exactly.
  const builtin = handoffLimits(null, null);
  assert.equal(autoOnTitle(builtin), AUTO_ON_TITLE);
  assert.equal(AUTO_ON_TITLE, 'Automatic handoff prompts are on: the hook asks this session for a handoff when its context passes the trigger (400K, then 150K past each handoff). Click to turn them off for this session. Hand off and Update still work.');
  assert.equal(autoHandoffModel({ running: true, hookSeen: true, off: false }).title, AUTO_ON_TITLE);
  for (const n of [299999, 300000, 399999, 400000]) assert.equal(chipLevel(n, builtin), chipLevel(n), String(n));
  assert.equal(chipLevel(400000), 'danger');
});

test('the token chart\'s trigger: the state file\'s, else limits.json\'s for the slug, else 400K', () => {
  const t = tempDir();
  try {
    assert.deepEqual(readHandoffTrigger(SID, PO, t.dir), { limit: 400000, rearm: 150000, nextTrigger: null, source: 'builtin' });
    fs.writeFileSync(t.file, JSON.stringify({ version: 1, projects: { [PO]: { limit: 500000, rearm: 150000 } } }));
    assert.deepEqual(readHandoffTrigger(SID, PO, t.dir), { limit: 500000, rearm: 150000, nextTrigger: null, source: 'project' });
    assert.equal(readHandoffTrigger(SID, OTHER, t.dir).limit, 400000);
    fs.writeFileSync(path.join(t.dir, SID + '.state.json'), JSON.stringify({ limit: 450000, rearm: 120000, next_trigger: 610000 }));
    assert.deepEqual(readHandoffTrigger(SID, PO, t.dir), { limit: 450000, rearm: 120000, nextTrigger: 610000, source: 'state' });
    fs.writeFileSync(t.file, '{broken');
    fs.rmSync(path.join(t.dir, SID + '.state.json'));
    assert.deepEqual(readHandoffTrigger(SID, PO, t.dir), { limit: 400000, rearm: 150000, nextTrigger: null, source: 'builtin' });
  } finally { t.cleanup(); }
});
