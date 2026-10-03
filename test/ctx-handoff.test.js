const test = require('node:test');
const assert = require('node:assert/strict');

// First written blind from the "PURE API" section of the ctx-handoff SPEC,
// without reading public/ctx-handoff.js; since brought in line with the hook's
// reader contract (ctx_handoff.py, "Reader contract") and the confirmed
// override. These pin the pure helpers behind the context meter, the sidebar
// token chip and the Hand off button. Nothing here touches the DOM: the module
// has to load under plain Node.

const MODULE_PATH = '../public/ctx-handoff';

const {
  REQUEST_LINE,
  WARN_AT,
  DUE_AT,
  OVERRIDE_CONFIRM,
  fmtTokens,
  chipLevel,
  deriveCtxDir,
  meterModel,
  turnEnded,
  handoffInfo,
  chipState,
  buttonModel,
  continuePrompt,
  requestOutcome,
  launchFolder,
} = require(MODULE_PATH);

// Escapes rather than literals so the file's encoding cannot change the test.
const ELLIPSIS = '\u2026';   // "Writing…"
const TICK = '\u2713';       // "412K ✓"
const MIDDOT = '\u00b7';     // "412K / 1M · 41%"

const HANDOFF_PATH = 'C:\\Users\\jhack\\AppData\\Local\\claude-ctx\\handoffs\\abc.md';

// ── fixtures ────────────────────────────────────────────────────────────────

function sidecar(over = {}) {
  return {
    v: 1,
    session_id: 'sess-1',
    slug: 'some-slug',
    cwd: 'C:\\Users\\jhack\\Bitbucket\\switchboard',
    transcript_path: 'C:\\t\\sess-1.jsonl',
    used_percentage: 41.2,
    total_input_tokens: 412345,
    context_window_size: 1000000,
    ts: 1759500000.5,
    ...over,
  };
}

// Hook state in seconds. Default: a turn ran (prompt at 1000 s) and stopped
// (1010 s), nothing due, nothing written.
function hookState(over = {}) {
  return {
    next_trigger: 400000,
    level: 0,
    pending: false,
    crossed_at: null,
    crossed_tokens: null,
    blocked_level: null,
    handoff_path: null,
    written_at: null,
    written_tokens: null,
    compacted_at: null,
    manual: false,
    manual_blocked: false,
    last_prompt_at: 1000,
    last_stop_at: 1010,
    ...over,
  };
}

function writtenState(over = {}) {
  return hookState({
    handoff_path: HANDOFF_PATH,
    written_at: 1005,
    written_tokens: 401234,
    ...over,
  });
}

// The state file as the hook writes it BEFORE the turn start/stop change lands.
function oldHookState(over = {}) {
  const s = hookState(over);
  delete s.manual;
  delete s.manual_blocked;
  delete s.last_prompt_at;
  delete s.last_stop_at;
  return s;
}

const STOP_MS = 1010 * 1000;

function buttonArgs(over = {}) {
  return {
    isTerminal: false,
    running: true,
    ownedElsewhere: false,
    pendingRow: false,
    busy: false,
    lastBusyAtMs: null,
    state: hookState(),
    handoffReadable: false,
    request: { phase: 'idle' },
    nowMs: 2000000,
    ...over,
  };
}

// ── loading ─────────────────────────────────────────────────────────────────

test('the module loads under plain Node with no window or document', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  let mod;
  assert.doesNotThrow(() => { mod = require(MODULE_PATH); });
  assert.equal(typeof mod, 'object');
  assert.notEqual(mod, null);
});

test('every name in the pure API is exported with the right type', () => {
  const mod = require(MODULE_PATH);
  for (const name of ['REQUEST_LINE', 'OVERRIDE_CONFIRM']) assert.equal(typeof mod[name], 'string', name);
  for (const name of ['WARN_AT', 'DUE_AT']) assert.equal(typeof mod[name], 'number', name);
  for (const name of [
    'fmtTokens', 'chipLevel', 'deriveCtxDir', 'meterModel', 'turnEnded',
    'handoffInfo', 'chipState', 'buttonModel', 'continuePrompt', 'requestOutcome',
    'launchFolder',
  ]) {
    assert.equal(typeof mod[name], 'function', name);
  }
});

// ── constants ───────────────────────────────────────────────────────────────

test('constants match the status line thresholds and the exact typed line', () => {
  assert.equal(REQUEST_LINE, 'Write the context handoff now. [ctx-handoff:request]');
  assert.equal(WARN_AT, 300000);
  assert.equal(DUE_AT, 400000);
});

test('the request line carries no newline or carriage return (Enter is sent separately)', () => {
  assert.ok(!/[\r\n]/.test(REQUEST_LINE));
});

test('the request line ends with the marker (the hook matches the end of the prompt only)', () => {
  assert.ok(REQUEST_LINE.endsWith('[ctx-handoff:request]'));
});

test('the override confirmation is the exact text Jason approved', () => {
  assert.equal(
    OVERRIDE_CONFIRM,
    'This session has not reported the end of its turn. If a permission prompt or a question is open in the terminal, '
      + 'the typed line and Enter could answer it. Type the handoff request anyway?'
  );
});

// ── fmtTokens ───────────────────────────────────────────────────────────────

test('fmtTokens: thousands below a million, millions with one decimal unless whole', () => {
  const cases = [
    [0, '0K'],
    [499, '0K'],
    [501, '1K'],
    [999, '1K'],
    [1000, '1K'],
    [1499, '1K'],
    [200000, '200K'],
    [299999, '300K'],
    [412345, '412K'],
    [412501, '413K'],
    [999499, '999K'],
    [1000000, '1M'],
    [1200000, '1.2M'],
    [1500000, '1.5M'],
    [2000000, '2M'],
    [2500000, '2.5M'],
  ];
  for (const [n, want] of cases) assert.equal(fmtTokens(n), want, `fmtTokens(${n})`);
});

test('fmtTokens: an exact half rounds to the even neighbour, like the hook\'s Python round()', () => {
  const cases = [
    [500, '0K'],
    [1500, '2K'],
    [2500, '2K'],
    [3500, '4K'],
    [412500, '412K'],
    [413500, '414K'],
    [299500, '300K'],
    [300500, '300K'],
    [999500, '1000K'],
  ];
  for (const [n, want] of cases) assert.equal(fmtTokens(n), want, `fmtTokens(${n})`);
});

test('fmtTokens: the one-decimal million rounds an exact tie to even, like the hook\'s "%.1f"', () => {
  const cases = [
    [1250000, '1.2M'],
    [1750000, '1.8M'],
    [2250000, '2.2M'],
    [2750000, '2.8M'],
    // Not ties: the nearest double of 1.15 is below it, of 1.05 above it.
    [1150000, '1.1M'],
    [1050000, '1.1M'],
    [1040000, '1.0M'],
    [1260000, '1.3M'],
  ];
  for (const [n, want] of cases) assert.equal(fmtTokens(n), want, `fmtTokens(${n})`);
});

// ── chipLevel ───────────────────────────────────────────────────────────────

test('chipLevel: dim below 300K, warn from 300K, danger from 400K', () => {
  const cases = [
    [0, ''],
    [1, ''],
    [299999, ''],
    [300000, 'warn'],
    [300001, 'warn'],
    [399999, 'warn'],
    [400000, 'danger'],
    [400001, 'danger'],
    [1500000, 'danger'],
  ];
  for (const [n, want] of cases) assert.equal(chipLevel(n), want, `chipLevel(${n})`);
});

test('chipLevel uses the exported thresholds', () => {
  assert.equal(chipLevel(WARN_AT - 1), '');
  assert.equal(chipLevel(WARN_AT), 'warn');
  assert.equal(chipLevel(DUE_AT - 1), 'warn');
  assert.equal(chipLevel(DUE_AT), 'danger');
});

// ── deriveCtxDir ────────────────────────────────────────────────────────────

const CTX_DIR = 'C:\\Users\\jhack\\AppData\\Local\\claude-ctx';

test('deriveCtxDir: the real diagnostics path, with backslashes', () => {
  assert.equal(
    deriveCtxDir('C:\\Users\\jhack\\AppData\\Roaming\\switchboard\\diagnostics'),
    CTX_DIR
  );
});

test('deriveCtxDir: forward slashes in, backslashes out', () => {
  assert.equal(
    deriveCtxDir('C:/Users/jhack/AppData/Roaming/switchboard/diagnostics'),
    CTX_DIR
  );
});

test('deriveCtxDir: mixed slashes', () => {
  assert.equal(
    deriveCtxDir('C:\\Users\\jhack/AppData\\Roaming/switchboard/diagnostics'),
    CTX_DIR
  );
});

test('deriveCtxDir: AppData/Roaming is matched case-insensitively', () => {
  for (const p of [
    'C:\\Users\\jhack\\appdata\\roaming\\switchboard\\diagnostics',
    'C:\\Users\\jhack\\APPDATA\\ROAMING\\switchboard\\diagnostics',
    'C:/Users/jhack/appData/roaming/switchboard/diagnostics',
  ]) {
    assert.equal(deriveCtxDir(p), CTX_DIR, p);
  }
});

test('deriveCtxDir: keeps whatever precedes the segment (another user, another drive)', () => {
  assert.equal(
    deriveCtxDir('D:/Users/Someone Else/AppData/Roaming/switchboard/diagnostics'),
    'D:\\Users\\Someone Else\\AppData\\Local\\claude-ctx'
  );
});

test('deriveCtxDir: no AppData/Roaming segment means inert (null)', () => {
  for (const p of [
    'D:\\sb-data\\diagnostics',
    'D:/sb-data/diagnostics',
    'C:\\Users\\jhack\\AppData\\Local\\switchboard\\diagnostics',
    '/home/jason/.config/switchboard/diagnostics',
    '',
  ]) {
    assert.equal(deriveCtxDir(p), null, JSON.stringify(p));
  }
});

test('deriveCtxDir: non-strings give null and never throw', () => {
  for (const v of [null, undefined, 42, true, {}, [], () => {}]) {
    assert.equal(deriveCtxDir(v), null, String(v));
  }
});

// ── meterModel ──────────────────────────────────────────────────────────────

test('meterModel: null unless the sidecar is an object with a positive integer token count', () => {
  for (const v of [null, undefined, 'x', 7, true]) {
    assert.equal(meterModel(v), null, `sidecar ${String(v)}`);
  }
  assert.equal(meterModel({}), null, 'empty object');
  for (const t of [null, undefined, 0, -1, -412345, 1.5, NaN, Infinity, '412345', true]) {
    assert.equal(meterModel(sidecar({ total_input_tokens: t })), null, `total_input_tokens ${String(t)}`);
  }
});

test('meterModel: a full reading', () => {
  const m = meterModel(sidecar());
  assert.notEqual(m, null);
  assert.equal(m.tokens, 412345);
  assert.equal(m.size, 1000000);
  assert.equal(m.pct, 41.2);
  assert.equal(m.text, '412K');
  assert.equal(m.full, `412K / 1M ${MIDDOT} 41%`);
  assert.equal(m.level, 'danger');
  assert.equal(m.ts, 1759500000.5);
});

test('meterModel: level follows the token thresholds, not the percentage', () => {
  const cases = [
    [150000, ''],
    [299999, ''],
    [300000, 'warn'],
    [399999, 'warn'],
    [400000, 'danger'],
  ];
  for (const [tokens, want] of cases) {
    const m = meterModel(sidecar({ total_input_tokens: tokens, used_percentage: 99 }));
    assert.equal(m.level, want, `tokens ${tokens}`);
  }
});

test('meterModel: used_percentage wins over the computed ratio and is floored in the label', () => {
  const m = meterModel(sidecar({ total_input_tokens: 250000, context_window_size: 1000000, used_percentage: 99.9 }));
  assert.equal(m.pct, 99.9);
  assert.equal(m.full, `250K / 1M ${MIDDOT} 99%`);
});

test('meterModel: used_percentage 0 is a number, so it is used as is', () => {
  const m = meterModel(sidecar({ total_input_tokens: 250000, context_window_size: 1000000, used_percentage: 0 }));
  assert.equal(m.pct, 0);
  assert.equal(m.full, `250K / 1M ${MIDDOT} 0%`);
});

test('meterModel: used_percentage null falls back to tokens / size', () => {
  const m = meterModel(sidecar({ total_input_tokens: 250000, context_window_size: 1000000, used_percentage: null }));
  assert.equal(m.pct, 25);
  assert.equal(m.full, `250K / 1M ${MIDDOT} 25%`);

  const m2 = meterModel(sidecar({ total_input_tokens: 150000, context_window_size: 200000, used_percentage: null }));
  assert.equal(m2.pct, 75);
  assert.equal(m2.full, `150K / 200K ${MIDDOT} 75%`);
});

test('meterModel: a missing used_percentage key behaves like null', () => {
  const sc = sidecar({ total_input_tokens: 250000, context_window_size: 1000000 });
  delete sc.used_percentage;
  const m = meterModel(sc);
  assert.equal(m.pct, 25);
  assert.equal(m.full, `250K / 1M ${MIDDOT} 25%`);
});

test('meterModel: context_window_size 0 keeps the percentage but shortens the label', () => {
  const m = meterModel(sidecar({ context_window_size: 0, used_percentage: 41.2 }));
  assert.equal(m.size, 0);
  assert.equal(m.pct, 41.2);
  assert.equal(m.text, '412K');
  assert.equal(m.full, '412K');
});

test('meterModel: context_window_size 0 and used_percentage null leaves pct null', () => {
  const m = meterModel(sidecar({ context_window_size: 0, used_percentage: null }));
  assert.equal(m.size, 0);
  assert.equal(m.pct, null);
  assert.equal(m.full, '412K');
  assert.equal(m.level, 'danger');
});

test('meterModel: a size that is not a positive number counts as 0', () => {
  for (const size of [null, undefined, -200000, '1000000', NaN]) {
    const m = meterModel(sidecar({ context_window_size: size, used_percentage: null }));
    assert.notEqual(m, null, `size ${String(size)}`);
    assert.equal(m.size, 0, `size ${String(size)}`);
    assert.equal(m.pct, null, `size ${String(size)}`);
    assert.equal(m.full, m.text, `size ${String(size)}`);
  }
});

// ── turnEnded ───────────────────────────────────────────────────────────────

test('turnEnded: table', () => {
  const cases = [
    ['null state', null, false],
    ['undefined state', undefined, false],
    ['empty object', {}, false],
    ['state from the hook before the change (keys missing)', oldHookState(), false],
    ['stop only, prompt key missing', { last_stop_at: 1010 }, true],
    ['stop only, prompt null', { last_stop_at: 1010, last_prompt_at: null }, true],
    ['stop after prompt', { last_stop_at: 1010, last_prompt_at: 1000 }, true],
    ['stop equal to prompt', { last_stop_at: 1010, last_prompt_at: 1010 }, true],
    ['stop a hair after prompt', { last_stop_at: 1010.001, last_prompt_at: 1010 }, true],
    ['prompt after stop (turn running)', { last_stop_at: 1010, last_prompt_at: 1010.001 }, false],
    ['prompt only', { last_prompt_at: 1000 }, false],
    ['prompt only, stop null', { last_prompt_at: 1000, last_stop_at: null }, false],
    ['both null', { last_prompt_at: null, last_stop_at: null }, false],
    ['stop is a string', { last_stop_at: '1010', last_prompt_at: 1000 }, false],
  ];
  for (const [name, state, want] of cases) {
    assert.equal(turnEnded(state), want, name);
  }
});

test('turnEnded returns a real boolean', () => {
  assert.equal(turnEnded(hookState()), true);
  assert.equal(turnEnded(null), false);
});

// ── handoffInfo ─────────────────────────────────────────────────────────────

test('handoffInfo: missing state is "none" with every other field null', () => {
  for (const s of [null, undefined]) {
    for (const readable of [true, false, undefined]) {
      const info = handoffInfo(s, readable);
      assert.equal(info.status, 'none');
      assert.equal(info.path, null);
      assert.equal(info.writtenAt, null);
      assert.equal(info.writtenTokens, null);
    }
  }
});

test('handoffInfo: nothing pending and nothing written is "none"', () => {
  assert.equal(handoffInfo(hookState(), false).status, 'none');
  assert.equal(handoffInfo(hookState(), true).status, 'none');
  assert.equal(handoffInfo(oldHookState(), true).status, 'none');
  assert.equal(handoffInfo({}, true).status, 'none');
});

test('handoffInfo: pending is "due"', () => {
  assert.equal(handoffInfo(hookState({ pending: true }), false).status, 'due');
});

test('handoffInfo: pending wins over an older written handoff, even a readable one', () => {
  const s = writtenState({ pending: true, crossed_at: 2000, crossed_tokens: 455000 });
  assert.equal(handoffInfo(s, true).status, 'due');
  assert.equal(handoffInfo(s, false).status, 'due');
});

test('handoffInfo: written needs written_at, a path, and a readable file', () => {
  const info = handoffInfo(writtenState(), true);
  assert.equal(info.status, 'written');
  assert.equal(info.path, HANDOFF_PATH);
  assert.equal(info.writtenAt, 1005);
  assert.equal(info.writtenTokens, 401234);
});

test('handoffInfo: written works on a state without the newer keys', () => {
  const s = oldHookState({ handoff_path: HANDOFF_PATH, written_at: 1005, written_tokens: 401234 });
  assert.equal(handoffInfo(s, true).status, 'written');
});

test('handoffInfo: a missing pending key is not pending', () => {
  const s = writtenState();
  delete s.pending;
  assert.equal(handoffInfo(s, true).status, 'written');
});

test('handoffInfo: only handoffReadable === true counts', () => {
  for (const readable of [false, undefined, null, 'true', 1, {}]) {
    assert.equal(handoffInfo(writtenState(), readable).status, 'none', `readable ${String(readable)}`);
  }
});

test('handoffInfo: a path that survived compaction without a written_at is "none"', () => {
  assert.equal(handoffInfo(writtenState({ written_at: null }), true).status, 'none');
  const s = writtenState();
  delete s.written_at;
  assert.equal(handoffInfo(s, true).status, 'none');
});

test('handoffInfo: written_at without a usable path is "none"', () => {
  for (const p of [null, undefined, '', 42]) {
    assert.equal(handoffInfo(writtenState({ handoff_path: p }), true).status, 'none', `path ${String(p)}`);
  }
});

test('handoffInfo: pending must be exactly true', () => {
  for (const p of [false, null, undefined, 0, 'true', 1]) {
    assert.notEqual(handoffInfo(hookState({ pending: p }), false).status, 'due', `pending ${String(p)}`);
  }
});

// ── chipState ───────────────────────────────────────────────────────────────

function chipArgs(over = {}) {
  return {
    sidecar: sidecar(),
    state: null,
    handoffReadable: false,
    running: true,
    isTerminal: false,
    ...over,
  };
}

function assertOneLineTitle(chip) {
  assert.equal(typeof chip.title, 'string');
  assert.ok(chip.title.length > 0, 'title is not empty');
  assert.ok(!/[\r\n]/.test(chip.title), 'title is one line');
}

test('chipState: null for a stopped session, a plain terminal, or no reading', () => {
  assert.equal(chipState(chipArgs({ running: false })), null);
  assert.equal(chipState(chipArgs({ running: false, state: writtenState(), handoffReadable: true })), null);
  assert.equal(chipState(chipArgs({ isTerminal: true })), null);
  assert.equal(chipState(chipArgs({ sidecar: null })), null);
  assert.equal(chipState(chipArgs({ sidecar: undefined })), null);
  assert.equal(chipState(chipArgs({ sidecar: sidecar({ total_input_tokens: null }) })), null);
  assert.equal(chipState(chipArgs({ sidecar: sidecar({ total_input_tokens: 0 }) })), null);
});

test('chipState: no reading means no chip even when a handoff is due', () => {
  assert.equal(chipState(chipArgs({ sidecar: null, state: hookState({ pending: true }) })), null);
});

test('chipState: plain token chip takes its level from the thresholds', () => {
  const cases = [
    [150000, '150K', ''],
    [299999, '300K', ''],
    [300000, '300K', 'warn'],
    [399999, '400K', 'warn'],
    [400000, '400K', 'danger'],
    [412345, '412K', 'danger'],
    [1500000, '1.5M', 'danger'],
  ];
  for (const [tokens, text, level] of cases) {
    for (const state of [null, undefined, hookState(), oldHookState()]) {
      const chip = chipState(chipArgs({ sidecar: sidecar({ total_input_tokens: tokens }), state }));
      assert.notEqual(chip, null, `tokens ${tokens}`);
      assert.equal(chip.text, text, `tokens ${tokens}`);
      assert.equal(chip.level, level, `tokens ${tokens}`);
      assertOneLineTitle(chip);
    }
  }
});

test('chipState: a due handoff', () => {
  const chip = chipState(chipArgs({ state: hookState({ pending: true }) }));
  assert.equal(chip.level, 'due');
  assert.equal(chip.text, '412K due');
  assertOneLineTitle(chip);
});

test('chipState: due overrides the token level even below the warn threshold', () => {
  const chip = chipState(chipArgs({
    sidecar: sidecar({ total_input_tokens: 120000 }),
    state: hookState({ pending: true }),
  }));
  assert.equal(chip.level, 'due');
  assert.equal(chip.text, '120K due');
});

test('chipState: due wins over an older written handoff', () => {
  const chip = chipState(chipArgs({ state: writtenState({ pending: true }), handoffReadable: true }));
  assert.equal(chip.level, 'due');
  assert.equal(chip.text, '412K due');
});

test('chipState: a written, readable handoff shows the green tick', () => {
  const chip = chipState(chipArgs({ state: writtenState(), handoffReadable: true }));
  assert.equal(chip.level, 'written');
  assert.equal(chip.text, `412K ${TICK}`);
  assertOneLineTitle(chip);
});

test('chipState: a written handoff whose file is not readable falls back to the token level', () => {
  const chip = chipState(chipArgs({ state: writtenState(), handoffReadable: false }));
  assert.equal(chip.level, 'danger');
  assert.equal(chip.text, '412K');
});

test('chipState: the title carries the context numbers', () => {
  const plain = chipState(chipArgs());
  assert.ok(plain.title.includes('412K'), plain.title);
  const due = chipState(chipArgs({ state: hookState({ pending: true }) }));
  assert.ok(due.title.includes('412K'), due.title);
  const written = chipState(chipArgs({ state: writtenState(), handoffReadable: true }));
  assert.ok(written.title.includes('412K'), written.title);
});

test('chipState: the title says something more when there is a handoff state', () => {
  const plain = chipState(chipArgs());
  const due = chipState(chipArgs({ state: hookState({ pending: true }) }));
  const written = chipState(chipArgs({ state: writtenState(), handoffReadable: true }));
  assert.notEqual(due.title, plain.title);
  assert.notEqual(written.title, plain.title);
  assert.notEqual(due.title, written.title);
});

// ── buttonModel ─────────────────────────────────────────────────────────────

const WHY_OWNED = 'Shown in another window';
const WHY_PENDING = 'Session is still starting';
const WHY_BUSY = 'Session is working';

// Every way the turn marker can fail to say "ended" while the session is not
// busy. Each one is a confirmed override, never a plain enabled button and
// never a disabled one (Jason: "Allow a confirmed override").
const NOT_ENDED = [
  ['prompt after stop', { state: hookState({ last_prompt_at: 1020, last_stop_at: 1010 }) }],
  ['never stopped', { state: hookState({ last_prompt_at: 1000, last_stop_at: null }) }],
  ['state missing (null)', { state: null }],
  ['state missing (undefined)', { state: undefined }],
  ['state without the turn keys', { state: oldHookState() }],
  ['spinner came on after the last stop', { lastBusyAtMs: STOP_MS + 1 }],
  ['spinner long after the last stop', { lastBusyAtMs: STOP_MS + 60000 }],
  ['no stop since the last request typed here', { request: { phase: 'idle', atMs: STOP_MS + 5000, reason: '' } }],
];

test('buttonModel: rule 1, plain terminals never show the button', () => {
  assert.equal(buttonModel(buttonArgs({ isTerminal: true })).visible, false);
  assert.equal(buttonModel(buttonArgs({
    isTerminal: true, state: writtenState(), handoffReadable: true,
  })).visible, false);
  assert.equal(buttonModel(buttonArgs({
    isTerminal: true, request: { phase: 'requested', atMs: 1990000 },
  })).visible, false);
  assert.equal(buttonModel(buttonArgs({
    isTerminal: true, request: { phase: 'timeout', atMs: 1000000, reason: 'x' },
  })).visible, false);
});

test('buttonModel: rule 2, a request in flight shows a disabled "Writing…"', () => {
  const m = buttonModel(buttonArgs({ request: { phase: 'requested', atMs: 1990000 } }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'writing');
  assert.equal(m.primary.label, `Writing${ELLIPSIS}`);
  assert.equal(m.primary.enabled, false);
  assert.equal(m.primary.override, false);
  assert.equal(m.update.visible, false);
});

test('buttonModel: rule 2 comes before rule 3 (an Update in flight hides Continue and Update)', () => {
  const m = buttonModel(buttonArgs({
    state: writtenState(),
    handoffReadable: true,
    request: { phase: 'requested', atMs: 1990000 },
  }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'writing');
  assert.equal(m.primary.enabled, false);
  assert.equal(m.update.visible, false);
});

test('buttonModel: rule 2, a request in flight is never an override, whatever the turn marker says', () => {
  for (const [name, over] of NOT_ENDED) {
    const m = buttonModel(buttonArgs({ ...over, request: { phase: 'requested', atMs: 1990000 } }));
    assert.equal(m.primary.kind, 'writing', name);
    assert.equal(m.primary.enabled, false, name);
    assert.equal(m.primary.override, false, name);
  }
});

test('buttonModel: rule 3, written handoff on a running idle session', () => {
  const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'continue');
  assert.equal(m.primary.label, 'Continue in new session');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, false);
  assert.equal(m.update.visible, true);
  assert.equal(m.update.enabled, true);
  assert.equal(m.update.override, false);
  assert.ok(!m.note, 'no note outside a timeout');
});

test('buttonModel: rule 3, a stopped session with a written handoff keeps Continue and hides Update', () => {
  const m = buttonModel(buttonArgs({ running: false, state: writtenState(), handoffReadable: true }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'continue');
  assert.equal(m.primary.label, 'Continue in new session');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.update.visible, false);
  assert.equal(m.update.enabled, false);
  assert.equal(m.update.override, false);
});

test('buttonModel: rule 3, Continue stays enabled when typing is refused; Update says why', () => {
  const cases = [
    ['owned elsewhere', { ownedElsewhere: true }, WHY_OWNED],
    ['pending row', { pendingRow: true }, WHY_PENDING],
    ['busy', { busy: true }, WHY_BUSY],
  ];
  for (const [name, over, why] of cases) {
    const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, ...over }));
    assert.equal(m.visible, true, name);
    assert.equal(m.primary.kind, 'continue', name);
    assert.equal(m.primary.enabled, true, name);
    assert.equal(m.update.visible, true, name);
    assert.equal(m.update.enabled, false, name);
    assert.equal(m.update.override, false, name);
    assert.equal(m.update.title, why, name);
  }
});

test('buttonModel: rule 3, Update becomes a confirmed override when the turn has not ended', () => {
  const cases = [
    ['busy after the last stop', { lastBusyAtMs: STOP_MS + 1 }],
    ['turn still running', { state: writtenState({ last_prompt_at: 1020 }) }],
    ['old hook, no turn keys', {
      state: oldHookState({ handoff_path: HANDOFF_PATH, written_at: 1005, written_tokens: 401234 }),
    }],
    ['no stop since the last request', { request: { phase: 'idle', atMs: STOP_MS + 5000, reason: '' } }],
  ];
  for (const [name, over] of cases) {
    const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, ...over }));
    assert.equal(m.visible, true, name);
    assert.equal(m.primary.kind, 'continue', name);
    assert.equal(m.primary.enabled, true, name);
    assert.equal(m.primary.override, false, `${name}: Continue types nothing, so it never asks`);
    assert.equal(m.update.visible, true, name);
    assert.equal(m.update.enabled, true, name);
    assert.equal(m.update.override, true, name);
    assert.ok(m.update.title.length > 0, name);
  }
});

test('buttonModel: rule 3, a locked Continue shows as disabled and comes back when the lock goes', () => {
  const locked = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, continueLocked: true }));
  assert.equal(locked.visible, true);
  assert.equal(locked.primary.kind, 'continue');
  assert.equal(locked.primary.label, 'Continue in new session');
  assert.equal(locked.primary.enabled, false);
  assert.equal(locked.primary.override, false);
  assert.ok(locked.primary.title.length > 0);
  // The lock is about Continue only.
  assert.equal(locked.update.visible, true);
  assert.equal(locked.update.enabled, true);

  for (const continueLocked of [false, undefined, null, 1, 'true']) {
    const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, continueLocked }));
    assert.equal(m.primary.enabled, true, `continueLocked ${String(continueLocked)}`);
  }
  assert.notEqual(
    locked.primary.title,
    buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true })).primary.title
  );
});

test('buttonModel: the Continue lock does not touch Hand off', () => {
  const m = buttonModel(buttonArgs({ continueLocked: true }));
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.primary.enabled, true);
});

test('buttonModel: rule 4, nothing written and not running hides the button', () => {
  assert.equal(buttonModel(buttonArgs({ running: false })).visible, false);
  assert.equal(buttonModel(buttonArgs({ running: false, state: null })).visible, false);
  assert.equal(buttonModel(buttonArgs({ running: false, state: hookState({ pending: true }) })).visible, false);
  // Written but the file is gone: not 'written', so a stopped session shows nothing.
  assert.equal(buttonModel(buttonArgs({
    running: false, state: writtenState(), handoffReadable: false,
  })).visible, false);
});

test('buttonModel: rule 4, a running idle session offers an enabled Hand off', () => {
  const m = buttonModel(buttonArgs());
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.primary.label, 'Hand off');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, false);
  assert.equal(m.update.visible, false);
  assert.ok(!m.note, 'no note outside a timeout');
});

test('buttonModel: rule 4, a due handoff is still "Hand off", even over an older written one', () => {
  const m = buttonModel(buttonArgs({ state: writtenState({ pending: true }), handoffReadable: true }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.primary.label, 'Hand off');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, false);
  assert.equal(m.update.visible, false);
});

test('buttonModel: rule 4, an unreadable written handoff falls back to Hand off', () => {
  const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: false }));
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.update.visible, false);
});

test('buttonModel: busy only blocks when it is exactly true', () => {
  for (const busy of [false, undefined, null]) {
    const m = buttonModel(buttonArgs({ busy }));
    assert.equal(m.primary.enabled, true, `busy ${String(busy)}`);
    assert.equal(m.primary.override, false, `busy ${String(busy)}`);
  }
});

test('buttonModel: lastBusyAtMs null or undefined does not block', () => {
  for (const lastBusyAtMs of [null, undefined]) {
    const m = buttonModel(buttonArgs({ lastBusyAtMs }));
    assert.equal(m.primary.enabled, true, `lastBusyAtMs ${String(lastBusyAtMs)}`);
    assert.equal(m.primary.override, false, `lastBusyAtMs ${String(lastBusyAtMs)}`);
  }
});

test('buttonModel: lastBusyAtMs before, at, and after the last stop', () => {
  const before = buttonModel(buttonArgs({ lastBusyAtMs: STOP_MS - 5000 }));
  assert.equal(before.primary.enabled, true, 'busy before the stop');
  assert.equal(before.primary.override, false, 'busy before the stop');

  const equal = buttonModel(buttonArgs({ lastBusyAtMs: STOP_MS }));
  assert.equal(equal.primary.enabled, true, 'busy at the same millisecond as the stop');
  assert.equal(equal.primary.override, false, 'busy at the same millisecond as the stop');

  // The spinner has since gone off (busy false), so this is not "working":
  // it is a turn the state file has not caught up with, and it asks first.
  const after = buttonModel(buttonArgs({ lastBusyAtMs: STOP_MS + 1 }));
  assert.equal(after.primary.kind, 'handoff');
  assert.equal(after.primary.enabled, true, 'busy after the stop');
  assert.equal(after.primary.override, true, 'busy after the stop');
});

test('buttonModel: rule 5, each disabled reason on Hand off', () => {
  const cases = [
    ['owned elsewhere', { ownedElsewhere: true }, WHY_OWNED],
    ['pending row', { pendingRow: true }, WHY_PENDING],
    ['busy', { busy: true }, WHY_BUSY],
    ['busy, spinner after the last stop', { busy: true, lastBusyAtMs: STOP_MS + 60000 }, WHY_BUSY],
  ];
  for (const [name, over, why] of cases) {
    const m = buttonModel(buttonArgs(over));
    assert.equal(m.visible, true, name);
    assert.equal(m.primary.kind, 'handoff', name);
    assert.equal(m.primary.label, 'Hand off', name);
    assert.equal(m.primary.enabled, false, name);
    assert.equal(m.primary.override, false, name);
    assert.equal(m.primary.title, why, name);
    assert.equal(m.update.visible, false, name);
  }
});

test('buttonModel: rule 5, the first matching reason wins', () => {
  const all = { ownedElsewhere: true, pendingRow: true, busy: true, state: null };
  assert.equal(buttonModel(buttonArgs(all)).primary.title, WHY_OWNED);
  assert.equal(buttonModel(buttonArgs({ ...all, ownedElsewhere: false })).primary.title, WHY_PENDING);
  assert.equal(buttonModel(buttonArgs({ ...all, ownedElsewhere: false, pendingRow: false })).primary.title, WHY_BUSY);
  // Nothing left that forbids typing; the missing state makes it an override.
  const last = buttonModel(buttonArgs({ ...all, ownedElsewhere: false, pendingRow: false, busy: false }));
  assert.equal(last.primary.enabled, true);
  assert.equal(last.primary.override, true);
});

test('buttonModel: override, Hand off asks first for every way the turn can be "not ended"', () => {
  const plainTitle = buttonModel(buttonArgs()).primary.title;
  for (const [name, over] of NOT_ENDED) {
    const m = buttonModel(buttonArgs(over));
    assert.equal(m.visible, true, name);
    assert.equal(m.primary.kind, 'handoff', name);
    assert.equal(m.primary.label, 'Hand off', name);
    assert.equal(m.primary.enabled, true, name);
    assert.equal(m.primary.override, true, name);
    assert.ok(m.primary.title.length > 0, name);
    assert.notEqual(m.primary.title, plainTitle, `${name}: the tooltip says it will ask`);
    assert.equal(m.update.visible, false, name);
  }
});

test('buttonModel: override, a busy session is never typed into, with or without a turn marker', () => {
  for (const [name, over] of NOT_ENDED) {
    const hand = buttonModel(buttonArgs({ ...over, busy: true }));
    assert.equal(hand.primary.enabled, false, name);
    assert.equal(hand.primary.override, false, name);
    assert.equal(hand.primary.title, WHY_BUSY, name);
  }
  const update = buttonModel(buttonArgs({
    busy: true, state: writtenState({ last_prompt_at: 1020 }), handoffReadable: true,
  })).update;
  assert.equal(update.enabled, false);
  assert.equal(update.override, false);
  assert.equal(update.title, WHY_BUSY);
});

test('buttonModel: override, never for a session shown elsewhere, still starting, stopped, or a terminal', () => {
  for (const [name, over] of NOT_ENDED) {
    for (const [label, block, why] of [
      ['owned elsewhere', { ownedElsewhere: true }, WHY_OWNED],
      ['pending row', { pendingRow: true }, WHY_PENDING],
    ]) {
      const m = buttonModel(buttonArgs({ ...over, ...block }));
      assert.equal(m.primary.enabled, false, `${name} / ${label}`);
      assert.equal(m.primary.override, false, `${name} / ${label}`);
      assert.equal(m.primary.title, why, `${name} / ${label}`);
    }
    const stopped = buttonModel(buttonArgs({ ...over, running: false }));
    assert.equal(stopped.visible, false, `${name} / stopped`);
    assert.equal(stopped.primary.enabled, false, `${name} / stopped`);
    assert.equal(stopped.primary.override, false, `${name} / stopped`);
    const terminal = buttonModel(buttonArgs({ ...over, isTerminal: true }));
    assert.equal(terminal.visible, false, `${name} / terminal`);
    assert.equal(terminal.primary.override, false, `${name} / terminal`);
  }
});

test('buttonModel: busy with the turn also unfinished reports "working", not the turn', () => {
  const m = buttonModel(buttonArgs({
    busy: true,
    state: hookState({ last_prompt_at: 1020, last_stop_at: 1010 }),
  }));
  assert.equal(m.primary.enabled, false);
  assert.equal(m.primary.override, false);
  assert.equal(m.primary.title, WHY_BUSY);
});

test('buttonModel: an idle-looking session whose turn has not stopped is only ever an override', () => {
  // The permission-prompt case: Switchboard sees no busy flag, the hook has
  // recorded a prompt and no stop since. It must not be typed into unasked.
  const m = buttonModel(buttonArgs({
    busy: false,
    lastBusyAtMs: null,
    state: hookState({ last_prompt_at: 1500, last_stop_at: 1010 }),
  }));
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, true);
});

test('buttonModel: a recorded busy time with no hook state at all is an override', () => {
  const m = buttonModel(buttonArgs({ state: null, lastBusyAtMs: 1500000 }));
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, true);
});

test('buttonModel: a Stop only counts when it is later than the last request typed here', () => {
  for (const phase of ['idle', 'timeout']) {
    const at = (atMs) => buttonModel(buttonArgs({ request: { phase, atMs, reason: '' } })).primary;

    const stopLater = at(STOP_MS - 1);
    assert.equal(stopLater.enabled, true, `${phase}: stop 1 ms after the request`);
    assert.equal(stopLater.override, false, `${phase}: stop 1 ms after the request`);

    const same = at(STOP_MS);
    assert.equal(same.enabled, true, `${phase}: stop in the same millisecond`);
    assert.equal(same.override, true, `${phase}: stop in the same millisecond is not later`);

    const stopOlder = at(STOP_MS + 1);
    assert.equal(stopOlder.enabled, true, `${phase}: stop before the request`);
    assert.equal(stopOlder.override, true, `${phase}: stop before the request`);
  }
});

test('buttonModel: a request that never happened (atMs 0 or missing) adds no condition', () => {
  for (const request of [{ phase: 'idle' }, { phase: 'idle', atMs: 0, reason: '' }, undefined, null]) {
    const m = buttonModel(buttonArgs({ request }));
    assert.equal(m.primary.enabled, true, JSON.stringify(request));
    assert.equal(m.primary.override, false, JSON.stringify(request));
  }
});

test('buttonModel: the request time also gates Update', () => {
  const state = writtenState();
  const stale = buttonModel(buttonArgs({
    state, handoffReadable: true, request: { phase: 'idle', atMs: STOP_MS + 1, reason: '' },
  }));
  assert.equal(stale.update.enabled, true);
  assert.equal(stale.update.override, true);
  const fresh = buttonModel(buttonArgs({
    state, handoffReadable: true, request: { phase: 'idle', atMs: STOP_MS - 1, reason: '' },
  }));
  assert.equal(fresh.update.enabled, true);
  assert.equal(fresh.update.override, false);
});

test('buttonModel: rule 6, a timed-out request on a session with no handoff', () => {
  const reason = 'The request did not reach the session. If the line is sitting in the input box, press Enter there.';
  // No Stop since the request: asking again is an override, not a plain click.
  const m = buttonModel(buttonArgs({ request: { phase: 'timeout', atMs: 1900000, reason } }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.primary.label, 'Hand off');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, true);
  assert.equal(m.update.visible, false);
  assert.equal(m.note, reason);

  // A turn has run and stopped since: a plain Hand off again, note still shown.
  const later = buttonModel(buttonArgs({
    state: hookState({ last_prompt_at: 1901, last_stop_at: 1950 }),
    request: { phase: 'timeout', atMs: 1900000, reason },
  }));
  assert.equal(later.primary.enabled, true);
  assert.equal(later.primary.override, false);
  assert.equal(later.note, reason);
});

test('buttonModel: rule 6, a timed-out Update on a session with a written handoff', () => {
  const reason = 'No handoff was written after 10 minutes.';
  const m = buttonModel(buttonArgs({
    state: writtenState({ last_prompt_at: 1301, last_stop_at: 1400 }),
    handoffReadable: true,
    request: { phase: 'timeout', atMs: 1300000, reason },
  }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'continue');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.update.visible, true);
  assert.equal(m.update.enabled, true);
  assert.equal(m.update.override, false);
  assert.equal(m.note, reason);
});

test('buttonModel: rule 6, a timeout does not override the disabled reason', () => {
  const m = buttonModel(buttonArgs({
    busy: true,
    request: { phase: 'timeout', atMs: 1900000, reason: 'No handoff was written after 10 minutes.' },
  }));
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.primary.enabled, false);
  assert.equal(m.primary.override, false);
  assert.equal(m.primary.title, WHY_BUSY);
  assert.equal(m.note, 'No handoff was written after 10 minutes.');
});

test('buttonModel: rule 6, the "session ended" note shows beside Continue on a stopped session', () => {
  const reason = 'The session ended before the handoff was written.';
  const m = buttonModel(buttonArgs({
    running: false,
    state: writtenState(),
    handoffReadable: true,
    request: { phase: 'timeout', atMs: 1900000, reason },
  }));
  assert.equal(m.visible, true);
  assert.equal(m.primary.kind, 'continue');
  assert.equal(m.update.visible, false);
  assert.equal(m.note, reason);
});

test('buttonModel: every visible result has the documented shape', () => {
  const variants = [
    buttonArgs(),
    buttonArgs({ busy: true }),
    buttonArgs({ state: null }),
    buttonArgs({ state: writtenState(), handoffReadable: true }),
    buttonArgs({ state: writtenState(), handoffReadable: true, continueLocked: true }),
    buttonArgs({ running: false, state: writtenState(), handoffReadable: true }),
    buttonArgs({ request: { phase: 'requested', atMs: 1990000 } }),
    buttonArgs({ request: { phase: 'timeout', atMs: 1900000, reason: 'why' } }),
  ];
  for (const args of variants) {
    const m = buttonModel(args);
    assert.equal(m.visible, true);
    assert.equal(typeof m.primary, 'object');
    assert.equal(typeof m.primary.kind, 'string');
    assert.equal(typeof m.primary.label, 'string');
    assert.equal(typeof m.primary.enabled, 'boolean');
    assert.equal(typeof m.primary.override, 'boolean');
    assert.equal(typeof m.primary.title, 'string');
    assert.equal(typeof m.update, 'object');
    assert.equal(typeof m.update.visible, 'boolean');
    assert.equal(typeof m.update.enabled, 'boolean');
    assert.equal(typeof m.update.override, 'boolean');
    assert.ok(['writing', 'continue', 'handoff'].includes(m.primary.kind), m.primary.kind);
    // An override is a kind of enabled, never a kind of disabled.
    if (m.primary.override) assert.equal(m.primary.enabled, true);
    if (m.update.override) assert.equal(m.update.enabled, true);
  }
});

test('buttonModel: no input at all is an invisible, disabled model', () => {
  for (const input of [undefined, null, {}]) {
    const m = buttonModel(input);
    assert.equal(m.visible, false);
    assert.equal(m.primary.enabled, false);
    assert.equal(m.primary.override, false);
    assert.equal(m.update.visible, false);
    assert.equal(m.update.override, false);
  }
});

// ── continuePrompt ──────────────────────────────────────────────────────────

test('continuePrompt: backslashes become forward slashes', () => {
  assert.equal(
    continuePrompt(HANDOFF_PATH),
    'Read C:/Users/jhack/AppData/Local/claude-ctx/handoffs/abc.md in full before doing anything else, then continue'
  );
});

test('continuePrompt: a forward-slash path is left alone', () => {
  assert.equal(
    continuePrompt('C:/Users/jhack/AppData/Local/claude-ctx/handoffs/abc.md'),
    'Read C:/Users/jhack/AppData/Local/claude-ctx/handoffs/abc.md in full before doing anything else, then continue'
  );
});

test('continuePrompt: mixed slashes and spaces, every backslash converted', () => {
  const out = continuePrompt('C:\\Users\\Some One/AppData\\Local/claude-ctx\\h.md');
  assert.equal(out, 'Read C:/Users/Some One/AppData/Local/claude-ctx/h.md in full before doing anything else, then continue');
  assert.ok(!out.includes('\\'));
});

// ── launchFolder ────────────────────────────────────────────────────────────

test('launchFolder: the session\'s own folder comes first', () => {
  assert.equal(launchFolder({ projectPath: 'C:\\proj' }, sidecar()), 'C:\\proj');
  assert.equal(launchFolder({ projectPath: 'C:\\proj' }, null), 'C:\\proj');
});

test('launchFolder: falls back to the sidecar\'s cwd when the session has no projectPath', () => {
  const cwd = 'C:\\Users\\jhack\\Bitbucket\\switchboard';
  for (const session of [null, undefined, {}, { projectPath: '' }, { projectPath: null }, { projectPath: 42 }]) {
    assert.equal(launchFolder(session, sidecar()), cwd, JSON.stringify(session));
  }
});

test('launchFolder: null when neither has a usable folder', () => {
  for (const sc of [null, undefined, {}, sidecar({ cwd: null }), sidecar({ cwd: '' }), sidecar({ cwd: 42 })]) {
    assert.equal(launchFolder(null, sc), null, JSON.stringify(sc));
    assert.equal(launchFolder({ projectPath: '' }, sc), null, JSON.stringify(sc));
  }
});

// ── requestOutcome ──────────────────────────────────────────────────────────

// Whole seconds so that seconds * 1000 is exact in floating point.
const AT_S = 1759500000;
const AT_MS = AT_S * 1000;
const REQ = { phase: 'requested', atMs: AT_MS };

function outcome(state, afterMs, running) {
  return requestOutcome({ request: REQ, state, nowMs: AT_MS + afterMs, running });
}

// The hook saw the marker one second after the click: begin_manual has run.
function ackState(over = {}) {
  return hookState({
    manual: true,
    pending: true,
    crossed_at: AT_S + 1,
    crossed_tokens: 412345,
    handoff_path: HANDOFF_PATH,
    last_prompt_at: AT_S + 1,
    last_stop_at: AT_S - 200,
    ...over,
  });
}

// ...and the handoff for that request has been recorded: refresh_written.
function doneState(over = {}) {
  return ackState({
    manual: false,
    pending: false,
    written_at: AT_S + 40,
    written_tokens: 415000,
    last_stop_at: AT_S + 45,
    ...over,
  });
}

test('requestOutcome: waiting right after the request', () => {
  assert.equal(outcome(null, 0), 'waiting');
  assert.equal(outcome(undefined, 2000), 'waiting');
  assert.equal(outcome(hookState(), 2000), 'waiting');
  assert.equal(outcome(oldHookState(), 2000), 'waiting');
  assert.equal(outcome({}, 2000), 'waiting');
  assert.equal(outcome(ackState(), 2000), 'waiting');
});

test('requestOutcome: waiting without a usable request', () => {
  for (const request of [null, undefined, {}, { phase: 'requested' }, { phase: 'requested', atMs: '5' }]) {
    assert.equal(requestOutcome({ request, state: doneState(), nowMs: AT_MS + 700000, running: false }), 'waiting');
  }
});

test('requestOutcome: written once the hook has recorded a handoff for this request', () => {
  assert.equal(outcome(doneState(), 46000), 'written');
  assert.equal(outcome(doneState(), 46000, true), 'written');
});

test('requestOutcome: written needs written_at later than crossed_at', () => {
  assert.equal(outcome(doneState({ written_at: AT_S + 1.001 }), 5000), 'written', 'a hair later');
  assert.equal(outcome(doneState({ written_at: AT_S + 1 }), 5000), 'waiting', 'equal is not later');
  assert.equal(outcome(doneState({ written_at: AT_S + 0.5 }), 5000), 'waiting', 'before the crossing');
  assert.equal(outcome(doneState({ written_at: null }), 5000), 'waiting', 'no written_at');
  assert.equal(outcome(doneState({ written_at: String(AT_S + 40) }), 5000), 'waiting', 'written_at is a string');
});

test('requestOutcome: an older handoff is never this request\'s result (the Update case)', () => {
  // Written an hour ago; the hook has acknowledged the new request.
  const acked = ackState({ written_at: AT_S - 3600, written_tokens: 300000 });
  assert.equal(outcome(acked, 5000), 'waiting');
  assert.equal(outcome(acked, 300000), 'waiting');
  // Written an hour ago and the hook never saw the request at all.
  const unseen = writtenState({ written_at: AT_S - 3600, crossed_at: AT_S - 3700 });
  assert.equal(outcome(unseen, 5000), 'waiting');
  assert.equal(outcome(unseen, 20001), 'not_landed');
});

test('requestOutcome: a handoff written after the click for an OLDER crossing is not this request\'s', () => {
  // The automatic crossing from five minutes ago got its handoff just now;
  // crossed_at was not re-stamped, so the hook never saw this request.
  const s = writtenState({ crossed_at: AT_S - 300, written_at: AT_S + 10, last_prompt_at: AT_S - 300 });
  assert.equal(outcome(s, 15000), 'waiting');
  assert.equal(outcome(s, 20001), 'not_landed');
});

test('requestOutcome: crossed_at boundary is one second before the request', () => {
  const done = (crossed_at) => doneState({ crossed_at });
  assert.equal(outcome(done(AT_S), 2000), 'written', 'same second');
  assert.equal(outcome(done(AT_S - 0.5), 2000), 'written', '500 ms before');
  assert.equal(outcome(done(AT_S - 1), 2000), 'written', 'exactly 1000 ms before');
  assert.equal(outcome(done(AT_S - 1.5), 2000), 'waiting', '1500 ms before');
  assert.equal(outcome(done(AT_S - 2), 2000), 'waiting', '2000 ms before');

  const ack = (crossed_at) => ackState({ crossed_at });
  assert.equal(outcome(ack(AT_S), 30000), 'waiting', 'ack, same second');
  assert.equal(outcome(ack(AT_S - 1), 30000), 'waiting', 'ack, exactly 1000 ms before');
  assert.equal(outcome(ack(AT_S - 1.5), 30000), 'not_landed', 'ack, 1500 ms before');
  assert.equal(outcome(ack(AT_S - 2), 30000), 'not_landed', 'ack, 2000 ms before');
});

test('requestOutcome: pending or manual still set blocks "written"', () => {
  assert.equal(outcome(doneState({ pending: true }), 46000), 'not_landed', 'pending, no longer manual');
  assert.equal(outcome(doneState({ manual: true }), 46000), 'not_landed', 'manual, no longer pending');
  assert.equal(outcome(doneState({ pending: true, manual: true }), 46000), 'waiting', 'still acknowledged');
  assert.equal(outcome(doneState({ pending: true, manual: true }), 15000), 'waiting');
});

test('requestOutcome: pending must be exactly false; a missing manual key counts as its default', () => {
  const noPending = doneState();
  delete noPending.pending;
  assert.equal(outcome(noPending, 5000), 'waiting');
  assert.equal(outcome(doneState({ pending: null }), 5000), 'waiting');
  assert.equal(outcome(doneState({ pending: 0 }), 5000), 'waiting');

  const noManual = doneState();
  delete noManual.manual;
  assert.equal(outcome(noManual, 5000), 'written');
  assert.equal(outcome(doneState({ manual: null }), 5000), 'waiting');
  assert.equal(outcome(doneState({ manual: 0 }), 5000), 'waiting');
});

test('requestOutcome: a crossed_at that is not a number is never trusted', () => {
  for (const crossed_at of [null, undefined, String(AT_S + 1), NaN, Infinity, true]) {
    assert.equal(outcome(doneState({ crossed_at }), 5000), 'waiting', `done, crossed_at ${String(crossed_at)}`);
    assert.equal(outcome(ackState({ crossed_at }), 20001), 'not_landed', `ack, crossed_at ${String(crossed_at)}`);
  }
});

test('requestOutcome: written does not depend on handoff_path, tokens or the turn keys', () => {
  const s = doneState({ handoff_path: null, written_tokens: null });
  delete s.last_prompt_at;
  delete s.last_stop_at;
  assert.equal(outcome(s, 31000), 'written');
});

test('requestOutcome: written wins over both timeouts and over a session that has ended', () => {
  assert.equal(outcome(doneState(), 25000), 'written');
  assert.equal(outcome(doneState(), 700000), 'written');
  assert.equal(outcome(doneState(), 5000, false), 'written');
  assert.equal(outcome(doneState(), 700000, false), 'written');
});

test('requestOutcome: session_ended as soon as the session is known not to be running', () => {
  assert.equal(outcome(null, 0, false), 'session_ended');
  assert.equal(outcome(hookState(), 2000, false), 'session_ended');
  assert.equal(outcome(ackState(), 2000, false), 'session_ended', 'even when acknowledged');
  assert.equal(outcome(ackState(), 30000, false), 'session_ended');
  assert.equal(outcome(hookState(), 20001, false), 'session_ended', 'rather than not_landed');
  assert.equal(outcome(ackState(), 600001, false), 'session_ended', 'rather than not_written');
});

test('requestOutcome: only running === false ends it; true and unknown do not', () => {
  for (const running of [true, undefined, null, 0, 'false']) {
    assert.equal(outcome(ackState(), 30000, running), 'waiting', `running ${String(running)}`);
  }
});

test('requestOutcome: not_landed after 20 s without an acknowledgement', () => {
  const stale = hookState({ last_prompt_at: AT_S - 300, last_stop_at: AT_S - 200 });
  assert.equal(outcome(stale, 19999), 'waiting');
  assert.equal(outcome(stale, 20000), 'waiting', 'exactly 20 s is not yet over');
  assert.equal(outcome(stale, 20001), 'not_landed');
  assert.equal(outcome(stale, 60000), 'not_landed');
});

test('requestOutcome: not_landed with missing state or missing keys', () => {
  assert.equal(outcome(null, 20001), 'not_landed');
  assert.equal(outcome(undefined, 20001), 'not_landed');
  assert.equal(outcome({}, 20001), 'not_landed');
  assert.equal(outcome(oldHookState(), 20001), 'not_landed');
  assert.equal(outcome(hookState({ last_prompt_at: null, last_stop_at: null }), 20001), 'not_landed');
});

test('requestOutcome: a prompt seen since the request is not an acknowledgement on its own', () => {
  // The hook recorded a prompt (the turn marker) but did not take it as a
  // request: crossed_at was not stamped, so nothing is going to be written.
  const promptOnly = hookState({ last_prompt_at: AT_S + 1, last_stop_at: AT_S - 200 });
  assert.equal(outcome(promptOnly, 20001), 'not_landed');
});

test('requestOutcome: acknowledged needs manual and pending both true', () => {
  assert.equal(outcome(ackState(), 20001), 'waiting');
  assert.equal(outcome(ackState(), 300000), 'waiting');
  // An automatic crossing at the same moment is not the hook taking the request.
  assert.equal(outcome(ackState({ manual: false }), 20001), 'not_landed');
  assert.equal(outcome(ackState({ pending: false }), 20001), 'not_landed');
  assert.equal(outcome(ackState({ manual: 1 }), 20001), 'not_landed');
  assert.equal(outcome(ackState({ pending: 'true' }), 20001), 'not_landed');
  const noManual = ackState();
  delete noManual.manual;
  assert.equal(outcome(noManual, 20001), 'not_landed');
});

test('requestOutcome: not_written after 10 minutes when the request was acknowledged', () => {
  assert.equal(outcome(ackState(), 599999), 'waiting');
  assert.equal(outcome(ackState(), 600000), 'waiting', 'exactly 10 minutes is not yet over');
  assert.equal(outcome(ackState(), 600001), 'not_written');
  assert.equal(outcome(ackState(), 3600000), 'not_written');
});

test('requestOutcome: a request that never landed stays not_landed past 10 minutes', () => {
  assert.equal(outcome(null, 600001), 'not_landed');
  assert.equal(outcome(hookState({ last_prompt_at: AT_S - 300 }), 900000), 'not_landed');
});

test('requestOutcome: only ever returns one of the five outcomes', () => {
  const allowed = ['waiting', 'written', 'session_ended', 'not_landed', 'not_written'];
  const states = [
    null, undefined, {}, hookState(), oldHookState(), writtenState(),
    writtenState({ written_at: AT_S + 5 }), hookState({ pending: true }),
    hookState({ last_prompt_at: AT_S + 1 }), ackState(), doneState(),
  ];
  for (const s of states) {
    for (const running of [true, false, undefined]) {
      for (const after of [0, 1000, 20000, 20001, 600000, 600001]) {
        const got = outcome(s, after, running);
        assert.ok(allowed.includes(got), `${String(got)} after ${after} ms`);
      }
    }
  }
});
