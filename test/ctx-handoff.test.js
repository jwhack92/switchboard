const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// First written blind from the "PURE API" section of the ctx-handoff SPEC,
// without reading public/ctx-handoff.js; since brought in line with the hook's
// reader contract (ctx_handoff.py, "Reader contract") and the confirmed
// override. The first part pins the pure helpers behind the context meter, the
// sidebar token chip and the Hand off button, and touches no DOM: the module
// has to load under plain Node. The last part ("browser half") runs the same
// file in a vm context with a fake DOM to pin the click path.

const MODULE_PATH = '../public/ctx-handoff';

const {
  REQUEST_LINE,
  WARN_AT,
  DUE_AT,
  OVERRIDE_CONFIRM,
  OVERRIDE_TITLE,
  OVERRIDE_TITLE_UNSEEN,
  HANDOFF_NOT_LANDED,
  HANDOFF_NOT_WRITTEN,
  HANDOFF_SESSION_ENDED,
  REQUEST_EXPIRY_MS,
  POLL_EVERY_TICKS,
  fmtTokens,
  chipLevel,
  deriveCtxDir,
  meterModel,
  meterWidth,
  turnEnded,
  handoffInfo,
  canContinue,
  chipState,
  buttonModel,
  continuePrompt,
  requestOutcome,
  nextRequest,
  parseStoredRequest,
  pollDue,
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
    // This window has been told whether the session is busy (an event since
    // it loaded, or main's own flag). Without it every click asks first.
    busyKnown: true,
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
  for (const name of [
    'REQUEST_LINE', 'OVERRIDE_CONFIRM', 'OVERRIDE_TITLE', 'OVERRIDE_TITLE_UNSEEN', 'HANDOFF_NOT_LANDED', 'HANDOFF_NOT_WRITTEN', 'HANDOFF_SESSION_ENDED',
  ]) {
    assert.equal(typeof mod[name], 'string', name);
  }
  for (const name of ['WARN_AT', 'DUE_AT', 'REQUEST_EXPIRY_MS', 'POLL_EVERY_TICKS']) {
    assert.equal(typeof mod[name], 'number', name);
  }
  for (const name of [
    'fmtTokens', 'chipLevel', 'deriveCtxDir', 'meterModel', 'meterWidth', 'turnEnded',
    'handoffInfo', 'canContinue', 'chipState', 'buttonModel', 'continuePrompt', 'requestOutcome',
    'nextRequest', 'parseStoredRequest', 'pollDue', 'launchFolder',
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
    'Switchboard cannot confirm that this session is idle at its prompt. If a permission prompt or a question is open in the terminal, '
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

test('chipState: a due handoff is the token count alone, in the due colour; the tooltip says "due"', () => {
  const chip = chipState(chipArgs({ state: hookState({ pending: true }) }));
  assert.equal(chip.level, 'due');
  assert.equal(chip.text, '412K');
  assert.ok(/handoff due/.test(chip.title), chip.title);
  assertOneLineTitle(chip);
});

test('chipState: the word "due" never appears in the chip text, whatever the state', () => {
  const states = [
    null, hookState(), oldHookState(), hookState({ pending: true }),
    hookState({ pending: true, manual: true }), writtenState(), writtenState({ pending: true }),
  ];
  for (const tokens of [120000, 300000, 412345, 1500000]) {
    for (const state of states) {
      for (const handoffReadable of [true, false]) {
        const chip = chipState(chipArgs({ sidecar: sidecar({ total_input_tokens: tokens }), state, handoffReadable }));
        assert.ok(!/due/i.test(chip.text), chip.text);
        // Tokens only, plus the tick for a written handoff.
        const want = fmtTokens(tokens) + (chip.level === 'written' ? ` ${TICK}` : '');
        assert.equal(chip.text, want, `tokens ${tokens}`);
      }
    }
  }
});

test('chipState: due overrides the token level even below the warn threshold', () => {
  const chip = chipState(chipArgs({
    sidecar: sidecar({ total_input_tokens: 120000 }),
    state: hookState({ pending: true }),
  }));
  assert.equal(chip.level, 'due');
  assert.equal(chip.text, '120K');
});

test('chipState: due wins over an older written handoff', () => {
  const chip = chipState(chipArgs({ state: writtenState({ pending: true }), handoffReadable: true }));
  assert.equal(chip.level, 'due');
  assert.equal(chip.text, '412K');
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

test('buttonModel: rule 3, Continue from an ultracode session says so in the label and the title', () => {
  const written = { state: writtenState(), handoffReadable: true };
  const plain = buttonModel(buttonArgs(written)).primary;
  const ultra = buttonModel(buttonArgs({ ...written, ultracode: true })).primary;
  assert.equal(ultra.kind, 'continue');
  assert.equal(ultra.label, 'Continue in new session (ultracode)');
  assert.equal(ultra.title, plain.title + '. It starts in ultracode, like this one');
  assert.equal(ultra.enabled, true);
  assert.equal(ultra.override, false);

  // Only the boolean true. The flag is an input of its own: a state that
  // carries the key does not turn it on by itself.
  for (const ultracode of [false, null, undefined, 'yes', 1]) {
    assert.deepEqual(
      buttonModel(buttonArgs({ ...written, ultracode })).primary, plain, `ultracode ${String(ultracode)}`
    );
  }
  assert.deepEqual(
    buttonModel(buttonArgs({ state: writtenState({ ultracode: true }), handoffReadable: true })).primary, plain
  );
  assert.equal(plain.label, 'Continue in new session');
  assert.equal(plain.title, 'Start a new session in the same folder that reads the handoff first');

  // A stopped session whose newer handoff was never written: the same sentence
  // on the longer title.
  const due = { running: false, state: writtenState({ pending: true }), handoffReadable: true };
  assert.equal(
    buttonModel(buttonArgs({ ...due, ultracode: true })).primary.title,
    buttonModel(buttonArgs(due)).primary.title + '. It starts in ultracode, like this one'
  );

  // While the launch is out the label stays and the title is the lock's.
  const locked = buttonModel(buttonArgs({ ...written, ultracode: true, continueLocked: true })).primary;
  assert.equal(locked.label, 'Continue in new session (ultracode)');
  assert.equal(locked.title, buttonModel(buttonArgs({ ...written, continueLocked: true })).primary.title);
});

test('buttonModel: ultracode changes nothing but Continue', () => {
  for (const over of [{}, { busy: true }, { state: null }, { request: { phase: 'requested', atMs: 1990000 } }]) {
    assert.deepEqual(
      buttonModel(buttonArgs({ ...over, ultracode: true })), buttonModel(buttonArgs(over)), JSON.stringify(over)
    );
  }
  const written = { state: writtenState(), handoffReadable: true };
  assert.deepEqual(
    buttonModel(buttonArgs({ ...written, ultracode: true })).update, buttonModel(buttonArgs(written)).update
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
  // 1 and 'true' are truthy and still do not block: the caller hands over a
  // real boolean, and anything else is not "busy".
  for (const busy of [false, undefined, null, 0, 1, 'true', {}]) {
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

// What the hook really leaves behind when a session exits with a request (or
// an automatic crossing) outstanding: pending stays true, because only an
// event clears it and a session that has exited sends none.
test('buttonModel: a stopped session keeps Continue for an older readable handoff although a newer one is due', () => {
  const plainTitle = buttonModel(buttonArgs({ running: false, state: writtenState(), handoffReadable: true })).primary.title;
  for (const manual of [true, false]) {
    const m = buttonModel(buttonArgs({
      running: false,
      state: writtenState({ pending: true, manual, crossed_at: 1900, crossed_tokens: 455000 }),
      handoffReadable: true,
      request: { phase: 'timeout', atMs: 1899000, reason: HANDOFF_SESSION_ENDED },
    }));
    assert.equal(m.visible, true, `manual ${manual}`);
    assert.equal(m.primary.kind, 'continue', `manual ${manual}`);
    assert.equal(m.primary.label, 'Continue in new session', `manual ${manual}`);
    assert.equal(m.primary.enabled, true, `manual ${manual}`);
    assert.equal(m.primary.override, false, `manual ${manual}`);
    assert.equal(m.update.visible, false, `manual ${manual}`);
    assert.equal(m.note, HANDOFF_SESSION_ENDED, `manual ${manual}`);
    assert.notEqual(m.primary.title, plainTitle, 'the tooltip says the handoff is not the newest one asked for');
  }
});

test('buttonModel: a RUNNING session with a newer handoff due is still Hand off, not Continue', () => {
  const m = buttonModel(buttonArgs({
    running: true, state: writtenState({ pending: true, manual: true, crossed_at: 1900 }), handoffReadable: true,
  }));
  assert.equal(m.primary.kind, 'handoff');
  assert.equal(m.update.visible, false);
});

test('buttonModel: a stopped session with a handoff due and nothing readable shows no button, but keeps its note', () => {
  for (const [name, over] of [
    ['never written', { state: hookState({ pending: true, manual: true }) }],
    ['written, file not readable', { state: writtenState({ pending: true }), handoffReadable: false }],
    ['path only, no written_at', { state: writtenState({ pending: true, written_at: null }), handoffReadable: true }],
    ['written_at only, no path', { state: writtenState({ pending: true, handoff_path: null }), handoffReadable: true }],
  ]) {
    const m = buttonModel(buttonArgs({
      running: false, ...over, request: { phase: 'timeout', atMs: 1899000, reason: HANDOFF_SESSION_ENDED },
    }));
    assert.equal(m.visible, false, name);
    assert.equal(m.primary.enabled, false, name);
    assert.equal(m.note, HANDOFF_SESSION_ENDED, name);
  }
});

// After a reload this window's busy map is empty: main only sends an event when
// a session changes between busy and idle. Jason: "Ask first until step 4".
test('buttonModel: busyKnown, a control that would be plainly enabled asks first until the window has been told', () => {
  for (const busyKnown of [false, undefined, null, 0, 1, 'true', {}]) {
    const m = buttonModel(buttonArgs({ busyKnown }));
    assert.equal(m.visible, true, `busyKnown ${String(busyKnown)}`);
    assert.equal(m.primary.kind, 'handoff', `busyKnown ${String(busyKnown)}`);
    assert.equal(m.primary.enabled, true, `busyKnown ${String(busyKnown)}`);
    assert.equal(m.primary.override, true, `busyKnown ${String(busyKnown)}`);
    assert.equal(m.primary.title, OVERRIDE_TITLE_UNSEEN, `busyKnown ${String(busyKnown)}`);
  }
  const missing = buttonArgs();
  delete missing.busyKnown;
  assert.equal(buttonModel(missing).primary.override, true, 'a caller that does not pass it at all');

  const told = buttonModel(buttonArgs({ busyKnown: true }));
  assert.equal(told.primary.enabled, true);
  assert.equal(told.primary.override, false);
  assert.notEqual(told.primary.title, OVERRIDE_TITLE_UNSEEN);
  assert.notEqual(told.primary.title, OVERRIDE_TITLE);
});

test('buttonModel: busyKnown also gates Update, and never Continue or "Writing…"', () => {
  const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, busyKnown: false }));
  assert.equal(m.primary.kind, 'continue');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.override, false, 'Continue types nothing, so it never asks');
  assert.equal(m.update.visible, true);
  assert.equal(m.update.enabled, true);
  assert.equal(m.update.override, true);
  assert.equal(m.update.title, OVERRIDE_TITLE_UNSEEN);

  const stopped = buttonModel(buttonArgs({ running: false, state: writtenState(), handoffReadable: true, busyKnown: false }));
  assert.equal(stopped.primary.kind, 'continue');
  assert.equal(stopped.primary.enabled, true);
  assert.equal(stopped.update.visible, false);
  assert.equal(stopped.update.override, false);

  const writing = buttonModel(buttonArgs({ busyKnown: false, request: { phase: 'requested', atMs: 1990000 } }));
  assert.equal(writing.primary.kind, 'writing');
  assert.equal(writing.primary.enabled, false);
  assert.equal(writing.primary.override, false);
});

test('buttonModel: busyKnown never turns a disabled control into an override', () => {
  const cases = [
    ['owned elsewhere', { ownedElsewhere: true }, WHY_OWNED],
    ['pending row', { pendingRow: true }, WHY_PENDING],
    ['busy', { busy: true }, WHY_BUSY],
  ];
  for (const [name, over, why] of cases) {
    const m = buttonModel(buttonArgs({ ...over, busyKnown: false }));
    assert.equal(m.primary.enabled, false, name);
    assert.equal(m.primary.override, false, name);
    assert.equal(m.primary.title, why, name);
    const u = buttonModel(buttonArgs({ ...over, busyKnown: false, state: writtenState(), handoffReadable: true })).update;
    assert.equal(u.enabled, false, name);
    assert.equal(u.override, false, name);
    assert.equal(u.title, why, name);
  }
  assert.equal(buttonModel(buttonArgs({ running: false, busyKnown: false })).visible, false);
  assert.equal(buttonModel(buttonArgs({ isTerminal: true, busyKnown: false })).visible, false);
});

test('buttonModel: busyKnown, a turn that has not ended is the reason named when both apply', () => {
  for (const [name, over] of NOT_ENDED) {
    for (const busyKnown of [true, false]) {
      const m = buttonModel(buttonArgs({ ...over, busyKnown }));
      assert.equal(m.primary.enabled, true, `${name} / ${busyKnown}`);
      assert.equal(m.primary.override, true, `${name} / ${busyKnown}`);
      assert.equal(m.primary.title, OVERRIDE_TITLE, `${name} / ${busyKnown}`);
    }
  }
  assert.notEqual(OVERRIDE_TITLE, OVERRIDE_TITLE_UNSEEN);
  for (const title of [OVERRIDE_TITLE, OVERRIDE_TITLE_UNSEEN]) {
    assert.ok(/asks first/.test(title), title);
    assert.ok(!/[\r\n]/.test(title), title);
  }
});

test('canContinue: table', () => {
  const cases = [
    ['no state', null, true, true, false],
    ['nothing written', hookState(), true, true, false],
    ['written, readable, running', writtenState(), true, true, true],
    ['written, readable, stopped', writtenState(), true, false, true],
    ['written, not readable', writtenState(), false, false, false],
    ['due over an older handoff, running', writtenState({ pending: true }), true, true, false],
    ['due over an older handoff, stopped', writtenState({ pending: true }), true, false, true],
    ['due over an older handoff, stopped, not readable', writtenState({ pending: true }), false, false, false],
    ['due, never written, stopped', hookState({ pending: true }), true, false, false],
    ['due, path without written_at, stopped', writtenState({ pending: true, written_at: null }), true, false, false],
  ];
  for (const [name, state, readable, running, want] of cases) {
    assert.equal(canContinue(state, readable, running), want, name);
  }
});

test('buttonModel: a failed Continue is the note, beside the button, and wins over an older timeout note', () => {
  const failed = 'The new session could not be started.';
  const m = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, continueError: failed }));
  assert.equal(m.primary.kind, 'continue');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.note, failed);

  const both = buttonModel(buttonArgs({
    state: writtenState(), handoffReadable: true, continueError: failed,
    request: { phase: 'timeout', atMs: 1300000, reason: HANDOFF_NOT_WRITTEN },
  }));
  assert.equal(both.note, failed);

  for (const continueError of ['', null, undefined, 42, {}]) {
    const none = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, continueError }));
    assert.ok(!none.note, `continueError ${String(continueError)}`);
  }
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

// ── the notes ───────────────────────────────────────────────────────────────

test('the 20 s note does not claim the request was lost: it may be queued behind a turn', () => {
  assert.ok(!/did not reach/i.test(HANDOFF_NOT_LANDED), HANDOFF_NOT_LANDED);
  assert.ok(/queued/i.test(HANDOFF_NOT_LANDED), HANDOFF_NOT_LANDED);
  assert.ok(/press Enter/i.test(HANDOFF_NOT_LANDED), HANDOFF_NOT_LANDED);
  for (const note of [HANDOFF_NOT_LANDED, HANDOFF_NOT_WRITTEN, HANDOFF_SESSION_ENDED]) {
    assert.ok(note.length > 0 && !/[\r\n]/.test(note), note);
  }
  assert.equal(new Set([HANDOFF_NOT_LANDED, HANDOFF_NOT_WRITTEN, HANDOFF_SESSION_ENDED]).size, 3);
});

// ── nextRequest ─────────────────────────────────────────────────────────────

function step(request, state, afterMs, running) {
  return nextRequest({ request, state, nowMs: AT_MS + afterMs, running });
}

const TIMEOUT = (reason) => ({ phase: 'timeout', atMs: AT_MS, reason });
const IDLE_KEPT = { phase: 'idle', atMs: AT_MS, reason: '' };

test('nextRequest: anything that is not an outstanding request comes back untouched', () => {
  for (const request of [
    null, undefined, { phase: 'idle', atMs: 0, reason: '' }, { phase: 'idle', atMs: AT_MS, reason: '' },
    { phase: 'requested' }, { phase: 'timeout', reason: 'x' }, { phase: 'other', atMs: AT_MS },
  ]) {
    assert.equal(step(request, doneState(), 4000000, false), request, JSON.stringify(request));
  }
});

test('nextRequest: a request still waiting is the same object', () => {
  assert.equal(step(REQ, null, 0), REQ);
  assert.equal(step(REQ, hookState(), 19999), REQ);
  assert.equal(step(REQ, ackState(), 300000), REQ);
  assert.equal(step(REQ, ackState(), 300000, true), REQ);
});

test('nextRequest: written goes back to idle and KEEPS the time of the typed line', () => {
  for (const request of [REQ, TIMEOUT(HANDOFF_NOT_LANDED), TIMEOUT(HANDOFF_NOT_WRITTEN), TIMEOUT(HANDOFF_SESSION_ENDED)]) {
    assert.deepEqual(step(request, doneState(), 46000, true), IDLE_KEPT, JSON.stringify(request));
    assert.deepEqual(step(request, doneState(), 46000, false), IDLE_KEPT, JSON.stringify(request));
  }
  // ...which is what makes buttonModel want a Stop later than that line.
  const next = step(REQ, doneState(), 46000, true);
  const stopBefore = buttonModel(buttonArgs({
    state: doneState({ last_prompt_at: AT_S - 300, last_stop_at: AT_S - 200 }), request: next,
  }));
  assert.equal(stopBefore.primary.override, true, 'no Stop since the typed line: asks first');
  const stopAfter = buttonModel(buttonArgs({ state: doneState(), request: next }));
  assert.equal(stopAfter.primary.enabled, true);
  assert.equal(stopAfter.primary.override, false, 'a Stop 45 s after the typed line');
});

test('nextRequest: a requested request times out with the note for its outcome', () => {
  assert.deepEqual(step(REQ, hookState(), 20001), TIMEOUT(HANDOFF_NOT_LANDED));
  assert.deepEqual(step(REQ, null, 20001), TIMEOUT(HANDOFF_NOT_LANDED));
  assert.deepEqual(step(REQ, ackState(), 600001), TIMEOUT(HANDOFF_NOT_WRITTEN));
  assert.deepEqual(step(REQ, ackState(), 2000, false), TIMEOUT(HANDOFF_SESSION_ENDED));
  assert.deepEqual(step(REQ, null, 0, false), TIMEOUT(HANDOFF_SESSION_ENDED));
});

test('nextRequest: acknowledged late, inside 10 minutes, is "Writing…" again with the same click time', () => {
  const landed = TIMEOUT(HANDOFF_NOT_LANDED);
  assert.deepEqual(step(landed, ackState(), 22000), { phase: 'requested', atMs: AT_MS, reason: '' });
  assert.deepEqual(step(landed, ackState({ crossed_at: AT_S + 300 }), 301000), { phase: 'requested', atMs: AT_MS, reason: '' });
  // Not acknowledged: nothing changes.
  assert.equal(step(landed, hookState(), 22000), landed);
  assert.equal(step(landed, null, 500000), landed);
});

test('nextRequest: acknowledged later than 10 minutes changes the note to "not written"', () => {
  const landed = TIMEOUT(HANDOFF_NOT_LANDED);
  assert.deepEqual(step(landed, ackState({ crossed_at: AT_S + 650 }), 660000), TIMEOUT(HANDOFF_NOT_WRITTEN));
  // Never acknowledged: still "not picked up".
  assert.equal(step(landed, hookState(), 660000), landed);
  // Only the "not picked up" note is swapped.
  const notWritten = TIMEOUT(HANDOFF_NOT_WRITTEN);
  assert.equal(step(notWritten, ackState(), 660000), notWritten);
  assert.equal(step(notWritten, ackState(), 300000), notWritten);
});

test('nextRequest: the "session ended" note goes when the session is seen running again', () => {
  const ended = TIMEOUT(HANDOFF_SESSION_ENDED);
  assert.deepEqual(step(ended, ackState(), 60000, true), IDLE_KEPT);
  assert.deepEqual(step(ended, null, 60000, true), IDLE_KEPT);
  assert.equal(step(ended, ackState(), 60000, false), ended, 'still stopped');
  assert.equal(step(ended, ackState(), 60000, undefined), ended, 'not known');
  // The other notes are about the request, not the process: running says nothing.
  for (const reason of [HANDOFF_NOT_LANDED, HANDOFF_NOT_WRITTEN]) {
    const other = TIMEOUT(reason);
    assert.equal(step(other, hookState(), 700000, true), other, reason);
  }
});

test('nextRequest: a request the hook dropped (crossed for this request, pending false, nothing written) clears the note', () => {
  const expired = ackState({ manual: false, manual_blocked: false, pending: false });
  for (const reason of [HANDOFF_NOT_LANDED, HANDOFF_NOT_WRITTEN, HANDOFF_SESSION_ENDED]) {
    assert.deepEqual(step(TIMEOUT(reason), expired, 1500000, true), IDLE_KEPT, reason);
  }
  // An older handoff on file does not make it "written", and does not stop it clearing.
  const older = ackState({ manual: false, pending: false, written_at: AT_S - 3600 });
  assert.deepEqual(step(TIMEOUT(HANDOFF_NOT_WRITTEN), older, 1500000, true), IDLE_KEPT);
  // crossed_at from before the request says nothing about this request.
  const earlier = hookState({ pending: false, crossed_at: AT_S - 300 });
  const note = TIMEOUT(HANDOFF_NOT_LANDED);
  assert.equal(step(note, earlier, 1500000, true), note);
});

test('nextRequest: 30 minutes after the click every outstanding request is over', () => {
  assert.equal(REQUEST_EXPIRY_MS, 1800000);
  const notWritten = TIMEOUT(HANDOFF_NOT_WRITTEN);
  assert.equal(step(notWritten, ackState(), REQUEST_EXPIRY_MS), notWritten, 'exactly 30 minutes is not yet over');
  for (const request of [REQ, TIMEOUT(HANDOFF_NOT_LANDED), notWritten, TIMEOUT(HANDOFF_SESSION_ENDED)]) {
    for (const state of [null, hookState(), ackState()]) {
      for (const running of [true, false, undefined]) {
        assert.deepEqual(step(request, state, REQUEST_EXPIRY_MS + 1, running), IDLE_KEPT, JSON.stringify(request));
      }
    }
  }
});

test('nextRequest: only ever returns idle, requested or timeout, with the click time unchanged', () => {
  const states = [null, hookState(), ackState(), doneState(), ackState({ manual: false, pending: false })];
  const requests = [REQ, TIMEOUT(HANDOFF_NOT_LANDED), TIMEOUT(HANDOFF_NOT_WRITTEN), TIMEOUT(HANDOFF_SESSION_ENDED)];
  for (const request of requests) {
    for (const state of states) {
      for (const running of [true, false, undefined]) {
        for (const after of [0, 20001, 600001, 1800001]) {
          const got = step(request, state, after, running);
          assert.ok(['idle', 'requested', 'timeout'].includes(got.phase), got.phase);
          assert.equal(got.atMs, AT_MS);
          if (got.phase === 'timeout') assert.ok(got.reason.length > 0);
        }
      }
    }
  }
});

// ── meterWidth ──────────────────────────────────────────────────────────────

test('meterWidth: one decimal at most, written the way the browser hands it back', () => {
  const cases = [
    [41, '41%'],
    [41.2, '41.2%'],
    [41.25, '41.3%'],
    [33.3333, '33.3%'],
    [0, '0%'],
    [0.04, '0%'],
    [100, '100%'],
    [99.96, '100%'],
    [150, '100%'],
    [-5, '0%'],
    [null, '0%'],
    [NaN, '0%'],
    ['41', '0%'],
  ];
  for (const [pct, want] of cases) assert.equal(meterWidth(pct), want, `meterWidth(${String(pct)})`);
  for (let tenth = 0; tenth <= 1000; tenth++) {
    assert.ok(/^\d+(\.\d)?%$/.test(meterWidth(tenth / 10)), `meterWidth(${tenth / 10})`);
    assert.ok(!meterWidth(tenth / 10).endsWith('.0%'));
  }
});

// ── pollDue ─────────────────────────────────────────────────────────────────

test('pollDue: every running session is read once per round, never all in one tick', () => {
  assert.equal(POLL_EVERY_TICKS, 15);
  for (const count of [1, 3, 10, 15, 16, 40]) {
    const ids = Array.from({ length: count }, (_, i) => `sess-${String(i).padStart(3, '0')}`);
    const seen = new Map();
    for (let tick = 31; tick < 31 + POLL_EVERY_TICKS; tick++) {
      const due = pollDue(tick, ids);
      assert.ok(due.length <= Math.ceil(count / POLL_EVERY_TICKS), `${count} sessions, tick ${tick}: ${due.length}`);
      for (const id of due) seen.set(id, (seen.get(id) || 0) + 1);
    }
    assert.equal(seen.size, count, `${count} sessions: each one read`);
    for (const [id, times] of seen) assert.equal(times, 1, `${id} read ${times} times`);
  }
});

test('pollDue: the slot does not depend on the order the ids arrive in', () => {
  const ids = ['c', 'a', 'd', 'b'];
  for (let tick = 1; tick <= 30; tick++) {
    assert.deepEqual(pollDue(tick, ids), pollDue(tick, [...ids].reverse()), `tick ${tick}`);
  }
  assert.deepEqual(pollDue(15, ids), ['a']);
  assert.deepEqual(pollDue(14, ids), ['b']);
  assert.deepEqual(ids, ['c', 'a', 'd', 'b'], 'the input is not sorted in place');
});

test('pollDue: nothing for no sessions or a non-array', () => {
  for (const ids of [[], null, undefined, 'abc', new Set(['a'])]) {
    for (let tick = 0; tick < 16; tick++) assert.deepEqual(pollDue(tick, ids), []);
  }
});

// ── parseStoredRequest ──────────────────────────────────────────────────────

test('parseStoredRequest: a stored record comes back as written', () => {
  assert.deepEqual(
    parseStoredRequest(JSON.stringify({ phase: 'requested', atMs: AT_MS, reason: '' }), AT_MS + 5000),
    { phase: 'requested', atMs: AT_MS, reason: '' }
  );
  assert.deepEqual(
    parseStoredRequest(JSON.stringify({ phase: 'timeout', atMs: AT_MS, reason: HANDOFF_NOT_WRITTEN }), AT_MS + 700000),
    { phase: 'timeout', atMs: AT_MS, reason: HANDOFF_NOT_WRITTEN }
  );
  assert.deepEqual(
    parseStoredRequest(JSON.stringify({ phase: 'idle', atMs: AT_MS, reason: 'ignored' }), AT_MS + 5000),
    { phase: 'idle', atMs: AT_MS, reason: '' }
  );
  // No clock given: the time is not checked.
  assert.deepEqual(parseStoredRequest(JSON.stringify({ phase: 'idle', atMs: AT_MS })), { phase: 'idle', atMs: AT_MS, reason: '' });
});

test('parseStoredRequest: null for anything that is not a record this file wrote', () => {
  const bad = [
    null, undefined, '', 42, {}, 'not json', '[]', 'null', '"requested"',
    JSON.stringify({ phase: 'writing', atMs: AT_MS }),
    JSON.stringify({ phase: 'requested' }),
    JSON.stringify({ phase: 'requested', atMs: String(AT_MS) }),
    JSON.stringify({ phase: 'requested', atMs: 0 }),
    JSON.stringify({ phase: 'requested', atMs: -5 }),
    JSON.stringify({ phase: 'requested', atMs: null }),
  ];
  for (const text of bad) assert.equal(parseStoredRequest(text, AT_MS + 5000), null, String(text));
});

test('parseStoredRequest: a time in the future is refused (no Stop could ever be later than it)', () => {
  const text = JSON.stringify({ phase: 'idle', atMs: AT_MS });
  assert.notEqual(parseStoredRequest(text, AT_MS), null);
  assert.notEqual(parseStoredRequest(text, AT_MS - 1000), null, 'one second of slack');
  assert.equal(parseStoredRequest(text, AT_MS - 1001), null);
  assert.equal(parseStoredRequest(text, AT_MS - 3600000), null);
});

// ── browser half ────────────────────────────────────────────────────────────
//
// The real public/ctx-handoff.js, browser side included, in a vm context with
// a fake DOM, a fake window.api, the app globals it reads, and a clock and
// timers this file controls. As in the app, the script is evaluated BEFORE the
// globals exist.

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'ctx-handoff.js'), 'utf8');
// Loaded before it in index.html; here only for the tests that ask (opts.names).
const NAMES_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'continue-name.js'), 'utf8');
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const VM_DIR = 'C:\\Users\\x\\AppData\\Local\\claude-ctx';
const VM_HANDOFF = 'C:\\h\\handoff.md';
const VM_SIDECAR = { total_input_tokens: 412345, context_window_size: 1000000, used_percentage: 41, ts: 1999990, cwd: 'C:\\proj' };

const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeElement(tag, byId) {
  const attrs = {};
  let id = '';
  return {
    tag, className: '', textContent: '', type: '', style: { display: '', width: '' },
    children: [], parentNode: null, listeners: {},
    get id() { return id; },
    set id(value) { id = value; byId[value] = this; },
    get nextSibling() {
      const parent = this.parentNode;
      return parent ? parent.children[parent.children.indexOf(this) + 1] || null : null;
    },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...kids) { kids.forEach(child => this.appendChild(child)); },
    insertBefore(child, ref) {
      child.parentNode = this;
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
      return child;
    },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    hasAttribute(name) { return name in attrs; },
    removeAttribute(name) { delete attrs[name]; },
  };
}

// opts: globals 'app' (default) | 'none' | 'tdz'; diagDir; storage (a Map
// shared between two boots = a reload of one window); startMs; readCtxState
// (true = window.api has the main-process call, answered by knobs.ctxReply);
// names (true = continue-name.js is loaded first, as in the app); localStorage
// (what window.localStorage is; shared between two boots = a restart).
function boot(opts = {}) {
  let now = opts.startMs || 2000000000;
  const files = new Map();
  const sent = [];
  const confirms = [];
  const confirmOptions = [];
  const errors = [];
  const launches = [];
  const launchExtras = [];   // the third argument of each launch
  const reads = [];
  const timers = [];
  const listeners = {};
  const byId = {};
  const storage = opts.storage || new Map();
  const knobs = {
    confirmAnswer: true,
    rejectReads: false,
    resolveOptions: async () => ({ model: 'm', worktree: true, worktreeName: 'wt' }),
    launch: async () => {},
    // What main's readCtxState answers (opts.readCtxState only).
    ctxReply: () => null,
    // 'throw' = the call itself throws; 'reject' = the invoke rejects, which
    // is what a main process without the handler does.
    ctxFail: null,
  };

  const controls = fakeElement('div', byId); controls.id = 'terminal-header-controls';
  const status = fakeElement('span', byId); status.id = 'terminal-header-status';
  const stopBtn = fakeElement('button', byId); stopBtn.id = 'terminal-stop-btn';
  controls.append(status, stopBtn);

  const api = {
    diagDir: async () => opts.diagDir || 'C:\\Users\\x\\AppData\\Roaming\\switchboard\\diagnostics',
    readFileForPanel: async (filePath) => {
      reads.push(filePath);
      if (knobs.rejectReads) throw new Error('read refused');
      if (!files.has(filePath)) return { ok: false, error: 'ENOENT', code: 'ENOENT' };
      return { ok: true, content: files.get(filePath) };
    },
    sendInput: (id, data) => { sent.push([id, data]); },
    onCliBusyState: (cb) => { listeners.busy = cb; },
    onProcessExited: (cb) => { listeners.exit = cb; },
    onSessionForked: (cb) => { listeners.fork = cb; },
  };
  // The later main-process step: one call for both files, and main's busy flag.
  if (opts.readCtxState) {
    // Not an async function, so that 'throw' is a synchronous throw.
    api.readCtxState = (id) => {
      reads.push('readCtxState:' + id);
      if (knobs.ctxFail === 'throw') throw new Error('readCtxState blew up');
      if (knobs.ctxFail === 'reject') {
        return Promise.reject(new Error("Error invoking remote method 'read-ctx-state': No handler registered"));
      }
      return Promise.resolve(knobs.ctxReply(id));
    };
  }
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  const context = vm.createContext({
    window: { api },
    // dialogs.js's in-page confirm: it answers through a Promise, where the
    // native box this stood for returned a boolean.
    confirmDialog: async (message, options) => { confirms.push(message); confirmOptions.push(options); return knobs.confirmAnswer; },
    document: {
      getElementById: (id) => byId[id] || null,
      createElement: (tag) => fakeElement(tag, byId),
      querySelectorAll: () => [],
    },
    console: { error: (...args) => { errors.push(args.map(String).join(' ')); } },
    sessionStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
    },
    Date: FakeDate,
    setTimeout: (fn, ms) => { timers.push({ at: now + (ms || 0), fn, done: false }); return timers.length; },
    setInterval: () => 0,
    __knobs: knobs,
    __launches: launches,
    __launchExtras: launchExtras,
  });
  const run = (js) => vm.runInContext(js, context);

  if (opts.localStorage) context.window.localStorage = opts.localStorage;
  if (opts.names) run(NAMES_SOURCE);
  run(SOURCE);
  const globals = opts.globals || 'app';
  if (globals === 'app') {
    run(`
      let activeSessionId = '${SID}';
      let activePtyIds = new Set(['${SID}']);
      let gridViewActive = false;
      let activeTaskView = null;
      const pendingSessions = new Map();
      const sessionBusyState = new Map();
      const sessionMap = new Map([['${SID}', { sessionId: '${SID}', projectPath: 'C:\\\\proj', type: 'claude' }]]);
      window._isOwnedElsewhere = () => false;
      async function resolveDefaultSessionOptions(target) { return __knobs.resolveOptions(target); }
      async function launchNewSession(target, options, extra) {
        __launches.push(JSON.stringify({ target, options }));
        __launchExtras.push(extra);
        return __knobs.launch(target, options, extra);
      }
    `);
  } else if (globals === 'tdz') {
    // app.js died before its declarations ran: the bindings exist and throw.
    try {
      run(`throw new Error('app.js died'); let activeSessionId; let activePtyIds; let gridViewActive;
        const pendingSessions = 0; const sessionBusyState = 0; const sessionMap = 0;`);
    } catch {}
  }

  const visible = (el) => !!el && el.style.display !== 'none';
  const h = {
    files, sent, confirms, confirmOptions, errors, launches, launchExtras, reads, storage, knobs, listeners, byId, run,
    get now() { return now; },
    get sec() { return now / 1000; },
    // Moves the clock on, running every timer that falls due on the way.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter(t => !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = Math.max(now, next.at);
        next.done = true;
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    setState(state) {
      const file = VM_DIR + '\\' + SID + '.state.json';
      if (state === null) files.delete(file); else files.set(file, JSON.stringify(state));
    },
    setSidecar(sidecarValue) { files.set(VM_DIR + '\\' + SID + '.json', JSON.stringify(sidecarValue)); },
    setHandoffFile(present) { if (present) files.set(VM_HANDOFF, '# handoff'); else files.delete(VM_HANDOFF); },
    setBusy(on) { run(`sessionBusyState.set('${SID}', ${on ? 'true' : 'false'})`); },
    // A cli-busy-state event from main, as both listeners get it: ours (which
    // is registered first) and then app.js's, which fills sessionBusyState.
    busyEvent(on) { listeners.busy(SID, !!on); h.setBusy(on); },
    // A read the 500 ms rule lets through, then the tick's repaint.
    async refresh() {
      await h.advance(600);
      await run(`handoffRefresh('${SID}')`);
      await flush();
      run('handoffRenderHeader()');
    },
    async tick() { run('handoffTick()'); await flush(); },
    async ticks(count) {
      for (let i = 0; i < count; i++) { await h.advance(1000); await h.tick(); }
    },
    async click(which) {
      byId[which === 'update' ? 'handoff-update-btn' : 'handoff-primary-btn'].listeners.click();
      await flush();
    },
    request() { return JSON.parse(run(`JSON.stringify((handoffRt.cache.get('${SID}') || {}).request || null)`)); },
    inputs() { return JSON.parse(run(`JSON.stringify(handoffInputs('${SID}'))`)); },
    header() {
      const primary = byId['handoff-primary-btn'];
      const update = byId['handoff-update-btn'];
      const note = byId['handoff-note'];
      const meter = byId['handoff-meter'];
      return {
        meter: visible(meter),
        primary: visible(primary) ? primary.textContent : null,
        primaryEnabled: visible(primary) && primary.getAttribute('aria-disabled') === 'false',
        primaryOverride: visible(primary) && primary.className.includes('handoff-btn-override'),
        update: visible(update),
        note: visible(note) ? note.textContent : null,
      };
    },
  };
  return h;
}

// A turn ran and stopped well before "now"; nothing due, nothing written.
function endedState(h, over = {}) {
  return { pending: false, manual: false, crossed_at: null, written_at: null, handoff_path: null,
    last_prompt_at: h.sec - 950, last_stop_at: h.sec - 700, ...over };
}

function writtenVmState(h, over = {}) {
  return endedState(h, {
    crossed_at: h.sec - 900, written_at: h.sec - 800, written_tokens: 400000, handoff_path: VM_HANDOFF, ...over,
  });
}

// ...and this window saw it end: an idle event has arrived since it loaded, so
// "not busy" is something it was told. Without that a click asks first.
async function bootEnded(opts) {
  const h = boot(opts);
  h.setSidecar(VM_SIDECAR);
  h.setState(endedState(h));
  h.busyEvent(false);
  await h.refresh();
  return h;
}

// The same files in a window that has only just loaded: no event yet.
async function bootReloaded(opts) {
  const h = boot(opts);
  h.setSidecar(VM_SIDECAR);
  h.setState(endedState(h));
  await h.refresh();
  return h;
}

test('browser: the header shows the meter and a plain Hand off for a session whose turn has ended', async () => {
  const h = await bootEnded();
  const header = h.header();
  assert.equal(header.meter, true);
  assert.equal(header.primary, 'Hand off');
  assert.equal(header.primaryEnabled, true);
  assert.equal(header.primaryOverride, false);
  assert.equal(header.update, false);
  assert.equal(header.note, null);
  assert.equal(h.byId['handoff-meter'].children[1].children[0].style.width, '41%');
});

test('browser: a plain click types the line, then Enter as a separate write, and asks nothing', async () => {
  const h = await bootEnded();
  await h.click('primary');
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.header().primary, `Writing${ELLIPSIS}`);
  assert.equal(h.header().primaryEnabled, false);
  await h.advance(249);
  assert.equal(h.sent.length, 1, 'Enter is not in the same write, nor straight after it');
  await h.advance(1);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  assert.deepEqual(h.request(), { phase: 'requested', atMs: h.now - 250, reason: '' });
  // A click on "Writing…" does nothing.
  await h.click('primary');
  await h.advance(1000);
  assert.equal(h.sent.length, 2);
});

test('browser: a click on a disabled button types nothing', async () => {
  const h = await bootEnded();
  h.setBusy(true);
  await h.tick();
  assert.equal(h.header().primaryEnabled, false);
  await h.click('primary');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
});

test('browser: an override asks first, and "no" types nothing', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  await h.refresh(); // no state file: the turn has not been reported as ended
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryOverride, true);
  h.knobs.confirmAnswer = false;
  await h.click('primary');
  await h.advance(5000);
  assert.deepEqual(h.confirms, [OVERRIDE_CONFIRM]);
  // The button says what a yes does, and is the red one: the typed line could
  // answer a prompt that is open in the terminal.
  assert.deepEqual(h.confirmOptions.map((o) => ({ ...o })), [{ confirm: 'Type it anyway', danger: true }]);
  assert.deepEqual(h.sent, []);
  assert.equal(h.header().primary, 'Hand off');
});

test('browser: an override answer that is not exactly true is a no, a missing or failing dialog included', async () => {
  // The in-page confirm answers through a Promise. A Promise is truthy, so the
  // click handler has to await it; and whatever comes back that is not `true`
  // (no dialog loaded, a rejection, a stray value) must type nothing.
  const answers = {
    'undefined': () => undefined,
    'a truthy value that is not true': () => 'yes',
    'a rejection': () => Promise.reject(new Error('dialog failed')),
    'a throw': () => { throw new Error('dialog failed'); },
  };
  for (const [name, answer] of Object.entries(answers)) {
    const h = boot();
    h.setSidecar(VM_SIDECAR);
    await h.refresh();
    assert.equal(h.header().primaryOverride, true, name);
    h.run('confirmDialog = ' + answer.toString());
    await h.click('primary');
    await h.advance(5000);
    assert.deepEqual(h.sent, [], name);
  }
  const missing = boot();
  missing.setSidecar(VM_SIDECAR);
  await missing.refresh();
  missing.run('confirmDialog = undefined');
  await missing.click('primary');
  await missing.advance(5000);
  assert.deepEqual(missing.sent, [], 'dialogs.js did not load');
});

test('browser: an override answered OK waits, reads again, then types', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  await h.refresh();
  await h.click('primary');
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.sent, [], 'nothing is typed in the same task as the OK');
  await h.advance(499);
  assert.deepEqual(h.sent, []);
  await h.advance(1);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  await h.advance(250);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
});

test('browser: a session that went busy while the question was open is not typed into', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  await h.refresh();
  // OK straight after a read (inside the 500 ms rule), which is when the
  // second decision used to be taken before the queued busy event had run.
  await h.click('primary');
  assert.equal(h.confirms.length, 1);
  h.setBusy(true); // the busy event that was queued behind the dialog
  await h.advance(5000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryEnabled, false);
});

test('browser: a session shown in another window by the time of the OK is not typed into', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  await h.refresh();
  await h.click('primary');
  h.run('window._isOwnedElsewhere = () => true');
  await h.advance(5000);
  assert.deepEqual(h.sent, []);
});

test('browser: after a reload, with no busy or idle event seen yet, the click asks first', async () => {
  const h = await bootReloaded();
  assert.equal(h.inputs().busyKnown, false);
  const header = h.header();
  assert.equal(header.primary, 'Hand off');
  assert.equal(header.primaryEnabled, true);
  assert.equal(header.primaryOverride, true);
  assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'), OVERRIDE_TITLE_UNSEEN);

  // No: nothing typed.
  h.knobs.confirmAnswer = false;
  await h.click('primary');
  await h.advance(5000);
  assert.deepEqual(h.confirms, [OVERRIDE_CONFIRM]);
  assert.deepEqual(h.sent, []);

  // OK: the same wait and re-read as any override, then the line.
  h.knobs.confirmAnswer = true;
  await h.click('primary');
  assert.equal(h.confirms.length, 2);
  assert.deepEqual(h.sent, [], 'nothing is typed in the same task as the OK');
  await h.advance(499);
  assert.deepEqual(h.sent, []);
  await h.advance(1);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  await h.advance(250);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
});

test('browser: after a reload, a turn that was already running is caught by the busy event behind the dialog', async () => {
  const h = await bootReloaded();
  await h.click('primary');
  assert.equal(h.confirms.length, 1);
  h.busyEvent(true); // queued behind the dialog
  await h.advance(5000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.header().primaryEnabled, false);
});

test('browser: a busy or idle event seen since load brings back the plain click', async () => {
  for (const first of [false, true]) {
    const h = await bootReloaded();
    assert.equal(h.header().primaryOverride, true);
    h.busyEvent(first);
    await h.advance(0);
    assert.equal(h.inputs().busyKnown, true, `event ${first}`);
    if (first) {
      // Busy: disabled, not an override. Then the turn ends and the hook says so.
      await h.tick();
      assert.equal(h.header().primaryEnabled, false);
      assert.equal(h.header().primaryOverride, false);
      await h.advance(5000);
      h.setState(endedState(h, { last_prompt_at: h.sec - 4, last_stop_at: h.sec }));
      h.busyEvent(false);
    }
    await h.refresh();
    const header = h.header();
    assert.equal(header.primary, 'Hand off', `event ${first}`);
    assert.equal(header.primaryEnabled, true, `event ${first}`);
    assert.equal(header.primaryOverride, false, `event ${first}`);
    await h.click('primary');
    assert.equal(h.confirms.length, 0, `event ${first}`);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], `event ${first}`);
  }
});

test('browser: an event for another session says nothing about this one', async () => {
  const h = await bootReloaded();
  h.listeners.busy('bbbbbbbb-1111-2222-3333-444444444444', false);
  await h.refresh();
  assert.equal(h.inputs().busyKnown, false);
  assert.equal(h.header().primaryOverride, true);
});

test('browser: a reload forgets the events the window had seen', async () => {
  const storage = new Map();
  const first = await bootEnded({ storage });
  assert.equal(first.header().primaryOverride, false);
  const second = boot({ storage, startMs: first.now + 1000 });
  second.setSidecar(VM_SIDECAR);
  second.setState(endedState(first));
  await second.refresh();
  assert.equal(second.header().primary, 'Hand off');
  assert.equal(second.header().primaryOverride, true);
});

// The later main-process step: readCtxState answers with main's own busy flag.
function ctxReply(h, over = {}) {
  return { sidecar: VM_SIDECAR, state: endedState(h), ...over };
}

test('browser: readCtxState with a boolean busy replaces the ask-first rule', async () => {
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => ctxReply(h, { busy: false });
  await h.refresh();
  assert.equal(h.inputs().busyKnown, true, 'no event seen, but main said');
  assert.equal(h.inputs().busy, false);
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, false);
  await h.click('primary');
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
});

test('browser: readCtxState saying busy disables typing although this window has no busy flag of its own', async () => {
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => ctxReply(h, { busy: true });
  await h.refresh();
  assert.equal(h.run(`!!sessionBusyState.get('${SID}')`), false, 'the app map is empty after a load');
  assert.equal(h.inputs().busy, true);
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryEnabled, false);
  assert.equal(h.header().primaryOverride, false);
  assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'), WHY_BUSY);
  await h.click('primary');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
});

test('browser: the app\'s own busy flag still counts when main\'s last answer said idle', async () => {
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => ctxReply(h, { busy: false });
  await h.refresh();
  assert.equal(h.header().primaryEnabled, true);
  h.busyEvent(true); // a turn started after that read
  await h.tick();
  assert.equal(h.inputs().busy, true);
  assert.equal(h.header().primaryEnabled, false);
  await h.click('primary');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
});

test('browser: readCtxState without a boolean busy keeps the ask-first rule', async () => {
  for (const busy of [undefined, null, 0, 1, 'false', {}]) {
    const h = boot({ readCtxState: true });
    h.knobs.ctxReply = () => ctxReply(h, busy === undefined ? {} : { busy });
    await h.refresh();
    assert.equal(h.inputs().busyKnown, false, `busy ${String(busy)}`);
    assert.equal(h.inputs().busy, false, `busy ${String(busy)}`);
    assert.equal(h.header().primaryEnabled, true, `busy ${String(busy)}`);
    assert.equal(h.header().primaryOverride, true, `busy ${String(busy)}`);
  }
  // A later reply that drops the flag is "not told" again, not the old answer.
  const h = boot({ readCtxState: true });
  let reply = ctxReply(h, { busy: false });
  h.knobs.ctxReply = () => reply;
  await h.refresh();
  assert.equal(h.header().primaryOverride, false);
  reply = ctxReply(h);
  await h.refresh();
  assert.equal(h.inputs().busyKnown, false);
  assert.equal(h.header().primaryOverride, true);
});

// --- readCtxState as main really answers it (step 4) ---
//
// main.js 'read-ctx-state': { sidecar, state, codes: { sidecar, state, handoff },
// handoffReadable } plus a top-level boolean `busy` ONLY when main knows it.

const VM_SIDECAR_FILE = VM_DIR + '\\' + SID + '.json';
const VM_STATE_FILE = VM_DIR + '\\' + SID + '.state.json';

// A reply in main's shape. `busy` is absent unless given.
function mainReply(h, over = {}) {
  return {
    sidecar: VM_SIDECAR, state: endedState(h),
    codes: { sidecar: null, state: null, handoff: null },
    handoffReadable: null,
    ...over,
  };
}

function ctxCalls(h) { return h.reads.filter(entry => entry.startsWith('readCtxState:')).length; }
function panelReads(h) { return h.reads.filter(entry => !entry.startsWith('readCtxState:')); }
function cached(h, field) { return JSON.parse(h.run(`JSON.stringify(handoffRt.cache.get('${SID}').${field})`) || 'null'); }

test('browser: a readCtxState that throws or rejects falls back to the panel read and is not called again for 60 s', async () => {
  for (const mode of ['throw', 'reject']) {
    // A new preload with an OLD main process: the function exists, the handler does not.
    const h = boot({ readCtxState: true });
    h.knobs.ctxFail = mode;
    h.setSidecar(VM_SIDECAR);
    h.setState(endedState(h));
    await h.refresh();
    const failedAt = h.now;
    assert.equal(ctxCalls(h), 1, mode);
    assert.deepEqual(panelReads(h).sort(), [VM_SIDECAR_FILE, VM_STATE_FILE].sort(), `${mode}: the same read went on through the panel`);
    assert.equal(h.header().meter, true, `${mode}: the meter still shows`);
    assert.equal(h.header().primary, 'Hand off', mode);
    assert.equal(h.inputs().busyKnown, false, `${mode}: nothing from main, so not told`);
    assert.equal(h.header().primaryOverride, true, mode);

    // Inside the minute: the panel read, and main is not asked.
    for (let i = 0; i < 3; i++) {
      await h.advance(18000);
      h.reads.length = 0;
      await h.refresh();
      assert.ok(h.now - failedAt < 60000);
      assert.equal(ctxCalls(h), 0, `${mode}: ${h.now - failedAt} ms after the failure`);
      assert.equal(panelReads(h).length, 2, mode);
    }
    // The files are followed in the meantime.
    h.setSidecar({ ...VM_SIDECAR, total_input_tokens: 455000 });
    h.reads.length = 0;
    await h.refresh();
    assert.equal(ctxCalls(h), 0, mode);
    assert.equal(cached(h, 'sidecar').total_input_tokens, 455000, mode);

    // After the minute main is asked again; still failing, so another minute.
    await h.advance(60000 - (h.now - failedAt));
    h.reads.length = 0;
    await h.refresh();
    const failedAgainAt = h.now;
    assert.equal(ctxCalls(h), 1, `${mode}: asked again after 60 s`);
    assert.equal(panelReads(h).length, 2, mode);
    await h.advance(30000);
    h.reads.length = 0;
    await h.refresh();
    assert.equal(ctxCalls(h), 0, `${mode}: a second minute`);

    // Main has the handler now (the relaunch happened): back to main, no panel read.
    h.knobs.ctxFail = null;
    h.knobs.ctxReply = () => mainReply(h, { sidecar: { ...VM_SIDECAR, total_input_tokens: 470000 }, busy: false });
    await h.advance(60000 - (h.now - failedAgainAt));
    h.reads.length = 0;
    await h.refresh();
    assert.equal(ctxCalls(h), 1, mode);
    assert.deepEqual(panelReads(h), [], mode);
    assert.equal(cached(h, 'sidecar').total_input_tokens, 470000, mode);
    assert.equal(h.inputs().busyKnown, true, mode);
    assert.equal(h.errors.filter(line => line.includes('readCtxState failed')).length, 1, `${mode}: logged once`);
    assert.equal(h.errors.filter(line => line.includes('read failed')).length, 0, `${mode}: the refresh itself never failed`);
  }
});

test('browser: the back-off is for the window, not for one session', async () => {
  const h = boot({ readCtxState: true });
  h.knobs.ctxFail = 'reject';
  const other = 'bbbbbbbb-1111-2222-3333-444444444444';
  h.run(`activePtyIds = new Set(['${SID}', '${other}'])`);
  await h.refresh();
  assert.equal(ctxCalls(h), 1);
  await h.run(`handoffRefresh('${other}')`);
  await flush();
  assert.equal(ctxCalls(h), 1, 'the handler is missing for every session alike');
  assert.ok(panelReads(h).some(file => file.includes(other)));
});

test('browser: an { error } reply from readCtxState is an answer: no back-off, no panel read, the last reading kept', async () => {
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => mainReply(h, { busy: false });
  await h.refresh();
  assert.equal(h.header().meter, true);
  for (const reply of [{ error: 'bad session id' }, null, 'nope', 7]) {
    h.knobs.ctxReply = () => reply;
    h.reads.length = 0;
    await h.refresh();
    assert.equal(ctxCalls(h), 1, JSON.stringify(reply));
    assert.deepEqual(panelReads(h), [], JSON.stringify(reply));
    assert.deepEqual(cached(h, 'sidecar'), VM_SIDECAR, JSON.stringify(reply));
    assert.equal(h.header().meter, true, JSON.stringify(reply));
    assert.equal(h.inputs().busyKnown, false, 'a reply without the flag is not told');
  }
  // ...and the very next read asks main again.
  h.knobs.ctxReply = () => mainReply(h, { sidecar: { ...VM_SIDECAR, total_input_tokens: 500000 } });
  h.reads.length = 0;
  await h.refresh();
  assert.equal(ctxCalls(h), 1);
  assert.equal(cached(h, 'sidecar').total_input_tokens, 500000);
  assert.equal(h.errors.length, 0);
});

test('browser: readCtxState codes: ENOENT is "not there", an object is the value, anything else keeps the last reading', async () => {
  const h = boot({ readCtxState: true });
  const state = endedState(h);
  h.knobs.ctxReply = () => mainReply(h, { state });
  await h.refresh();
  assert.deepEqual(cached(h, 'sidecar'), VM_SIDECAR);
  assert.deepEqual(cached(h, 'state'), state);

  // Caught mid-write, locked, or any other failure: undefined, so what we had stands.
  for (const code of ['EPARSE', 'EBUSY', 'EPERM', 'EREAD', null, undefined, 0]) {
    h.knobs.ctxReply = () => ({ sidecar: null, state: null, codes: { sidecar: code, state: code, handoff: null }, handoffReadable: null });
    await h.refresh();
    assert.deepEqual(cached(h, 'sidecar'), VM_SIDECAR, `sidecar, code ${String(code)}`);
    assert.deepEqual(cached(h, 'state'), state, `state, code ${String(code)}`);
    assert.equal(h.header().meter, true, `code ${String(code)}`);
  }
  // A reply with no codes at all says nothing about a missing value either.
  h.knobs.ctxReply = () => ({ sidecar: null, state: null });
  await h.refresh();
  assert.deepEqual(cached(h, 'sidecar'), VM_SIDECAR);
  assert.deepEqual(cached(h, 'state'), state);

  // Each file on its own: the state could not be read, the sidecar moved on.
  const newer = { ...VM_SIDECAR, total_input_tokens: 430000 };
  h.knobs.ctxReply = () => ({ sidecar: newer, state: null, codes: { sidecar: null, state: 'EPARSE', handoff: null }, handoffReadable: null });
  await h.refresh();
  assert.deepEqual(cached(h, 'sidecar'), newer);
  assert.deepEqual(cached(h, 'state'), state);

  // ENOENT is the file not being there, which is normal: the reading is cleared.
  h.knobs.ctxReply = () => ({ sidecar: newer, state: null, codes: { sidecar: null, state: 'ENOENT', handoff: null }, handoffReadable: null });
  await h.refresh();
  assert.equal(cached(h, 'state'), null);
  assert.deepEqual(cached(h, 'sidecar'), newer);
  h.knobs.ctxReply = () => ({ sidecar: null, state: null, codes: { sidecar: 'ENOENT', state: 'ENOENT', handoff: null }, handoffReadable: null });
  await h.refresh();
  assert.equal(cached(h, 'sidecar'), null);
  assert.equal(h.header().meter, false);
  // ENOENT wins over a value sent beside it, as the panel path never had both.
  h.knobs.ctxReply = () => ({ sidecar: VM_SIDECAR, state, codes: { sidecar: 'ENOENT', state: null, handoff: null }, handoffReadable: null });
  await h.refresh();
  assert.equal(cached(h, 'sidecar'), null);
  assert.deepEqual(cached(h, 'state'), state);
  assert.deepEqual(panelReads(h), [], 'never the panel read');
});

test('browser: handoffReadable from main is used for Continue and the handoff file is not read through the panel', async () => {
  const h = boot({ readCtxState: true });
  const state = writtenVmState(h);
  // The panel read would say "gone" (the file map is empty): main's answer is the one used.
  h.knobs.ctxReply = () => mainReply(h, { state, handoffReadable: true });
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  assert.deepEqual(panelReads(h), []);

  // "Could not be read just now" (any code but ENOENT) on a handoff that was
  // readable does not take Continue away...
  for (const code of ['EBUSY', 'EPERM', 'ESTAT', null]) {
    h.knobs.ctxReply = () => mainReply(h, { state, handoffReadable: false, codes: { sidecar: null, state: null, handoff: code } });
    await h.refresh();
    assert.equal(h.header().primary, 'Continue in new session', `code ${String(code)}`);
  }
  // ...only "the file is gone" does, and at this read, not a minute later.
  h.knobs.ctxReply = () => mainReply(h, { state, handoffReadable: false, codes: { sidecar: null, state: null, handoff: 'ENOENT' } });
  await h.refresh();
  assert.equal(h.header().primary, 'Hand off');
  // Back again as soon as main can stat it.
  h.knobs.ctxReply = () => mainReply(h, { state, handoffReadable: true });
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  assert.deepEqual(panelReads(h), []);
});

test('browser: a handoff main never saw readable offers no Continue, whatever the code', async () => {
  for (const code of ['EBUSY', null, 'ENOENT']) {
    const h = boot({ readCtxState: true });
    h.setHandoffFile(true); // the panel read would say readable
    h.knobs.ctxReply = () => mainReply(h, {
      state: writtenVmState(h), handoffReadable: false, codes: { sidecar: null, state: null, handoff: code },
    });
    await h.refresh();
    assert.equal(h.header().primary, 'Hand off', `code ${String(code)}`);
    assert.deepEqual(panelReads(h), [], `code ${String(code)}`);
  }
});

test('browser: a read where main could not read the state leaves Continue as it was, without a panel read', async () => {
  const h = boot({ readCtxState: true });
  const state = writtenVmState(h);
  h.knobs.ctxReply = () => mainReply(h, { state, handoffReadable: true });
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  // The state file was caught mid-write: no handoff path for main to stat.
  h.knobs.ctxReply = () => ({ sidecar: VM_SIDECAR, state: null, codes: { sidecar: null, state: 'EPARSE', handoff: null }, handoffReadable: null });
  await h.advance(61000); // past the once-a-minute rule of the panel check
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  assert.deepEqual(panelReads(h), []);
});

test('browser: a main that sends the state without handoffReadable leaves the check to the panel read', async () => {
  const h = boot({ readCtxState: true });
  h.setHandoffFile(true);
  h.knobs.ctxReply = () => ({ sidecar: VM_SIDECAR, state: writtenVmState(h), codes: { sidecar: null, state: null } });
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  assert.deepEqual(panelReads(h), [VM_HANDOFF]);
});

test('browser: a state with no handoff needs no check at all', async () => {
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => mainReply(h); // handoffReadable: null, as main sends it
  await h.refresh();
  assert.equal(h.header().primary, 'Hand off');
  assert.deepEqual(panelReads(h), []);
});

test('browser: main\'s reply without a busy key stays "not told"; with one it is known', async () => {
  // Main leaves the key out unless the session is running and it has read a title.
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => mainReply(h);
  await h.refresh();
  assert.equal(cached(h, 'mainBusy'), null);
  assert.equal(h.inputs().busyKnown, false);
  assert.equal(h.header().primaryOverride, true, 'asks first');
  await h.click('primary');
  assert.equal(h.confirms.length, 1);

  const told = boot({ readCtxState: true });
  told.knobs.ctxReply = () => mainReply(told, { busy: false });
  await told.refresh();
  assert.equal(cached(told, 'mainBusy'), false);
  assert.equal(told.inputs().busyKnown, true);
  assert.equal(told.header().primaryOverride, false);
  // Dropped again by a later reply: back to "not told", not the old answer.
  told.knobs.ctxReply = () => mainReply(told);
  await told.refresh();
  assert.equal(cached(told, 'mainBusy'), null);
  assert.equal(told.inputs().busyKnown, false);

  const busy = boot({ readCtxState: true });
  busy.knobs.ctxReply = () => mainReply(busy, { busy: true });
  await busy.refresh();
  assert.equal(busy.inputs().busy, true);
  assert.equal(busy.header().primaryEnabled, false);
});

test('browser: the three flags that forbid typing fail closed when app.js cannot be read', async () => {
  for (const globals of ['none', 'tdz']) {
    const h = boot({ globals });
    const input = h.inputs();
    assert.equal(input.busy, true, `${globals}: busy`);
    assert.equal(input.pendingRow, true, `${globals}: pendingRow`);
    assert.equal(input.ownedElsewhere, true, `${globals}: ownedElsewhere`);
    assert.equal(input.running, false, `${globals}: running`);
  }
  const app = (await bootEnded()).inputs();
  assert.equal(app.busy, false);
  assert.equal(app.pendingRow, false);
  assert.equal(app.ownedElsewhere, false);
  assert.equal(app.running, true);
});

test('browser: grid view shows nothing of ours in the header, and a click there does nothing', async () => {
  const h = await bootEnded();
  assert.equal(h.header().primary, 'Hand off');
  h.run('gridViewActive = true');
  await h.tick();
  assert.deepEqual(h.header(), { meter: false, primary: null, primaryEnabled: false, primaryOverride: false, update: false, note: null });
  await h.click('primary');
  await h.click('update');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
  h.run('gridViewActive = false');
  await h.tick();
  assert.equal(h.header().primary, 'Hand off');
});

test('browser: an instance whose hook folder cannot be found shows nothing and types nothing', async () => {
  const h = boot({ diagDir: 'D:\\sb-data\\diagnostics' });
  await h.refresh();
  await h.tick();
  assert.deepEqual(h.header(), { meter: false, primary: null, primaryEnabled: false, primaryOverride: false, update: false, note: null });
  await h.click('primary');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
});

test('browser: a request whose files can no longer be read stops saying "Writing…"', async () => {
  const h = await bootEnded();
  await h.click('primary');
  await h.advance(250);
  assert.equal(h.sent.length, 2);
  const atMs = h.request().atMs;
  h.knobs.rejectReads = true;
  await h.ticks(19);
  assert.equal(h.request().phase, 'requested');
  await h.ticks(3);
  assert.deepEqual(h.request(), { phase: 'timeout', atMs, reason: HANDOFF_NOT_LANDED });
  assert.equal(h.header().primary, null, 'no button while the files cannot be read');
  // Readable again: the note is there, and asking again is an override.
  h.knobs.rejectReads = false;
  await h.refresh();
  assert.equal(h.header().note, HANDOFF_NOT_LANDED);
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryOverride, true, 'no Stop since the typed line');
  // Half an hour after the click it is over, with the click time kept.
  await h.advance(REQUEST_EXPIRY_MS);
  await h.tick();
  assert.deepEqual(h.request(), { phase: 'idle', atMs, reason: '' });
  assert.equal(h.header().note, null);
});

test('browser: the request record survives a reload of the window', async () => {
  const storage = new Map();
  const first = await bootEnded({ storage });
  await first.click('primary');
  await first.advance(250);
  const atMs = first.request().atMs;
  assert.equal(storage.size, 1);

  // The same window again: new memory, same sessionStorage, same files.
  const second = boot({ storage, startMs: first.now + 1000 });
  second.setSidecar(VM_SIDECAR);
  second.setState(endedState(first));
  await second.refresh();
  assert.equal(second.header().primary, `Writing${ELLIPSIS}`);
  assert.deepEqual(second.request(), { phase: 'requested', atMs, reason: '' });
  await second.click('primary');
  await second.advance(1000);
  assert.deepEqual(second.sent, [], 'no second request');

  // Written: back to idle, and the typed line's time is still there for the
  // "Stop later than the last typed line" rule after another reload.
  const clickS = atMs / 1000;
  second.setHandoffFile(true);
  second.setState(endedState(second, {
    crossed_at: clickS + 0.2, written_at: clickS + 40, handoff_path: VM_HANDOFF,
    last_prompt_at: clickS + 0.2, last_stop_at: clickS + 45,
  }));
  await second.advance(60000);
  await second.refresh();
  assert.deepEqual(second.request(), { phase: 'idle', atMs, reason: '' });
  assert.equal(second.header().primary, 'Continue in new session');
  const third = boot({ storage, startMs: second.now + 1000 });
  third.setSidecar(VM_SIDECAR);
  third.setState(endedState(third, { last_prompt_at: clickS - 300, last_stop_at: clickS - 200 }));
  await third.refresh();
  assert.deepEqual(third.request(), { phase: 'idle', atMs, reason: '' });
  assert.equal(third.header().primaryOverride, true, 'the only Stop on file is older than the typed line');
});

test('browser: the "session ended" note goes when the session is running again', async () => {
  const h = await bootEnded();
  await h.click('primary');
  await h.advance(250);
  h.run('activePtyIds = new Set()');
  await h.ticks(8);
  assert.equal(h.request().reason, HANDOFF_SESSION_ENDED);
  assert.equal(h.header().primary, null);
  assert.equal(h.header().note, HANDOFF_SESSION_ENDED, 'shown with no button beside it');
  h.run(`activePtyIds = new Set(['${SID}'])`);
  await h.ticks(2);
  assert.equal(h.request().phase, 'idle');
  assert.equal(h.header().note, null);
  assert.equal(h.header().primary, 'Hand off');
});

async function bootWritten() {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h));
  await h.refresh();
  return h;
}

test('browser: Continue starts one sibling in the same folder, no worktree, told to read the handoff', async () => {
  const h = await bootWritten();
  assert.equal(h.header().primary, 'Continue in new session');
  assert.equal(h.header().update, true);
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.deepEqual(JSON.parse(h.launches[0]), {
    target: { projectPath: 'C:\\proj' },
    options: { model: 'm', initialPrompt: 'Read C:/h/handoff.md in full before doing anything else, then continue' },
  });
  assert.deepEqual(h.sent, [], 'Continue types nothing into the old session');
  assert.equal(h.confirms.length, 0);
});

test('browser: Continue from an ultracode session starts the sibling in ultracode, over the stored effort', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h, { ultracode: true, ultra_scan: { path: 'C:\\t\\s.jsonl', offset: 1234 } }));
  await h.refresh();
  assert.equal(h.inputs().ultracode, true);
  assert.equal(h.header().primary, 'Continue in new session (ultracode)');
  assert.ok(h.byId['handoff-primary-btn'].getAttribute('title').endsWith('. It starts in ultracode, like this one'));
  // The default effort the settings would have given is replaced, not kept.
  h.knobs.resolveOptions = async () => ({ model: 'm', effort: 'low', worktree: true, worktreeName: 'wt' });
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.deepEqual(JSON.parse(h.launches[0]), {
    target: { projectPath: 'C:\\proj' },
    options: {
      model: 'm', effort: 'ultracode',
      initialPrompt: 'Read C:/h/handoff.md in full before doing anything else, then continue',
    },
  });
});

test('browser: only the boolean true carries ultracode over; anything else leaves the effort alone', async () => {
  // false = switched off, null = no record seen, no key = an older hook.
  const cases = [['false', { ultracode: false }], ['null', { ultracode: null }], ['absent', {}],
    ['a string', { ultracode: 'yes' }], ['a number', { ultracode: 1 }]];
  for (const [name, over] of cases) {
    const h = boot();
    h.setSidecar(VM_SIDECAR);
    h.setHandoffFile(true);
    h.setState(writtenVmState(h, over));
    await h.refresh();
    assert.equal(h.inputs().ultracode, false, name);
    assert.equal(h.header().primary, 'Continue in new session', name);
    await h.click('primary');
    assert.equal(h.launches.length, 1, name);
    const { options } = JSON.parse(h.launches[0]);
    assert.ok(!('effort' in options), `${name}: no effort of ours`);

    // ...and a stored effort goes through as it is.
    h.knobs.resolveOptions = async () => ({ model: 'm', effort: 'high' });
    await h.advance(3001);
    await h.click('primary');
    assert.equal(JSON.parse(h.launches[1]).options.effort, 'high', name);
  }
});

test('browser: a session that left ultracode after its handoff continues without it', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h, { ultracode: true }));
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session (ultracode)');
  h.setState(writtenVmState(h, { ultracode: false }));
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  await h.click('primary');
  assert.ok(!('effort' in JSON.parse(h.launches[0]).options));
});

test('browser: Continue stays locked until the launch has settled, however long that takes', async () => {
  const h = await bootWritten();
  let finish;
  h.knobs.launch = () => new Promise(resolve => { finish = resolve; });
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.equal(h.header().primaryEnabled, false);
  await h.click('primary');
  assert.equal(h.launches.length, 1, 'a double click');
  await h.ticks(10); // far past the 3 s floor, the launch still out
  assert.equal(h.header().primaryEnabled, false);
  await h.click('primary');
  assert.equal(h.launches.length, 1, 'a click while the launch is still out');
  finish();
  await flush();
  await h.tick();
  assert.equal(h.header().primaryEnabled, true);
});

test('browser: a quick launch still holds the lock for 3 s', async () => {
  const h = await bootWritten();
  await h.click('primary');
  await h.advance(2000);
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  await h.advance(1001);
  await h.click('primary');
  assert.equal(h.launches.length, 2);
});

test('browser: a Continue that fails says so in the header and logs every failure', async () => {
  const h = await bootWritten();
  h.knobs.resolveOptions = async () => { throw new Error('settings unreadable'); };
  await h.click('primary');
  assert.equal(h.launches.length, 0);
  assert.equal(h.header().note, 'The new session could not be started.');
  assert.equal(h.header().primary, 'Continue in new session');
  assert.equal(h.errors.filter(line => line.includes('Continue failed')).length, 1);
  await h.advance(3001);
  await h.click('primary');
  assert.equal(h.errors.filter(line => line.includes('Continue failed')).length, 2, 'not logged once only');
  // The next attempt clears it; so does a minute.
  h.knobs.resolveOptions = async () => ({});
  await h.advance(3001);
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.equal(h.header().note, null);
  h.knobs.launch = async () => { throw new Error('spawn failed'); };
  await h.advance(3001);
  await h.click('primary');
  assert.equal(h.header().note, 'The new session could not be started.');
  await h.advance(60001);
  await h.tick();
  assert.equal(h.header().note, null);
});

test('browser: a stopped session with a newer handoff due still offers Continue for the one it wrote', async () => {
  const h = boot();
  h.setSidecar(VM_SIDECAR);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h, { pending: true, manual: true, crossed_at: h.sec - 100 }));
  h.run('activePtyIds = new Set()');
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session');
  assert.equal(h.header().update, false);
  await h.click('primary');
  assert.equal(h.launches.length, 1);
});

test('browser: after the first round the 15 s poll reads one running session per tick, each once a round', async () => {
  const h = boot();
  const ids = ['sess-a', 'sess-b', 'sess-c', SID];
  h.run(`activePtyIds = new Set(${JSON.stringify(ids)})`);
  const sessionsRead = () => new Set(h.reads.splice(0).map(file => path.win32.basename(file).split('.')[0]));
  await h.ticks(1);
  assert.equal(sessionsRead().size, ids.length, 'the first round reads them all, so the chips are not blank');
  const seen = new Map();
  for (let i = 0; i < POLL_EVERY_TICKS; i++) {
    await h.ticks(1);
    const now = sessionsRead();
    assert.ok(now.size <= 1, `tick ${i}: ${[...now].join(', ')}`);
    for (const id of now) seen.set(id, (seen.get(id) || 0) + 1);
  }
  assert.deepEqual([...seen.keys()].sort(), [...ids].sort());
  for (const [id, times] of seen) assert.equal(times, 1, id);
});

test('browser: entries for sessions that are gone are dropped; the active and the running ones stay', async () => {
  const h = await bootEnded();
  for (let i = 0; i < 5; i++) h.listeners.busy(`gone-session-${i}`, true);
  await flush();
  assert.equal(h.run('handoffRt.cache.size'), 6);
  await h.ticks(60);
  assert.equal(h.run('handoffRt.cache.size'), 6, 'one pass only marks them');
  await h.ticks(60);
  assert.equal(h.run('handoffRt.cache.size'), 1);
  assert.equal(h.run(`handoffRt.cache.has('${SID}')`), true);
  assert.ok(h.run('handoffRt.lastReadAtMs.size') <= 1);
});

// ── Continue names the sibling ──────────────────────────────────────────────
//
// Jason: "When I continue in new session, the session name should be the
// previous session name with an incrementing number". The rule itself is
// test/continue-name.test.js; this is the wiring in handoffContinue: which
// title is read, what is passed to launchNewSession, what is remembered, and
// that none of it can cost him the launch.

const NEW_SID = 'bbbbbbbb-1111-2222-3333-444444444444';
// cleanDisplayName as shipped (public/utils.js), for the test that wants the
// title cleaned the way the lists clean it.
const CLEAN_DISPLAY_NAME = (() => {
  const utils = fs.readFileSync(path.join(__dirname, '..', 'public', 'utils.js'), 'utf8');
  const from = utils.indexOf('function cleanDisplayName(name) {');
  const to = utils.indexOf('function formatDate(date) {');
  assert.ok(from >= 0 && to > from, 'cleanDisplayName is where it was in utils.js');
  return utils.slice(from, to);
})();

/** A Storage over a Map; `broken` makes every call throw. */
function fakeLocalStorage(broken = false) {
  const map = new Map();
  return {
    map,
    getItem(key) { if (broken) throw new Error('storage is off'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (broken) throw new Error('storage is full'); map.set(key, String(value)); },
  };
}

/** What the names store has written: [[id, name], ...]. */
const remembered = (ls) => JSON.parse(ls.map.get('continue-names') || '[]');

/** A window ready to Continue, with continue-name.js loaded and the old
 *  session carrying `fields`. Each launch answers with the next id in `ids`. */
async function bootNamed(fields, { localStorage = fakeLocalStorage(), ids = [NEW_SID] } = {}) {
  const h = boot({ names: true, localStorage });
  h.setSidecar(VM_SIDECAR);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h));
  h.run(`Object.assign(sessionMap.get('${SID}'), ${JSON.stringify(fields)})`);
  const queue = [...ids];
  h.knobs.launch = async () => queue.shift();
  await h.refresh();
  return { h, localStorage };
}

test('browser: Continue names the sibling after the old session, numbered 2, and remembers it', async () => {
  const { h, localStorage } = await bootNamed({ name: 'Relaunch work' });
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.deepEqual({ ...h.launchExtras[0] }, { name: 'Relaunch work 2' });
  assert.deepEqual(remembered(localStorage), [[NEW_SID, 'Relaunch work 2']]);
  assert.equal(h.run(`sessionMap.get('${SID}').name`), 'Relaunch work', 'the old session keeps its name');
  assert.deepEqual(h.sent, [], 'and nothing is typed into it');
  assert.equal(h.errors.filter(line => line.includes('Continue failed')).length, 0);
});

test('browser: Continue from a session with no typed name uses the title it shows', async () => {
  const ai = await bootNamed({ aiTitle: 'Fix the scheduler', summary: 'please fix it' });
  await ai.h.click('primary');
  assert.equal(ai.h.launchExtras[0].name, 'Fix the scheduler 2');

  // The summary, cleaned as the lists clean it, when that is all there is.
  const summary = await bootNamed({ summary: 'Implement the following plan: <b>Ship</b>   the  thing' });
  summary.h.run(CLEAN_DISPLAY_NAME);
  await summary.h.click('primary');
  assert.equal(summary.h.launchExtras[0].name, 'Ship the thing 2');
});

test('browser: Continue counts up a number it gave, and only that', async () => {
  // The session being continued is itself a sibling Continue named.
  const ours = fakeLocalStorage();
  ours.map.set('continue-names', JSON.stringify([[SID, 'Relaunch work 2']]));
  const chain = await bootNamed({ name: 'Relaunch work 2' }, { localStorage: ours });
  await chain.h.click('primary');
  assert.equal(chain.h.launchExtras[0].name, 'Relaunch work 3');
  assert.deepEqual(remembered(ours), [[SID, 'Relaunch work 2'], [NEW_SID, 'Relaunch work 3']]);

  // A title that ends in a number of its own keeps it.
  const own = await bootNamed({ name: 'Upgrade Electron 41' });
  await own.h.click('primary');
  assert.equal(own.h.launchExtras[0].name, 'Upgrade Electron 41 2');

  // Renamed by hand since Continue named it: the name is his now.
  const renamed = fakeLocalStorage();
  renamed.map.set('continue-names', JSON.stringify([[SID, 'Relaunch work 2']]));
  const byHand = await bootNamed({ name: 'Phase 7' }, { localStorage: renamed });
  await byHand.h.click('primary');
  assert.equal(byHand.h.launchExtras[0].name, 'Phase 7 2');
});

test('browser: the chain survives a restart, and goes on in the same page without storage', async () => {
  // One storage, two page loads. The first names the sibling...
  const shared = fakeLocalStorage();
  const first = await bootNamed({ name: 'Relaunch work' }, { localStorage: shared });
  await first.h.click('primary');
  assert.deepEqual(remembered(shared), [[NEW_SID, 'Relaunch work 2']]);
  // ...and the second, which has only the storage, continues that sibling.
  // (The harness has one session id, so the stored id is rewritten to it.)
  shared.map.set('continue-names', JSON.stringify([[SID, 'Relaunch work 2']]));
  const second = await bootNamed({ name: 'Relaunch work 2' }, { localStorage: shared });
  await second.h.click('primary');
  assert.equal(second.h.launchExtras[0].name, 'Relaunch work 3');

  // Storage that throws on every call: the page still remembers what it gave.
  const { h } = await bootNamed({ name: 'Relaunch work' }, { localStorage: fakeLocalStorage(true) });
  await h.click('primary');
  assert.equal(h.launchExtras[0].name, 'Relaunch work 2');
  assert.equal(h.run(`handoffNameStore().isOurs('${NEW_SID}', 'Relaunch work 2')`), true);
  assert.equal(h.errors.length, 0);
});

test('browser: a window whose localStorage cannot even be read still names the sibling', async () => {
  // Not a Storage that throws when called (above): the property itself
  // throws, as it does where storage is denied to the page.
  const { h } = await bootNamed({ name: 'Relaunch work' });
  h.run(`Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } })`);
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launchExtras[0].name, 'Relaunch work 2');
  assert.equal(h.run(`handoffNameStore().isOurs('${NEW_SID}', 'Relaunch work 2')`), true, 'remembered by the page');
  assert.equal(h.errors.length, 0);
});

test('browser: Continue skips a name another session in the window already shows', async () => {
  const { h } = await bootNamed({ name: 'Relaunch work' });
  // Continued twice already, by clicks this page did not see.
  h.run(`sessionMap.set('other-1', { sessionId: 'other-1', name: 'Relaunch work 2' })`);
  h.run(`sessionMap.set('other-2', { sessionId: 'other-2', aiTitle: 'Relaunch work 3' })`);
  await h.click('primary');
  assert.equal(h.launchExtras[0].name, 'Relaunch work 4');
});

test('browser: a session with nothing to carry over continues unnamed, as before', async () => {
  for (const fields of [{}, { summary: 'New session' }, { name: '   ' }]) {
    const { h, localStorage } = await bootNamed(fields);
    await h.click('primary');
    assert.equal(h.launches.length, 1, JSON.stringify(fields));
    assert.deepEqual(JSON.parse(h.launches[0]), {
      target: { projectPath: 'C:\\proj' },
      options: { model: 'm', initialPrompt: 'Read C:/h/handoff.md in full before doing anything else, then continue' },
    });
    assert.equal(h.launchExtras[0].name, null);
    assert.deepEqual(remembered(localStorage), [], 'nothing to remember');
  }
});

test('browser: without continue-name.js Continue still starts the sibling, unnamed', async () => {
  const h = await bootWritten();
  h.run(`sessionMap.get('${SID}').name = 'Relaunch work'`);
  await h.click('primary');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launchExtras[0].name, null);
  assert.equal(h.header().note, null);
});

test('browser: naming that throws never costs the launch', async () => {
  // The rule throws: an unnamed sibling.
  const rule = await bootNamed({ name: 'Relaunch work' });
  rule.h.run(`window.ContinueName.continuedName = () => { throw new Error('rule broke'); }`);
  await rule.h.click('primary');
  assert.equal(rule.h.launches.length, 1);
  assert.equal(rule.h.launchExtras[0].name, null);
  assert.equal(rule.h.header().note, null);

  // The store cannot be made: unnamed again.
  const made = await bootNamed({ name: 'Relaunch work' });
  made.h.run(`window.ContinueName.createStore = () => { throw new Error('no store'); }`);
  await made.h.click('primary');
  assert.equal(made.h.launches.length, 1);
  assert.equal(made.h.launchExtras[0].name, null);
  assert.equal(made.h.header().note, null);

  // Remembering throws AFTER the session started: not a failed Continue.
  const after = await bootNamed({ name: 'Relaunch work' });
  after.h.run(`
    const realStore = window.ContinueName.createStore;
    window.ContinueName.createStore = (s) => ({ ...realStore(s), remember() { throw new Error('cannot remember'); } });
  `);
  await after.h.click('primary');
  assert.equal(after.h.launches.length, 1);
  assert.equal(after.h.launchExtras[0].name, 'Relaunch work 2');
  assert.equal(after.h.header().note, null);
  assert.equal(after.h.errors.filter(line => line.includes('Continue failed')).length, 0);

  // The session map cannot be walked for names in use: named all the same.
  const noMap = await bootNamed({ name: 'Relaunch work' });
  noMap.h.run(`sessionMap.values = () => { throw new Error('gone'); }`);
  await noMap.h.click('primary');
  assert.equal(noMap.h.launchExtras[0].name, 'Relaunch work 2');
});

test('browser: a sibling whose terminal did not open is not remembered', async () => {
  // launchNewSession answers null when the terminal could not be opened.
  const { h, localStorage } = await bootNamed({ name: 'Relaunch work' }, { ids: [null] });
  await h.click('primary');
  assert.equal(h.launchExtras[0].name, 'Relaunch work 2');
  assert.deepEqual(remembered(localStorage), []);
});

// ── the ultracode button, and the mark on a reading that has stopped ────────
//
// Added with the ultracode button. The names are taken here and not at the
// top, so that everything above this line stands exactly as it was: those
// tests are the proof that Hand off behaves as it did before the gate moved
// out of buttonModel.

const {
  ULTRACODE_TEXT, ULTRACODE_UNKNOWN_TITLE, ULTRACODE_NOT_CONFIRMED, ULTRACODE_NO_WORKFLOWS, ULTRACODE_NO_MODEL,
  STALE_AFTER_MS,
  typingGate, ultracodeValue, draftOpen, ultracodeModel, ultracodeQuestion, ultracodeScreen, ultracodeOutcome,
  parseStoredUltracode, staleReading, staleTitle,
} = require(MODULE_PATH);

const ON_LINE = 'Ultracode on (this session only): workflows may run. Effort stays high.';
const OLD_ON_LINE = 'Set effort level to ultracode (this session only): workflows may run';
const OFF_LINE = 'Ultracode off. Effort stays high.';

// Every combination the gate looks at.
function gateCases() {
  const states = [hookState(), null, oldHookState(), hookState({ last_stop_at: 900 }), hookState({ last_prompt_at: null })];
  const requests = [{ phase: 'idle' }, { phase: 'idle', atMs: STOP_MS + 5 }, { phase: 'timeout', atMs: STOP_MS - 5, reason: 'x' }];
  const cases = [];
  for (const running of [true, false]) {
    for (const ownedElsewhere of [false, true]) {
      for (const pendingRow of [false, true]) {
        for (const busy of [false, true, undefined]) {
          for (const busyKnown of [true, false]) {
            for (const state of states) {
              for (const lastBusyAtMs of [null, STOP_MS - 1, STOP_MS + 1]) {
                for (const request of requests) {
                  cases.push(buttonArgs({ running, ownedElsewhere, pendingRow, busy, busyKnown, state, lastBusyAtMs, request }));
                }
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

function ultraArgs(over = {}) {
  return buttonArgs({ ultracodeValue: false, switching: false, typed: null, headerOff: false, ...over });
}

test('typingGate: Hand off is exactly what the gate says, in every combination', () => {
  let plain = 0;
  let asks = 0;
  for (const args of gateCases()) {
    const gate = typingGate(args);
    const model = buttonModel(args);
    assert.equal(gate.override && !gate.allowed, false, 'an override is always an allowed control');
    if (!args.running) {
      assert.equal(model.visible, false);
      assert.equal(gate.allowed, false);
      assert.equal(gate.why, args.ownedElsewhere ? 'Shown in another window' : args.pendingRow ? 'Session is still starting' : args.busy === true ? 'Session is working' : 'Session is not running');
      continue;
    }
    assert.equal(model.primary.kind, 'handoff');
    assert.equal(model.primary.enabled, gate.allowed);
    assert.equal(model.primary.override, gate.override);
    if (!gate.allowed) assert.equal(model.primary.title, gate.why);
    else if (gate.override) assert.equal(model.primary.title, gate.overrideTitle);
    else assert.equal(model.primary.title, 'Ask this session to write its context handoff');
    if (gate.allowed && !gate.override) plain++;
    if (gate.override) asks++;
  }
  assert.ok(plain > 0 && asks > 0, 'the table reaches both the plain and the ask-first state');
});

test('typingGate: no input at all is "not allowed"', () => {
  assert.deepEqual(typingGate(), { allowed: false, override: false, why: 'Session is not running', overrideTitle: OVERRIDE_TITLE });
  assert.equal(typingGate(buttonArgs()).overrideTitle, OVERRIDE_TITLE_UNSEEN, 'a turn that has ended leaves only "not told" to name');
});

test('ultracodeModel: never plainly clickable where Hand off would ask first, never clickable where Hand off is not', () => {
  for (const args of gateCases()) {
    for (const value of [true, false]) {
      const hand = buttonModel(args).primary;
      const ultra = ultracodeModel({ ...args, ultracodeValue: value });
      assert.equal(ultra.enabled, hand.enabled);
      assert.equal(ultra.override, hand.override);
      assert.equal(ultra.enabled && !ultra.override && (hand.override || !hand.enabled), false);
      // ...and where it is disabled it gives Hand off's reason.
      if (args.running && !hand.enabled) assert.equal(ultra.title, hand.title);
    }
  }
});

test('ultracodeModel: hidden for a plain terminal, a session that is not running, and a header that is off', () => {
  for (const over of [{ isTerminal: true }, { running: false }, { headerOff: true }]) {
    const model = ultracodeModel(ultraArgs({ ultracodeValue: true, ...over }));
    assert.equal(model.visible, false, JSON.stringify(over));
    assert.equal(model.enabled, false, JSON.stringify(over));
    assert.equal(model.target, null, JSON.stringify(over));
  }
  assert.deepEqual(ultracodeModel(), {
    visible: false, label: 'Ultracode', look: 'unknown', enabled: false, override: false, target: null, title: '',
  });
});

test('ultracodeModel: known on is filled and a click switches it off; known off is the outline and a click switches it on', () => {
  assert.deepEqual(ultracodeModel(ultraArgs({ ultracodeValue: true })), {
    visible: true, label: 'Ultracode', look: 'on', enabled: true, override: false, target: 'off',
    title: 'Ultracode is on. Click to switch it off.',
  });
  assert.deepEqual(ultracodeModel(ultraArgs({ ultracodeValue: false })), {
    visible: true, label: 'Ultracode', look: 'off', enabled: true, override: false, target: 'on',
    title: 'Ultracode is off. Click to switch it on.',
  });
});

test('ultracodeModel: a value that is not known is dimmed and never clickable: no guessing a direction', () => {
  assert.equal(ULTRACODE_UNKNOWN_TITLE, 'Not known yet. The hook reports it after the session\'s first turn.');
  for (const value of [null, undefined, 'true', 1, 0]) {
    const model = ultracodeModel(ultraArgs({ ultracodeValue: value }));
    assert.deepEqual(model, {
      visible: true, label: 'Ultracode', look: 'unknown', enabled: false, override: false, target: null,
      title: ULTRACODE_UNKNOWN_TITLE,
    }, String(value));
  }
});

test('ultracodeModel: while a typed switch is unconfirmed it says "Ultracode…", is not clickable, and keeps the look it had', () => {
  for (const [value, look] of [[true, 'on'], [false, 'off'], [null, 'unknown']]) {
    const model = ultracodeModel(ultraArgs({ ultracodeValue: value, switching: true }));
    assert.equal(model.label, `Ultracode${ELLIPSIS}`);
    assert.equal(model.enabled, false);
    assert.equal(model.target, null);
    assert.equal(model.look, look, 'never the look of the switch that was only asked for');
    assert.equal(model.title, 'Waiting for the session to confirm the switch');
  }
});

test('ultracodeModel: where typing is not allowed it is disabled, with the reason Hand off gives', () => {
  const reasons = [
    [{ ownedElsewhere: true }, 'Shown in another window'],
    [{ pendingRow: true }, 'Session is still starting'],
    [{ busy: true }, 'Session is working'],
  ];
  for (const [over, why] of reasons) {
    const model = ultracodeModel(ultraArgs({ ultracodeValue: true, ...over }));
    assert.equal(model.visible, true);
    assert.equal(model.enabled, false);
    assert.equal(model.look, 'on', 'what it is stays readable');
    assert.equal(model.title, why);
    assert.equal(model.title, buttonModel(buttonArgs(over)).primary.title);
  }
});

test('ultracodeModel: a handoff request on its way into the session disables it', () => {
  const model = ultracodeModel(ultraArgs({ ultracodeValue: true, request: { phase: 'requested', atMs: STOP_MS + 1 } }));
  assert.equal(model.enabled, false);
  assert.equal(model.title, 'Waiting for the session to write the handoff');
});

test('ultracodeModel: it asks first wherever the gate does, and the tooltip says so', () => {
  for (const over of [{ state: null }, { busyKnown: false }, { lastBusyAtMs: STOP_MS + 1 }]) {
    const model = ultracodeModel(ultraArgs({ ultracodeValue: true, ...over }));
    assert.equal(model.enabled, true, JSON.stringify(over));
    assert.equal(model.override, true, JSON.stringify(over));
    assert.equal(model.target, 'off');
    assert.equal(model.title, 'Ultracode is on. Click to switch it off (asks first).');
  }
});

test('draftOpen: the last thing typed by hand was not Enter, whenever that was', () => {
  assert.equal(draftOpen(null), false, 'nothing typed in this window');
  assert.equal(draftOpen(undefined), false);
  assert.equal(draftOpen({ atMs: STOP_MS + 1, enter: false }), true);
  assert.equal(draftOpen({ atMs: STOP_MS + 1, enter: true }), false, 'the last of it was Enter');
  // Only the boolean true is an Enter; a record without a time is no record.
  assert.equal(draftOpen({ atMs: STOP_MS + 1, enter: 'yes' }), true);
  assert.equal(draftOpen({ enter: false }), false);
  assert.equal(draftOpen('typed'), false);
});

test('ultracodeModel: text typed ahead while the turn ran is still a draft when the turn has ended', () => {
  // The end of a turn does not empty the input box. Typed before the hook's
  // Stop, at it, or with no Stop on record: the click asks first all the same.
  const stops = [hookState(), hookState({ last_stop_at: 5000 }), oldHookState(), null];
  for (const state of stops) {
    for (const atMs of [STOP_MS - 5000, STOP_MS, STOP_MS + 1]) {
      const model = ultracodeModel(ultraArgs({ state, typed: { atMs, enter: false } }));
      assert.equal(model.enabled, true);
      assert.equal(model.override, true, JSON.stringify({ atMs, stop: state && state.last_stop_at }));
    }
  }
});

test('ultracodeModel: the draft rule turns a plain click into one that asks first, and nothing else', () => {
  const draft = { atMs: STOP_MS + 1, enter: false };
  const plain = ultracodeModel(ultraArgs({ ultracodeValue: false }));
  const over = ultracodeModel(ultraArgs({ ultracodeValue: false, typed: draft }));
  assert.equal(plain.override, false);
  assert.equal(over.enabled, true);
  assert.equal(over.override, true);
  assert.equal(over.title, 'Ultracode is off. Click to switch it on (asks first).');
  assert.equal(ultracodeModel(ultraArgs({ typed: { atMs: STOP_MS + 1, enter: true } })).override, false);
  // A draft never makes a disabled button clickable.
  assert.equal(ultracodeModel(ultraArgs({ typed: draft, busy: true })).enabled, false);
  assert.equal(ultracodeModel(ultraArgs({ typed: draft, busy: true })).override, false);
  // Hand off does not have the rule.
  assert.equal(buttonModel(buttonArgs({ typed: draft })).primary.override, false);
});

// Where the hook's scan of the transcript stopped: its mark that it has looked.
const SCANNED = { path: 'C:\\t\\sess-1.jsonl', offset: 4096 };

test('ultracodeValue: the hook\'s boolean when nothing was confirmed here; a scan that found no switch is off; no scan is "not known"', () => {
  assert.equal(ultracodeValue(hookState({ ultracode: true }), null), true);
  assert.equal(ultracodeValue(hookState({ ultracode: false }), null), false);
  // The hook writes true or false only once the transcript holds a switch: a
  // session that was never switched stays null there, and that is off.
  assert.equal(ultracodeValue(hookState({ ultracode: null, ultra_scan: SCANNED }), null), false);
  assert.equal(ultracodeValue(hookState({ ultracode: true, ultra_scan: SCANNED }), null), true);
  assert.equal(ultracodeValue(hookState({ ultracode: null, ultra_scan: null }), null), null, 'the hook has not looked');
  assert.equal(ultracodeValue(hookState({ ultracode: null }), null), null);
  assert.equal(ultracodeValue(hookState(), null), null, 'an older hook writes no key');
  assert.equal(ultracodeValue(null, null), null);
  assert.equal(ultracodeValue(hookState({ ultracode: 'true' }), undefined), null);
  assert.equal(ultracodeValue(hookState({ ultra_scan: 'yes' }), null), null);
});

test('ultracodeValue: a confirmation stands until the hook records a Stop later than it; then the hook\'s value wins', () => {
  // The hook last recorded a Stop at 1010 s.
  const state = hookState({ ultracode: false });
  assert.equal(ultracodeValue(state, { value: true, atMs: STOP_MS + 1 }), true, 'confirmed after that Stop');
  assert.equal(ultracodeValue(state, { value: true, atMs: STOP_MS }), false, 'a Stop at that moment or later');
  assert.equal(ultracodeValue(state, { value: true, atMs: STOP_MS - 1 }), false);
  // A prompt later than the confirmation is not enough: the hook scans there
  // before the transcript holds that prompt's records, so its value is still
  // the one from before the switch, for the whole of that turn.
  const prompted = hookState({ ultracode: false, last_prompt_at: 1020 });
  assert.equal(ultracodeValue(prompted, { value: true, atMs: STOP_MS + 1 }), true);
  const stopped = hookState({ ultracode: true, last_prompt_at: 1020, last_stop_at: 1030 });
  assert.equal(ultracodeValue(stopped, { value: false, atMs: STOP_MS + 1 }), true, 'the Stop after it has seen them');
  // A scan after the confirmation that found no switch is the hook saying off.
  const never = hookState({ ultracode: null, ultra_scan: SCANNED, last_stop_at: 1030 });
  assert.equal(ultracodeValue(never, { value: true, atMs: STOP_MS + 1 }), false);
  // No Stop on record at all (an older hook): the confirmation stands.
  assert.equal(ultracodeValue(oldHookState({ ultracode: true }), { value: false, atMs: 5 }), false);
});

test('ultracodeValue: a hook that has not looked never takes a confirmed switch away', () => {
  const later = hookState({ ultracode: null, last_stop_at: 5000 });
  assert.equal(ultracodeValue(later, { value: true, atMs: STOP_MS + 1 }), true);
  assert.equal(ultracodeValue(null, { value: false, atMs: 5 }), false);
  // A record that is not one is no confirmation.
  for (const bad of [{ value: 'true', atMs: 5 }, { value: true }, { atMs: 5 }, 'true', 7]) {
    assert.equal(ultracodeValue(hookState({ ultracode: false }), bad), false, JSON.stringify(bad));
  }
});

test('the typed texts are the exact commands, with no newline or carriage return (Enter is sent separately)', () => {
  assert.deepEqual({ ...ULTRACODE_TEXT }, { on: '/effort ultracode', off: '/effort ultracode off' });
  for (const text of Object.values(ULTRACODE_TEXT)) assert.equal(/[\r\n]/.test(text), false);
});

test('the question names the exact text and says when to cancel', () => {
  assert.equal(ultracodeQuestion('off'),
    'Type "/effort ultracode off" into this session?\n\n'
    + 'Only when it is waiting at an empty prompt. If it is asking you something, or you have text typed there, cancel.');
  assert.equal(ultracodeQuestion('on').split('\n')[0], 'Type "/effort ultracode" into this session?');
});

test('ultracodeScreen: counts the program\'s own lines, and never the typed command', () => {
  assert.equal(ultracodeScreen(null), null);
  assert.equal(ultracodeScreen(undefined), null);
  // A terminal always has rows: none at all is a read that failed.
  assert.equal(ultracodeScreen([]), null);
  assert.deepEqual(ultracodeScreen(['', '']), { on: 0, off: 0, noWorkflows: 0, noModel: 0 });
  assert.deepEqual(ultracodeScreen([
    '> /effort ultracode',
    '  ' + ON_LINE,
    '> /effort ultracode off',
    '  ' + OFF_LINE,
    OLD_ON_LINE,
    'Ultracode needs dynamic workflows enabled (see /config) first',
    'Ultracode isn\'t available on haiku',
    'Ultracode isn’t available on haiku',
    'ultracode on, in a sentence of the model\'s',
    '',
  ]), { on: 2, off: 1, noWorkflows: 1, noModel: 2 });
});

test('ultracodeOutcome: only MORE lines than before settle a switch', () => {
  const none = ultracodeScreen(['']);
  const on = ultracodeScreen([ON_LINE]);
  const off = ultracodeScreen([OFF_LINE]);
  assert.deepEqual(ultracodeOutcome('on', none, on), { outcome: 'confirmed', reason: '' });
  assert.deepEqual(ultracodeOutcome('on', none, ultracodeScreen([OLD_ON_LINE])), { outcome: 'confirmed', reason: '' });
  assert.deepEqual(ultracodeOutcome('off', none, off), { outcome: 'confirmed', reason: '' });
  // The line of an earlier switch is still on screen: nothing new.
  assert.equal(ultracodeOutcome('on', on, on).outcome, 'waiting');
  assert.equal(ultracodeOutcome('on', on, ultracodeScreen([ON_LINE, ON_LINE])).outcome, 'confirmed');
  // The other direction's line is not this switch's.
  assert.equal(ultracodeOutcome('on', none, off).outcome, 'waiting');
  assert.equal(ultracodeOutcome('off', none, on).outcome, 'waiting');
  assert.equal(ultracodeOutcome('on', none, none).outcome, 'waiting');
});

test('ultracodeOutcome: a refusal is looked for before a confirmation', () => {
  const none = ultracodeScreen(['']);
  // A new refusal and, beside it, a line of the target's that was not there
  // at the count before: refused. Not switched is the side to be wrong on.
  for (const [line, reason] of [['Ultracode needs dynamic workflows enabled', ULTRACODE_NO_WORKFLOWS], ['Ultracode isn\'t available on haiku', ULTRACODE_NO_MODEL]]) {
    assert.deepEqual(ultracodeOutcome('on', none, ultracodeScreen([ON_LINE, line])), { outcome: 'refused', reason });
    assert.deepEqual(ultracodeOutcome('off', none, ultracodeScreen([line, OFF_LINE])), { outcome: 'refused', reason });
  }
  // An old refusal still on screen does not stand in a confirmation's way.
  const refusedBefore = ultracodeScreen(['Ultracode isn\'t available on haiku']);
  assert.equal(ultracodeOutcome('on', refusedBefore, ultracodeScreen(['Ultracode isn\'t available on haiku', ON_LINE])).outcome, 'confirmed');
  // A screen read as no rows at all, before or after, settles nothing.
  assert.equal(ultracodeOutcome('on', ultracodeScreen([]), ultracodeScreen([ON_LINE])).outcome, 'waiting');
  assert.equal(ultracodeOutcome('on', none, ultracodeScreen([])).outcome, 'waiting');
});

test('ultracodeOutcome: a refusal line is a refusal with its reason; an unreadable screen settles nothing', () => {
  const none = ultracodeScreen(['']);
  assert.deepEqual(ultracodeOutcome('on', none, ultracodeScreen(['Ultracode needs dynamic workflows enabled (see /config)'])),
    { outcome: 'refused', reason: ULTRACODE_NO_WORKFLOWS });
  assert.deepEqual(ultracodeOutcome('on', none, ultracodeScreen(['Ultracode isn\'t available on haiku'])),
    { outcome: 'refused', reason: ULTRACODE_NO_MODEL });
  const refusedBefore = ultracodeScreen(['Ultracode isn\'t available on haiku']);
  assert.equal(ultracodeOutcome('on', refusedBefore, refusedBefore).outcome, 'waiting', 'an old refusal is not this one');
  // Not read before: what is on screen now could be from any time.
  assert.equal(ultracodeOutcome('on', null, ultracodeScreen([ON_LINE])).outcome, 'waiting');
  assert.equal(ultracodeOutcome('on', none, null).outcome, 'waiting');
});

test('parseStoredUltracode: the record as stored, and nothing else', () => {
  const now = 5000000;
  assert.deepEqual(parseStoredUltracode(JSON.stringify({ value: true, atMs: now - 10 }), now), { value: true, atMs: now - 10 });
  assert.deepEqual(parseStoredUltracode(JSON.stringify({ value: false, atMs: now - 10, extra: 1 }), now), { value: false, atMs: now - 10 });
  const bad = [
    null, undefined, '', 'not json', 'null', '7', '[]',
    JSON.stringify({ value: 'true', atMs: now }), JSON.stringify({ atMs: now }), JSON.stringify({ value: true }),
    JSON.stringify({ value: true, atMs: 0 }), JSON.stringify({ value: true, atMs: -5 }), JSON.stringify({ value: true, atMs: '5' }),
  ];
  for (const text of bad) assert.equal(parseStoredUltracode(text, now), null, String(text));
  // A time in the future: no report of the hook's could ever be later.
  assert.notEqual(parseStoredUltracode(JSON.stringify({ value: true, atMs: now + 1000 }), now), null, 'one second of slack');
  assert.equal(parseStoredUltracode(JSON.stringify({ value: true, atMs: now + 1001 }), now), null);
});

// ── the stale reading, pure ────────────────────────────────────────────────

// A turn this window watched: busy at 3000 s, idle at 3060 s, and the files
// read 3 s after that. The default reading and turn markers are far older.
const TURN = { busyAtMs: 3000000, idleAtMs: 3060000 };
function staleArgs(over = {}) {
  return { turn: TURN, readAtMs: TURN.idleAtMs + 3000, sidecar: sidecar({ ts: 2000.5 }), state: hookState(), ...over };
}

test('staleReading: a watched turn, a read after it, and nothing in the files as late as its start', () => {
  assert.deepEqual(staleReading(staleArgs()), { sinceTs: 2000.5 });
  // The state file may be missing altogether: the reading alone decides then.
  assert.deepEqual(staleReading(staleArgs({ state: null })), { sinceTs: 2000.5 });
});

test('staleReading: no watched turn, no mark', () => {
  assert.equal(staleReading(), null);
  assert.equal(staleReading(staleArgs({ turn: null })), null);
  assert.equal(staleReading(staleArgs({ turn: { busyAtMs: null, idleAtMs: TURN.idleAtMs } })), null, 'went idle, never seen busy');
  assert.equal(staleReading(staleArgs({ turn: { busyAtMs: TURN.busyAtMs } })), null, 'still busy');
  assert.equal(staleReading(staleArgs({ turn: { busyAtMs: 5000, idleAtMs: 4000 } })), null);
});

test('staleReading: not before the files were read a few seconds after the turn ended', () => {
  assert.equal(STALE_AFTER_MS, 2500);
  assert.equal(staleReading(staleArgs({ readAtMs: TURN.idleAtMs + STALE_AFTER_MS - 1 })), null);
  assert.notEqual(staleReading(staleArgs({ readAtMs: TURN.idleAtMs + STALE_AFTER_MS })), null);
  assert.equal(staleReading(staleArgs({ readAtMs: TURN.idleAtMs - 1 })), null, 'the read is from before the turn ended');
  assert.equal(staleReading(staleArgs({ readAtMs: 0 })), null);
  assert.equal(staleReading(staleArgs({ readAtMs: undefined })), null);
});

test('staleReading: the mark goes as soon as anything in the files has moved since the turn began', () => {
  const busySec = TURN.busyAtMs / 1000;
  assert.equal(staleReading(staleArgs({ sidecar: sidecar({ ts: busySec }) })), null, 'the reading moved');
  assert.equal(staleReading(staleArgs({ sidecar: sidecar({ ts: busySec + 30 }) })), null);
  assert.notEqual(staleReading(staleArgs({ sidecar: sidecar({ ts: busySec - 0.001 }) })), null);
  // The hook is alive for this id (it stamped the turn), so this is not a
  // terminal whose files have stopped.
  assert.equal(staleReading(staleArgs({ state: hookState({ last_stop_at: busySec + 60 }) })), null);
  assert.equal(staleReading(staleArgs({ state: hookState({ last_prompt_at: busySec }) })), null);
  // A reading without a time has nothing to say "since".
  assert.equal(staleReading(staleArgs({ sidecar: sidecar({ ts: null }) })), null);
  assert.equal(staleReading(staleArgs({ sidecar: null })), null);
});

test('chipState: a stale reading keeps its number and colour, is flagged, and the tooltip says since when', () => {
  assert.equal(staleTitle('14:05'), 'Not updated since 14:05. If you ran /clear in this session, the real count is lower.');
  const fresh = chipState(chipArgs());
  assert.equal('stale' in fresh, false, 'no key at all on a reading that is current');
  const stale = chipState(chipArgs({ staleSince: '14:05' }));
  assert.deepEqual(stale, { text: fresh.text, level: fresh.level, stale: true, title: staleTitle('14:05') });
  const due = chipState(chipArgs({ state: hookState({ pending: true }), staleSince: '09:00' }));
  assert.equal(due.level, 'due');
  assert.equal(due.stale, true);
  assert.equal(due.title, staleTitle('09:00'));
  assert.equal(chipState(chipArgs({ running: false, staleSince: '14:05' })), null);
});

// ── the ultracode button in the browser half ───────────────────────────────

const ULTRA_KEY = 'handoff-ultracode:' + SID;

function ultraHeader(h) {
  const btn = h.byId['handoff-ultracode-btn'];
  const shown = !!btn && btn.style.display !== 'none';
  return {
    shown,
    label: shown ? btn.children[1].textContent : null,
    enabled: shown && btn.getAttribute('aria-disabled') === 'false',
    asksFirst: shown && btn.className.includes('handoff-btn-override'),
    look: shown ? (/handoff-btn-ultracode-(on|off|unknown)/.exec(btn.className) || [])[1] : null,
    title: shown ? btn.getAttribute('title') : null,
  };
}

async function clickUltra(h) {
  h.byId['handoff-ultracode-btn'].listeners.click();
  await flush();
}

// A terminal as xterm.js shows it to the page. knobs.rows is the live screen,
// knobs.scrollback what has gone off its top, and knobs.viewTop the first
// buffer line in view (null = scrolled to the bottom, the live screen).
function fakeTerminal(knobs) {
  const lineAt = (y) => {
    const text = knobs.scrollback.concat(knobs.rows)[y];
    return text === undefined ? undefined : { translateToString: () => text };
  };
  return {
    get rows() { return knobs.rows.length; },
    buffer: {
      get active() {
        const baseY = knobs.scrollback.length;
        return { baseY, viewportY: knobs.viewTop === null ? baseY : knobs.viewTop, getLine: lineAt };
      },
    },
  };
}

// A session whose turn has ended, with the hook's ultracode value as given
// (undefined = the hook wrote no key), a terminal whose screen is h.knobs.rows,
// and the bolt icon. reloaded = this window has had no busy or idle event.
async function bootUltra(ultracode, { reloaded = false, storage, startMs, readCtxState } = {}) {
  const h = boot({ storage, startMs, readCtxState });
  h.knobs.rows = ['> hello', ''];
  h.knobs.scrollback = [];
  h.knobs.viewTop = null;
  h.knobs.terminal = fakeTerminal(h.knobs);
  // TermDiag reads what is IN VIEW, as the shipped one does: the button must
  // not go by it (the scrolled-up tests below).
  h.run(`
    window.TermDiag = { viewportRows: (terminal) => {
      const rows = [];
      const buffer = terminal.buffer.active;
      for (let y = 0; y < terminal.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        rows.push(line ? line.translateToString(true) : '');
      }
      return rows;
    } };
    window._openSessions = new Map([['${SID}', { terminal: __knobs.terminal }]]);
    window.ICONS = { bolt: (size) => '<svg data-bolt="' + size + '"></svg>' };
  `);
  if (readCtxState) h.knobs.ctxReply = () => mainReply(h, { state: endedState(h, ultracode === undefined ? {} : { ultracode }), busy: false });
  h.setSidecar(VM_SIDECAR);
  h.setState(endedState(h, ultracode === undefined ? {} : { ultracode }));
  if (!reloaded) h.busyEvent(false);
  await h.refresh();
  return h;
}

test('browser: the button sits just before Hand off, with a bolt and a label', async () => {
  const h = await bootUltra(false);
  const ids = h.byId['terminal-header-controls'].children.map(el => el.id);
  assert.equal(ids.indexOf('handoff-ultracode-btn') + 1, ids.indexOf('handoff-primary-btn'));
  const btn = h.byId['handoff-ultracode-btn'];
  assert.equal(btn.children.length, 2);
  assert.equal(btn.children[0].className, 'handoff-btn-icon');
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: true, asksFirst: false, look: 'off',
    title: 'Ultracode is off. Click to switch it on.',
  });
  assert.equal(h.header().primary, 'Hand off', 'Hand off is where it was');
});

test('browser: the button shows what the hook reported, and nothing clickable while that is not known', async () => {
  const on = await bootUltra(true);
  assert.equal(ultraHeader(on).look, 'on');
  assert.equal(ultraHeader(on).title, 'Ultracode is on. Click to switch it off.');

  const unknown = await bootUltra(undefined);
  assert.deepEqual(ultraHeader(unknown), {
    shown: true, label: 'Ultracode', enabled: false, asksFirst: false, look: 'unknown', title: ULTRACODE_UNKNOWN_TITLE,
  });
  await clickUltra(unknown);
  await unknown.advance(6000);
  assert.deepEqual(unknown.sent, []);
  assert.equal(unknown.confirms.length, 0);

  // A session that was never switched: the hook has scanned its transcript
  // and found no switch. That is off, and the click that switches it on.
  const never = await bootUltra(undefined);
  never.setState(endedState(never, { ultracode: null, ultra_scan: SCANNED }));
  await never.advance(500);
  await never.refresh();
  assert.equal(ultraHeader(never).look, 'off');
  assert.equal(ultraHeader(never).enabled, true);
  await clickUltra(never);
  assert.deepEqual(never.sent, [[SID, '/effort ultracode']]);
});

test('browser: hidden for a plain terminal and for a session that is not running', async () => {
  const terminal = await bootUltra(true);
  terminal.run(`sessionMap.get('${SID}').type = 'terminal'`);
  await terminal.tick();
  assert.equal(ultraHeader(terminal).shown, false);

  const stopped = await bootUltra(true);
  stopped.run('activePtyIds = new Set()');
  await stopped.tick();
  assert.equal(ultraHeader(stopped).shown, false);
  await clickUltra(stopped);
  await stopped.advance(6000);
  assert.deepEqual(stopped.sent, []);
});

test('browser: a plain click types the text, then Enter separately, and shows the switch only once the terminal confirms it', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode']]);
  assert.equal(h.confirms.length, 0);
  // Never shown as done on the click alone.
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: `Ultracode${ELLIPSIS}`, enabled: false, asksFirst: false, look: 'off',
    title: 'Waiting for the session to confirm the switch',
  });
  assert.equal(h.inputs().ultracode, false);
  await h.advance(249);
  assert.equal(h.sent.length, 1);
  await h.advance(1);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode'], [SID, '\r']]);
  // A click meanwhile types nothing more.
  await clickUltra(h);
  assert.equal(h.sent.length, 2);

  h.knobs.rows = ['> /effort ultracode', '  ' + ON_LINE, ''];
  await h.advance(749);
  assert.equal(ultraHeader(h).look, 'off', 'the first look is a second after the text');
  await h.advance(1);
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: true, asksFirst: false, look: 'on',
    title: 'Ultracode is on. Click to switch it off.',
  });
  assert.equal(h.inputs().ultracode, true, 'although the hook still says off');
  assert.deepEqual(JSON.parse(h.storage.get(ULTRA_KEY)), { value: true, atMs: h.now });
  assert.equal(h.header().note, null);
  // The later looks change nothing.
  await h.advance(6000);
  assert.equal(ultraHeader(h).look, 'on');
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.errors, []);
});

test('browser: switching off types the off text and is confirmed by the off line', async () => {
  const h = await bootUltra(true);
  await clickUltra(h);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode off']]);
  h.knobs.rows = ['> /effort ultracode off', '  ' + OFF_LINE];
  // Seen at the second look, not the first: the line came late.
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'off');
  assert.equal(h.inputs().ultracodeValue, false);
  assert.equal(ultraHeader(h).title, 'Ultracode is off. Click to switch it on.');
});

test('browser: a line that arrives late is still seen, up to the last look', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  await h.advance(2600);
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  h.knobs.rows = [OLD_ON_LINE];
  await h.advance(2400);
  assert.equal(ultraHeader(h).look, 'on', 'the older wording counts too');
  assert.equal(h.header().note, null);
});

test('browser: no confirmation after 5 s goes back to the look it had, with a note', async () => {
  const h = await bootUltra(false);
  // The line of an earlier switch is on screen already: it settles nothing.
  h.knobs.rows = ['  ' + ON_LINE, '> something else'];
  await clickUltra(h);
  await h.advance(4999);
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  assert.equal(h.header().note, null);
  await h.advance(1);
  // Back to the look it had; and the text may be sitting in the input box
  // unsent, so the next click asks first.
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: true, asksFirst: true, look: 'off',
    title: 'Ultracode is off. Click to switch it on (asks first).',
  });
  assert.equal(ULTRACODE_NOT_CONFIRMED, 'No confirmation seen');
  assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
  assert.equal(h.storage.has(ULTRA_KEY), false);
  assert.equal(h.inputs().ultracode, false);
  // The note does not stay for ever.
  await h.ticks(61);
  assert.equal(h.header().note, null);
});

test('browser: after "No confirmation seen" the next click asks first, until an Enter is typed there by hand', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  await h.advance(5000);
  assert.equal(h.sent.length, 2);
  h.knobs.confirmAnswer = false;
  await clickUltra(h);
  await h.advance(1000);
  assert.deepEqual(h.confirms, [ultracodeQuestion('on')]);
  assert.equal(h.sent.length, 2, 'not typed a second time onto the first');
  assert.equal(h.header().primaryOverride, false, 'Hand off is as it was');
  // He pressed Enter in the terminal: whatever was in the box has gone in.
  h.run(`handoffNoteTyped('${SID}', true)`);
  await h.tick();
  assert.equal(ultraHeader(h).asksFirst, false);

  // A refusal is the program answering, so the text did go in: no draft.
  const refused = await bootUltra(false);
  await clickUltra(refused);
  refused.knobs.rows = ['Ultracode isn\'t available on haiku'];
  await refused.advance(5000);
  assert.equal(refused.header().note, ULTRACODE_NO_MODEL);
  assert.equal(ultraHeader(refused).asksFirst, false);
});

test('browser: a screen that cannot be read is never a confirmation', async () => {
  const h = await bootUltra(false);
  h.run('window._openSessions = new Map()');
  await clickUltra(h);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode']]);
  // Readable by the time of the looks, with the line on it: still nothing,
  // because nobody counted before the text was typed.
  h.run(`window._openSessions = new Map([['${SID}', { terminal: __knobs.terminal }]])`);
  h.knobs.rows = [ON_LINE];
  await h.advance(5000);
  assert.equal(ultraHeader(h).look, 'off');
  assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
});

test('browser: a screen read as no rows, or one whose buffer throws, is not a count of zero', async () => {
  const reads = {
    'no rows at all': (h) => { h.knobs.rows = []; },
    'a terminal without a buffer': (h) => h.run(`window._openSessions = new Map([['${SID}', { terminal: { rows: 24 } }]])`),
    'a buffer that throws': (h) => h.run(`window._openSessions = new Map([['${SID}', { terminal: { rows: 24, buffer: { get active() { throw new Error('disposed'); } } } }]])`),
  };
  for (const [name, breakIt] of Object.entries(reads)) {
    const h = await bootUltra(false);
    breakIt(h);
    await clickUltra(h);
    // Readable again, with the line on it. Zero before would make this "more".
    h.run(`window._openSessions = new Map([['${SID}', { terminal: __knobs.terminal }]])`);
    h.knobs.rows = ['> /effort ultracode', ON_LINE];
    await h.advance(5000);
    assert.equal(ultraHeader(h).look, 'off', name);
    assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED, name);
    assert.equal(h.storage.has(ULTRA_KEY), false, name);
    assert.deepEqual(h.errors, [], name);
  }
});

test('browser: with the view scrolled up, the line printed below it still confirms the switch', async () => {
  const h = await bootUltra(false);
  h.knobs.scrollback = ['earlier output 1', 'earlier output 2', 'earlier output 3'];
  h.knobs.viewTop = 0;   // reading earlier output; the live screen is below
  await clickUltra(h);
  h.knobs.rows = ['> /effort ultracode', '  ' + ON_LINE];
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'on');
  assert.equal(h.header().note, null);
  assert.equal(JSON.parse(h.storage.get(ULTRA_KEY)).value, true);
});

test('browser: a line of an earlier switch that scrolls into view is not this switch\'s confirmation', async () => {
  const h = await bootUltra(false);
  // An "Ultracode on" from long ago is in the scrollback, out of view.
  h.knobs.scrollback = ['  ' + ON_LINE, 'older 2', 'older 3', 'older 4'];
  h.knobs.viewTop = 2;
  await clickUltra(h);
  // The program refuses, on the live screen; and the view moves to the old line.
  h.knobs.rows = ['> /effort ultracode', 'Ultracode needs dynamic workflows enabled (see /config) first'];
  h.knobs.viewTop = 0;
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'off');
  assert.equal(h.header().note, ULTRACODE_NO_WORKFLOWS);
  assert.equal(h.storage.has(ULTRA_KEY), false);
  assert.equal(bolt(h), null);

  // The same without a refusal: the old line in view settles nothing.
  const quiet = await bootUltra(false);
  quiet.knobs.scrollback = ['  ' + ON_LINE, 'older 2', 'older 3', 'older 4'];
  quiet.knobs.viewTop = 2;
  await clickUltra(quiet);
  quiet.knobs.viewTop = 0;
  await quiet.advance(5000);
  assert.equal(ultraHeader(quiet).look, 'off');
  assert.equal(quiet.header().note, ULTRACODE_NOT_CONFIRMED);
  assert.equal(quiet.storage.has(ULTRA_KEY), false);
});

test('browser: a refusal is the note, and the button goes back', async () => {
  const cases = [
    ['Ultracode needs dynamic workflows enabled (see /config) before it can be used.', ULTRACODE_NO_WORKFLOWS],
    ['Ultracode isn\'t available on claude-haiku. Pick another model.', ULTRACODE_NO_MODEL],
  ];
  for (const [line, reason] of cases) {
    const h = await bootUltra(false);
    await clickUltra(h);
    h.knobs.rows = ['> /effort ultracode', line];
    await h.advance(1000);
    assert.equal(ultraHeader(h).look, 'off', line);
    assert.equal(ultraHeader(h).label, 'Ultracode', line);
    assert.equal(h.header().note, reason);
    assert.equal(h.storage.has(ULTRA_KEY), false);
  }
});

test('browser: where Hand off asks first, so does this: the question names the text, and a yes waits, reads again, then types', async () => {
  const h = await bootUltra(true, { reloaded: true });
  assert.equal(h.header().primaryOverride, true);
  assert.equal(ultraHeader(h).asksFirst, true);
  assert.equal(ultraHeader(h).title, 'Ultracode is on. Click to switch it off (asks first).');
  await clickUltra(h);
  assert.deepEqual(h.confirms, [ultracodeQuestion('off')]);
  assert.deepEqual(h.confirmOptions.map((o) => ({ ...o })), [{ confirm: 'Type it' }]);
  assert.deepEqual(h.sent, [], 'nothing is typed in the same task as the yes');
  await h.advance(499);
  assert.deepEqual(h.sent, []);
  await h.advance(1);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode off']]);
  await h.advance(250);
  assert.deepEqual(h.sent[1], [SID, '\r']);
});

test('browser: a no, or an answer that is not exactly true, types nothing', async () => {
  const declined = await bootUltra(true, { reloaded: true });
  declined.knobs.confirmAnswer = false;
  await clickUltra(declined);
  await declined.advance(6000);
  assert.equal(declined.confirms.length, 1);
  assert.deepEqual(declined.sent, []);
  assert.equal(ultraHeader(declined).label, 'Ultracode');
  assert.equal(ultraHeader(declined).look, 'on');

  const answers = {
    'a truthy value that is not true': () => 'yes',
    'a rejection': () => Promise.reject(new Error('dialog failed')),
    'undefined': () => undefined,
  };
  for (const [name, answer] of Object.entries(answers)) {
    const h = await bootUltra(true, { reloaded: true });
    h.run('confirmDialog = ' + answer.toString());
    await clickUltra(h);
    await h.advance(6000);
    assert.deepEqual(h.sent, [], name);
  }
  const missing = await bootUltra(true, { reloaded: true });
  missing.run('confirmDialog = undefined');
  await clickUltra(missing);
  await missing.advance(6000);
  assert.deepEqual(missing.sent, [], 'dialogs.js did not load');
});

test('browser: a session that went busy while the question was open is not typed into', async () => {
  const h = await bootUltra(true, { reloaded: true });
  h.run(`confirmDialog = async () => { sessionBusyState.set('${SID}', true); return true; }`);
  await clickUltra(h);
  await h.advance(6000);
  assert.deepEqual(h.sent, []);
  assert.equal(ultraHeader(h).enabled, false);
  assert.equal(ultraHeader(h).title, 'Session is working');
  assert.equal(ultraHeader(h).label, 'Ultracode', 'not left saying it is switching');
});

test('browser: a value that changed while the question was open is not switched back', async () => {
  const h = await bootUltra(true, { reloaded: true });
  // The hook reports "off" while the box is open: the click was to switch off.
  h.run(`confirmDialog = async () => { __knobs.duringQuestion(); return true; }`);
  h.knobs.duringQuestion = () => h.setState(endedState(h, { ultracode: false }));
  await clickUltra(h);
  await h.advance(6000);
  assert.deepEqual(h.sent, []);
  assert.equal(ultraHeader(h).look, 'off');
});

test('browser: something typed by hand since the last turn, not ended with Enter, makes the click ask first', async () => {
  const h = await bootUltra(false);
  assert.equal(ultraHeader(h).asksFirst, false);
  h.run(`handoffNoteTyped('${SID}', false)`);
  assert.equal(JSON.stringify(h.inputs().typed), JSON.stringify({ atMs: h.now, enter: false }), 'the time and the flag, never the text');
  await h.tick();
  assert.equal(ultraHeader(h).asksFirst, true);
  assert.equal(h.header().primaryOverride, false, 'Hand off does not have the rule');
  h.knobs.confirmAnswer = false;
  await clickUltra(h);
  await h.advance(1000);
  assert.deepEqual(h.confirms, [ultracodeQuestion('on')]);
  assert.deepEqual(h.sent, []);
  // The last of it was Enter: no draft.
  h.run(`handoffNoteTyped('${SID}', true)`);
  await h.tick();
  assert.equal(ultraHeader(h).asksFirst, false);
  // An id that is not one is ignored, and nothing throws.
  h.run(`handoffNoteTyped('../x', false); handoffNoteTyped(null, false)`);
  assert.deepEqual(h.errors, []);
});

test('browser: the draft is asked about even when the click comes before the header has caught up', async () => {
  const h = await bootUltra(false);
  h.run(`handoffNoteTyped('${SID}', false)`);
  // No tick: the button still looks plain. The click decides afresh.
  assert.equal(ultraHeader(h).asksFirst, false);
  h.knobs.confirmAnswer = false;
  await clickUltra(h);
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.sent, []);
});

test('browser: the hook\'s next report takes over from the confirmation', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  h.knobs.rows = [ON_LINE];
  await h.advance(1000);
  assert.equal(h.inputs().ultracodeValue, true);
  // The next prompt: the hook scans before the transcript holds the switch,
  // and still says off. The button and the row do not go back for that turn.
  await h.advance(5000);
  h.setState(endedState(h, { ultracode: false, last_prompt_at: h.sec }));
  await h.refresh();
  assert.equal(h.inputs().ultracodeValue, true);
  // The turn ends: the hook has looked again and says so itself...
  await h.advance(5000);
  h.setState(endedState(h, { ultracode: true, last_prompt_at: h.sec - 3, last_stop_at: h.sec }));
  await h.refresh();
  assert.equal(h.inputs().ultracodeValue, true);
  // ...and when it reports "off" (switched by hand in the terminal), that wins.
  await h.advance(5000);
  h.setState(endedState(h, { ultracode: false, last_prompt_at: h.sec - 3, last_stop_at: h.sec }));
  await h.refresh();
  assert.equal(h.inputs().ultracodeValue, false);
  assert.equal(ultraHeader(h).look, 'off');
});

test('browser: the confirmation survives a reload of the window, and follows the session through a fork', async () => {
  const storage = new Map();
  const first = await bootUltra(false, { storage });
  await clickUltra(first);
  first.knobs.rows = [ON_LINE];
  await first.advance(1000);
  assert.equal(storage.has(ULTRA_KEY), true);

  // The same window, loaded again a little later: the hook still says off.
  const second = await bootUltra(false, { storage, startMs: first.now + 5000 });
  assert.equal(second.inputs().ultracodeValue, true);
  assert.equal(ultraHeader(second).look, 'on');

  second.run(`activePtyIds = new Set(['${NEW_SID}']); activeSessionId = '${NEW_SID}';`);
  second.listeners.fork(SID, NEW_SID);
  await flush();
  assert.equal(storage.has(ULTRA_KEY), false);
  assert.equal(JSON.parse(storage.get('handoff-ultracode:' + NEW_SID)).value, true);
});

test('browser: Continue in new session passes on the value the button shows, not the hook\'s older one', async () => {
  const storage = new Map([[ULTRA_KEY, JSON.stringify({ value: true, atMs: 2000000000 - 1000 })]]);
  const h = boot({ storage });
  h.setSidecar(VM_SIDECAR);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h, { ultracode: false }));
  h.busyEvent(false);
  await h.refresh();
  assert.equal(h.header().primary, 'Continue in new session (ultracode)');
  await h.click('primary');
  assert.equal(JSON.parse(h.launches[0]).options.effort, 'ultracode');

  // And the other way round: switched off here, the hook still says on.
  const off = boot({ storage: new Map([[ULTRA_KEY, JSON.stringify({ value: false, atMs: 2000000000 - 1000 })]]) });
  off.setSidecar(VM_SIDECAR);
  off.setHandoffFile(true);
  off.setState(writtenVmState(off, { ultracode: true }));
  off.busyEvent(false);
  await off.refresh();
  assert.equal(off.header().primary, 'Continue in new session');
  await off.click('primary');
  assert.equal('effort' in JSON.parse(off.launches[0]).options, false);
});

// ── the bolt on a session row ──────────────────────────────────────────────

const bolt = (h, id = SID) => JSON.parse(h.run(`JSON.stringify(handoffBoltState('${id}'))`));

test('browser: a running session with ultracode on has the bolt; every other row has nothing', async () => {
  const on = await bootUltra(true);
  assert.deepEqual(bolt(on), { html: '<svg data-bolt="11"></svg>', title: 'Ultracode is on' });
  assert.equal(bolt(await bootUltra(false)), null);
  assert.equal(bolt(await bootUltra(undefined)), null, 'not known is quiet on a row');
  assert.equal(bolt(on, NEW_SID), null, 'a session this file has read nothing for');

  on.run('activePtyIds = new Set()');
  assert.equal(bolt(on), null, 'not running');
  const terminal = await bootUltra(true);
  terminal.run(`sessionMap.get('${SID}').type = 'terminal'`);
  assert.equal(bolt(terminal), null);
  // icons.js did not load: no bolt, and no error.
  const noIcons = await bootUltra(true);
  noIcons.run('window.ICONS = undefined');
  assert.equal(bolt(noIcons), null);
  assert.deepEqual(noIcons.errors, []);
});

test('browser: the rows on screen get the bolt in the same pass as the chip, and lose it when ultracode goes off', async () => {
  const h = await bootUltra(false);
  const chipEl = fakeElement('span', {});
  const boltEl = fakeElement('span', {});
  boltEl.innerHTML = '';
  const selectors = [];
  h.knobs.rowEls = (selector) => {
    selectors.push(selector);
    return selector.endsWith('.handoff-bolt') ? [boltEl] : [chipEl];
  };
  h.run('document.querySelectorAll = (selector) => __knobs.rowEls(selector)');
  await h.refresh();
  assert.equal(chipEl.textContent, '412K');
  assert.equal(boltEl.innerHTML, '');
  assert.equal(boltEl.hasAttribute('title'), false);
  // Both tabs' rows carry data-session-id; the chip is the Sessions tab's.
  assert.ok(selectors.includes(`[data-session-id="${SID}"] .handoff-bolt`));
  assert.ok(selectors.includes(`.session-item[data-session-id="${SID}"] .handoff-chip`));

  // Switched on from the header: the row follows at the confirmation, with no
  // read of the hook's files in between.
  await clickUltra(h);
  h.knobs.rows = [ON_LINE];
  await h.advance(1000);
  assert.equal(boltEl.innerHTML, '<svg data-bolt="11"></svg>');
  assert.equal(boltEl.getAttribute('title'), 'Ultracode is on');

  // The browser hands innerHTML back re-spelled: it is not written again.
  boltEl.innerHTML = '<svg data-bolt="11"/>';
  await h.refresh();
  assert.equal(boltEl.innerHTML, '<svg data-bolt="11"/>');

  await h.advance(5000);
  h.setState(endedState(h, { ultracode: false, last_stop_at: h.sec }));
  await h.refresh();
  assert.equal(boltEl.innerHTML, '');
  assert.equal(boltEl.hasAttribute('title'), false);
});

// ── the stale reading in the browser half ──────────────────────────────────

const clockOf = (seconds) => {
  const date = new Date(seconds * 1000);
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
};
const STALE_TITLE = staleTitle(clockOf(VM_SIDECAR.ts));

function meterLook(h) {
  const meter = h.byId['handoff-meter'];
  return { stale: meter.className === 'handoff-stale', text: meter.children[0].textContent, title: meter.children[0].getAttribute('title') };
}

test('browser: without a watched turn nothing is marked, however old the reading is', async () => {
  // The window has only seen the session go idle (a reload mid-turn).
  const h = await bootEnded();
  await h.ticks(30);
  await h.refresh();
  const look = meterLook(h);
  assert.equal(look.stale, false);
  assert.ok(look.title.startsWith('Context in use: '));
  assert.equal(JSON.parse(h.run(`JSON.stringify(handoffChipState('${SID}'))`)).stale, undefined);
});

test('browser: a turn watched from busy to idle with files that did not move marks the meter and the chip; a reading that moves clears it', async () => {
  const h = await bootEnded();
  const chipEl = fakeElement('span', {});
  h.knobs.rowEls = (selector) => (selector.endsWith('.handoff-chip') ? [chipEl] : []);
  h.run('document.querySelectorAll = (selector) => __knobs.rowEls(selector)');
  const before = meterLook(h).text;

  // What a terminal looks like after /clear: the session works and stops, and
  // the files of the id it is filed under stay as they were.
  h.busyEvent(true);
  await h.advance(20000);
  h.busyEvent(false);
  await h.advance(2000);
  await h.tick();
  assert.equal(meterLook(h).stale, false, 'not before the read three seconds after the turn ended');
  await h.advance(1000);
  let look = meterLook(h);
  assert.equal(look.stale, true);
  assert.equal(look.text, before, 'the number stays');
  assert.equal(look.title, STALE_TITLE);
  assert.equal(chipEl.textContent, '412K');
  assert.equal(chipEl.className, 'handoff-chip handoff-danger handoff-stale');
  assert.equal(chipEl.getAttribute('title'), STALE_TITLE);
  assert.deepEqual(JSON.parse(h.run(`JSON.stringify(handoffChipState('${SID}'))`)),
    { text: '412K', level: 'danger', title: STALE_TITLE, stale: true });

  // It stays through the next turn...
  h.busyEvent(true);
  await h.advance(3000);
  await h.tick();
  assert.equal(meterLook(h).stale, true);
  h.busyEvent(false);
  await h.advance(4000);
  assert.equal(meterLook(h).stale, true);

  // ...and goes as soon as the reading moves.
  h.setSidecar({ ...VM_SIDECAR, total_input_tokens: 85000, used_percentage: 8, ts: h.sec });
  await h.refresh();
  look = meterLook(h);
  assert.equal(look.stale, false);
  assert.ok(look.title.startsWith('Context in use: 85K'));
  assert.equal(chipEl.className, 'handoff-chip');
  assert.equal(chipEl.textContent, '85K');
  assert.deepEqual(h.errors, []);
});

test('browser: an ordinary turn, whose files move, is never marked', async () => {
  const h = await bootEnded();
  h.busyEvent(true);
  await h.advance(20000);
  // The status line wrote during the turn and the hook stamped its Stop, a
  // second before the title went idle: both are later than the turn's START,
  // which is what they are compared with, and earlier than its end.
  h.setSidecar({ ...VM_SIDECAR, ts: h.sec - 1 });
  h.setState(endedState(h, { last_prompt_at: h.sec - 20, last_stop_at: h.sec }));
  await h.advance(1000);
  h.busyEvent(false);
  await h.advance(5000);
  await h.tick();
  assert.equal(meterLook(h).stale, false);
  // The hook stamped the turn but the reading did not move: the hook is alive
  // for this id, so this is not the /clear case either.
  h.busyEvent(true);
  await h.advance(20000);
  h.setState(endedState(h, { last_prompt_at: h.sec - 20, last_stop_at: h.sec }));
  await h.advance(1000);
  h.busyEvent(false);
  await h.advance(5000);
  await h.tick();
  assert.equal(meterLook(h).stale, false);
});

test('browser: a session that stops at a permission prompt mid-turn is not marked: the hook says a turn is running', async () => {
  const h = await bootEnded();
  // The prompt hook stamps a moment BEFORE the spinner comes on, and nothing
  // else is written before the session stops to ask.
  await h.advance(10000);
  h.setState(endedState(h, { last_prompt_at: h.sec - 0.3 }));
  h.busyEvent(true);
  await h.advance(2000);
  h.busyEvent(false);
  await h.advance(5000);
  await h.tick();
  assert.equal(meterLook(h).stale, false);
  assert.equal(JSON.parse(h.run(`JSON.stringify(handoffChipState('${SID}'))`)).stale, undefined);
  // Answered, it works on and stops to ask again: still the same turn.
  h.busyEvent(true);
  await h.advance(30000);
  h.busyEvent(false);
  await h.advance(5000);
  await h.tick();
  assert.equal(meterLook(h).stale, false);
});

test('staleReading: nothing is marked while the hook\'s own markers say a turn is running', () => {
  const busySec = TURN.busyAtMs / 1000;
  // The prompt was stamped 0.3 s before the busy event and no Stop followed.
  assert.equal(staleReading(staleArgs({ state: hookState({ last_prompt_at: busySec - 0.3, last_stop_at: busySec - 60 }) })), null);
  assert.equal(staleReading(staleArgs({ state: hookState({ last_prompt_at: busySec - 500, last_stop_at: null }) })), null);
  // The Stop is the later of the two: the turn ended, and nothing moved since.
  assert.notEqual(staleReading(staleArgs({ state: hookState({ last_prompt_at: busySec - 500, last_stop_at: busySec - 400 }) })), null);
  // An older hook writes neither marker: the reading alone decides.
  assert.notEqual(staleReading(staleArgs({ state: oldHookState() })), null);
});

// ── where the draft rule hears about typing: terminal-manager.js ───────────

const TERMINAL_MANAGER = path.join(__dirname, '..', 'public', 'terminal-manager.js');

test('terminal-manager: what is typed by hand is passed on as "ended in Enter or not", never as text', () => {
  const { noteTypedByHand } = require('../public/terminal-manager');
  const seen = [];
  global.handoffNoteTyped = (...args) => { seen.push(args); };
  try {
    noteTypedByHand('s1', 'a');
    noteTypedByHand('s1', '\r');
    noteTypedByHand('s1', 'pasted line\r');
    noteTypedByHand('s1', '\x1b[200~pasted\r\x1b[201~');
    noteTypedByHand('s1', '\x1b[13;2u');
    noteTypedByHand('s1', undefined);
    assert.deepEqual(seen, [['s1', false], ['s1', true], ['s1', true], ['s1', false], ['s1', false], ['s1', false]]);
    // A hand-off file that throws must never cost the keystroke.
    global.handoffNoteTyped = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => noteTypedByHand('s1', 'a'));
  } finally {
    delete global.handoffNoteTyped;
  }
  // ctx-handoff.js did not load: nothing to tell, nothing thrown.
  assert.doesNotThrow(() => noteTypedByHand('s1', 'a'));
});

test('terminal-manager: every send of hand-typed input is noted first, with the same session and data', () => {
  const lines = fs.readFileSync(TERMINAL_MANAGER, 'utf8').split(/\r?\n/);
  let sends = 0;
  lines.forEach((line, index) => {
    const send = /^\s*window\.api\.sendInput\((.*)\);\s*$/.exec(line);
    if (!send) return;
    sends++;
    assert.equal(lines[index - 1].trim(), `noteTypedByHand(${send[1]});`, `terminal-manager.js:${index + 1}`);
  });
  // The terminal's own input, the two newline keys, Space, and a dropped file.
  assert.equal(sends, 5);
  assert.equal(lines.filter((line) => line.includes('sendInput(')).length, sends, 'a send in a spelling this scan does not read');
});

// ── the click: whether the text goes in, and where ─────────────────────────

test('browser: with the header off (grid view, a task log in the pane) a click types nothing', async () => {
  const offs = { 'grid view': 'gridViewActive = true', 'a task log': 'activeTaskView = { id: 7 }' };
  for (const [name, js] of Object.entries(offs)) {
    for (const reloaded of [false, true]) {
      const h = await bootUltra(true, { reloaded });
      // No render in between: the button is still on screen, as it is from the
      // view changing until the next tick. The header may name another session
      // than the active one there.
      h.run(js);
      await clickUltra(h);
      await h.advance(6000);
      assert.deepEqual(h.sent, [], name);
      assert.equal(h.confirms.length, 0, name);
    }
  }
});

test('browser: another session took the pane while the question was open: nothing is typed into the one it was asked about', async () => {
  const h = await bootUltra(true, { reloaded: true });
  h.run(`confirmDialog = async () => { activeSessionId = '${NEW_SID}'; return true; }`);
  await clickUltra(h);
  await h.advance(6000);
  assert.deepEqual(h.sent, []);
});

test('browser: a fork between the text and its Enter sends the Enter to the session\'s new id', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode']]);
  await h.advance(100);
  h.run(`activePtyIds = new Set(['${NEW_SID}']); activeSessionId = '${NEW_SID}';`);
  h.listeners.fork(SID, NEW_SID);
  await flush();
  await h.advance(150);
  assert.deepEqual(h.sent.slice(1), [[NEW_SID, '\r']]);
});

test('browser: once a switch is settled the later looks leave it alone', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  h.knobs.rows = ['> /effort ultracode', '  ' + ON_LINE];
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'on');
  // By the last look the line has gone off the top of the screen.
  h.knobs.rows = ['a long answer', 'that pushed it off'];
  await h.advance(5000);
  assert.equal(ultraHeader(h).look, 'on');
  assert.equal(ultraHeader(h).asksFirst, false);
  assert.equal(h.header().note, null);
  assert.equal(JSON.parse(h.storage.get(ULTRA_KEY)).value, true);
});

test('browser: the screen is counted before the text goes in, so a line that is there straight after it is new', async () => {
  const h = await bootUltra(false);
  h.knobs.onSend = (data) => {
    if (data === ULTRACODE_TEXT.on) h.knobs.rows = ['> /effort ultracode', '  ' + ON_LINE];
  };
  h.run(`{
    const send = window.api.sendInput;
    window.api.sendInput = (id, data) => { __knobs.onSend(data); send(id, data); };
  }`);
  await clickUltra(h);
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'on');
});

test('browser: Hand off types nothing while a switch is on its way in', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  await h.advance(100);
  // Between the text and its Enter: a request line now would be sent joined to it.
  await h.click('primary');
  await h.advance(400);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode'], [SID, '\r']], 'one line and one Enter');
  assert.equal(h.request().phase, 'idle');
  // Still waiting for the terminal's line: still nothing.
  await h.click('primary');
  assert.equal(h.sent.length, 2);
  // Settled: Hand off types as it always did.
  h.knobs.rows = ['  ' + ON_LINE];
  await h.advance(600);
  assert.equal(ultraHeader(h).look, 'on');
  await h.click('primary');
  assert.deepEqual(h.sent[2], [SID, REQUEST_LINE]);
  assert.equal(h.confirms.length, 0);
});

// ── the draft: typed ahead, and across a reload ────────────────────────────

const { parseStoredTyped } = require(MODULE_PATH);
const TYPED_KEY = 'handoff-typed:' + SID;

test('browser: text typed ahead while the session worked is still there when the turn ends: the click asks first', async () => {
  const h = await bootUltra(false);
  // He sends a prompt, and while the session works types the start of the next.
  h.run(`handoffNoteTyped('${SID}', true)`);
  h.busyEvent(true);
  await h.advance(5000);
  h.run(`handoffNoteTyped('${SID}', false)`);
  await h.advance(5000);
  // The turn ends: a Stop LATER than the typing, then the idle event.
  h.setState(endedState(h, { ultracode: false, last_prompt_at: h.sec - 10, last_stop_at: h.sec }));
  h.busyEvent(false);
  await h.refresh();
  assert.equal(h.header().primaryOverride, false, 'the gate itself is plain');
  assert.equal(ultraHeader(h).asksFirst, true);
  assert.equal(ultraHeader(h).title, 'Ultracode is off. Click to switch it on (asks first).');
  h.knobs.confirmAnswer = false;
  await clickUltra(h);
  await h.advance(6000);
  assert.deepEqual(h.confirms, [ultracodeQuestion('on')]);
  assert.deepEqual(h.sent, [], 'not typed onto the end of the half-written prompt');
});

test('browser: handoffNoteTyped keeps a time and a boolean, whatever it is handed', async () => {
  const h = await bootUltra(false);
  for (const given of ['\'the text itself\'', '1', '{}', 'undefined']) {
    h.run(`handoffNoteTyped('${SID}', ${given})`);
    assert.deepEqual(h.inputs().typed, { atMs: h.now, enter: false }, given);
  }
  h.run(`handoffNoteTyped('${SID}', true)`);
  assert.deepEqual(h.inputs().typed, { atMs: h.now, enter: true });
  assert.equal([...h.storage.values()].some((value) => value.includes('text itself')), false);
});

test('parseStoredTyped: a stored draft comes back as "not ended in Enter", and nothing else comes back at all', () => {
  assert.deepEqual(parseStoredTyped(JSON.stringify({ atMs: 5000 })), { atMs: 5000, enter: false });
  assert.deepEqual(parseStoredTyped(JSON.stringify({ atMs: 5000, enter: true, text: 'x' })), { atMs: 5000, enter: false });
  const bad = [null, undefined, '', 'not json', 'null', '7', '[]', '{}', JSON.stringify({ atMs: 0 }), JSON.stringify({ atMs: '5' })];
  for (const text of bad) assert.equal(parseStoredTyped(text), null, String(text));
});

test('browser: a draft is remembered across a reload of the window, where main\'s busy flag makes the click plain', async () => {
  const storage = new Map();
  const first = await bootUltra(false, { storage, readCtxState: true });
  first.run(`handoffNoteTyped('${SID}', false)`);
  assert.deepEqual(JSON.parse(storage.get(TYPED_KEY)), { atMs: first.now }, 'the time, and never the text');

  // The same window, loaded again: no busy event yet, but main says "not busy",
  // so the gate asks nothing. The text is still in the input box.
  const second = await bootUltra(false, { storage, readCtxState: true, reloaded: true, startMs: first.now + 5000 });
  assert.equal(second.inputs().busyKnown, true);
  assert.equal(second.header().primaryOverride, false);
  assert.deepEqual(second.inputs().typed, { atMs: first.now, enter: false });
  assert.equal(ultraHeader(second).asksFirst, true);
  second.knobs.confirmAnswer = false;
  await clickUltra(second);
  await second.advance(1000);
  assert.equal(second.confirms.length, 1);
  assert.deepEqual(second.sent, []);

  // Enter typed by hand: no draft, and nothing left behind for the next reload.
  second.run(`handoffNoteTyped('${SID}', true)`);
  assert.equal(storage.has(TYPED_KEY), false);
  const third = await bootUltra(false, { storage, readCtxState: true, reloaded: true, startMs: second.now + 5000 });
  assert.equal(third.inputs().typed, null);
  assert.equal(ultraHeader(third).asksFirst, false);
});

test('browser: the draft is written to storage when it starts and when its Enter comes, not on every key', async () => {
  const h = await bootUltra(false);
  const writes = [];
  h.knobs.wrote = (what) => writes.push(what);
  h.run(`{
    const { setItem, removeItem } = sessionStorage;
    sessionStorage.setItem = (key, value) => { __knobs.wrote('set ' + key); setItem(key, value); };
    sessionStorage.removeItem = (key) => { __knobs.wrote('remove ' + key); removeItem(key); };
  }`);
  for (let key = 0; key < 20; key++) {
    await h.advance(50);
    h.run(`handoffNoteTyped('${SID}', false)`);
  }
  assert.deepEqual(writes, ['set ' + TYPED_KEY]);
  assert.equal(h.inputs().typed.atMs, h.now, 'the time in memory follows every key');
  h.run(`handoffNoteTyped('${SID}', true); handoffNoteTyped('${SID}', true)`);
  assert.deepEqual(writes, ['set ' + TYPED_KEY, 'remove ' + TYPED_KEY]);
});

test('browser: a fork takes the draft with the session', async () => {
  const h = await bootUltra(false);
  h.run(`handoffNoteTyped('${SID}', false)`);
  h.run(`activePtyIds = new Set(['${NEW_SID}']); activeSessionId = '${NEW_SID}';`);
  h.listeners.fork(SID, NEW_SID);
  await flush();
  assert.equal(h.storage.has(TYPED_KEY), false);
  assert.equal(h.storage.has('handoff-typed:' + NEW_SID), true);
});

// ── a session's first turn ─────────────────────────────────────────────────

test('ultracodeValue: before the first Stop a scan that found no switch is "not known", not off', () => {
  // A session started in ultracode gets its switch record after the hook's
  // scan at its first prompt: "off" there would be a guess, for a whole turn.
  assert.equal(ultracodeValue(hookState({ ultracode: null, ultra_scan: SCANNED, last_stop_at: null }), null), null);
  assert.equal(ultracodeValue(oldHookState({ ultracode: null, ultra_scan: SCANNED }), null), null);
  // What the hook says outright is believed at once, and so is a confirmation.
  assert.equal(ultracodeValue(hookState({ ultracode: true, ultra_scan: SCANNED, last_stop_at: null }), null), true);
  assert.equal(ultracodeValue(hookState({ ultracode: null, ultra_scan: SCANNED, last_stop_at: null }), { value: true, atMs: 5 }), true);
  // Once a turn has ended the same scan is the hook saying off.
  assert.equal(ultracodeValue(hookState({ ultracode: null, ultra_scan: SCANNED }), null), false);
});

test('browser: during a session\'s first turn the button gives no direction and the row no bolt', async () => {
  const h = await bootUltra(undefined);
  h.setState(endedState(h, { ultracode: null, ultra_scan: SCANNED, last_stop_at: null }));
  await h.advance(500);
  await h.refresh();
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: false, asksFirst: false, look: 'unknown', title: ULTRACODE_UNKNOWN_TITLE,
  });
  assert.equal(bolt(h), null);
});

// ── the rows as the two tabs build them ────────────────────────────────────
//
// The sidebar rebuilds its rows on every render, so the builders are what
// shows the chip and the bolt most of the time; handoffPaintChips only fills
// in between renders. The two must write the same thing or the row flickers.
// The builders' own lines are taken from the shipped files and run here.

const SIDEBAR_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'sidebar.js'), 'utf8');
const PROJECTS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'projects-view.js'), 'utf8');

function shippedBlock(source, pattern, what) {
  const found = pattern.exec(source);
  assert.ok(found, what + ' is not where this test looks for it');
  return found[0];
}

// buildSessionItem's two guarded blocks, run against a meta line of our own.
function builtSidebarRow(h) {
  const code = shippedBlock(SIDEBAR_SOURCE, /\n  try \{\n    const handoffChip = [\s\S]*?\n  \} catch \{\}\n/, 'the chip block of buildSessionItem')
    + shippedBlock(SIDEBAR_SOURCE, /\n  try \{\n    const boltEl = [\s\S]*?\n  \} catch \{\}\n/, 'the bolt block of buildSessionItem');
  const metaEl = fakeElement('div', {});
  const shortIdEl = fakeElement('span', {});
  metaEl.append(shortIdEl);
  h.knobs.row = { metaEl, shortIdEl, session: { sessionId: SID } };
  h.run(`(function ({ metaEl, shortIdEl, session }) {${code}})(__knobs.row)`);
  assert.equal(metaEl.children.length, 3, 'the chip, the bolt, the short id');
  const [chipEl, boltEl] = metaEl.children;
  return {
    chip: { className: chipEl.className, text: chipEl.textContent, title: chipEl.title || null },
    bolt: { className: boltEl.className, html: boltEl.innerHTML || '', title: boltEl.title || null },
  };
}

// What handoffPaintChips leaves on the same two spans when it finds them empty.
function paintedRow(h) {
  const chipEl = fakeElement('span', {});
  chipEl.className = 'handoff-chip';
  const boltEl = fakeElement('span', {});
  boltEl.className = 'handoff-bolt';
  h.knobs.rowEls = (selector) => (selector.endsWith('.handoff-bolt') ? [boltEl] : [chipEl]);
  h.run(`document.querySelectorAll = (selector) => __knobs.rowEls(selector); handoffPaintChips('${SID}')`);
  return {
    chip: { className: chipEl.className, text: chipEl.textContent, title: chipEl.getAttribute('title') },
    bolt: { className: boltEl.className, html: boltEl.innerHTML || '', title: boltEl.getAttribute('title') },
  };
}

test('sidebar.js: the row it builds carries exactly what the painter writes: the chip, its stale look, the bolt', async () => {
  // Ultracode on and a reading that has stopped moving: every class at once.
  const h = await bootUltra(true);
  h.busyEvent(true);
  await h.advance(20000);
  h.busyEvent(false);
  await h.advance(3000);
  const built = builtSidebarRow(h);
  assert.deepEqual(built, paintedRow(h));
  assert.deepEqual(built, {
    chip: { className: 'handoff-chip handoff-danger handoff-stale', text: '412K', title: STALE_TITLE },
    bolt: { className: 'handoff-bolt', html: '<svg data-bolt="11"></svg>', title: 'Ultracode is on' },
  });

  // Nothing to say: both spans are there and empty, for the painter to fill.
  const quiet = await bootUltra(false);
  quiet.run('activePtyIds = new Set()');
  const empty = builtSidebarRow(quiet);
  assert.deepEqual(empty, paintedRow(quiet));
  assert.deepEqual(empty, {
    chip: { className: 'handoff-chip', text: '', title: null },
    bolt: { className: 'handoff-bolt', html: '', title: null },
  });

  // ctx-handoff.js did not load: the row is built all the same.
  const bare = boot();
  bare.run('handoffChipState = undefined; handoffBoltState = undefined;');
  assert.deepEqual(builtSidebarRow(bare), empty);
});

// The bolt's two lines of buildSessionRow, with the names that function has
// in scope there: `id` is the session's, the others are ids of something else.
function builtProjectsBolt(h) {
  const code = shippedBlock(PROJECTS_SOURCE,
    /\n  const bolt = typeof handoffBoltState === 'function' \? [^\n]*\n  parts\.push\(`<span class="handoff-bolt"[^\n]*\n/,
    'the bolt lines of buildSessionRow');
  h.knobs.row = { id: SID, session: { sessionId: SID, id: NEW_SID, projectId: 'p1' }, project: { id: 'p1' }, parts: [] };
  h.run(`(function ({ id, session, project, parts }) {
    const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    ${code}
  })(__knobs.row)`);
  return h.knobs.row.parts;
}

test('projects-view.js: its row carries the bolt span the painter fills, for the session\'s own id', async () => {
  const h = await bootUltra(true);
  const painted = paintedRow(h).bolt;
  assert.equal(painted.html, '<svg data-bolt="11"></svg>');
  assert.deepEqual(builtProjectsBolt(h), [`<span class="handoff-bolt" title="${painted.title}">${painted.html}</span>`]);
  const off = await bootUltra(false);
  assert.deepEqual(builtProjectsBolt(off), ['<span class="handoff-bolt"></span>']);
  // The painter finds that span through the row's data-session-id.
  assert.match(PROJECTS_SOURCE, /\n  const id = session\.sessionId;\n[\s\S]*?\n  row\.dataset\.sessionId = id;\n/);
});
