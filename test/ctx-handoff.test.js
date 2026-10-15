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
    // What the session's screen shows. Without it every click asks first.
    screen: { state: 'empty', why: 'the fixture: an empty prompt' },
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
    'REQUEST_LINE', 'OVERRIDE_TITLE', 'OVERRIDE_TITLE_UNSEEN', 'HANDOFF_NOT_LANDED', 'HANDOFF_NOT_WRITTEN', 'HANDOFF_SESSION_ENDED',
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
    ['busy', { busy: true, lastBusyAtMs: STOP_MS + 1 }, WHY_BUSY],
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
    ['busy', { busy: true, state: hookState({ last_prompt_at: 1020 }) }, WHY_BUSY],
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

// Every case here is a turn that has not ended. A busy session whose turn has ended goes by the screen (part M, the 'typingGate: busy, turn ended' tests).
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
    ['busy', { busy: true, lastBusyAtMs: STOP_MS + 1 }, WHY_BUSY],
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
    'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read C:/Users/jhack/AppData/Local/claude-ctx/handoffs/abc.md in full before doing anything else, then continue'
  );
});

test('continuePrompt: a forward-slash path is left alone', () => {
  assert.equal(
    continuePrompt('C:/Users/jhack/AppData/Local/claude-ctx/handoffs/abc.md'),
    'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read C:/Users/jhack/AppData/Local/claude-ctx/handoffs/abc.md in full before doing anything else, then continue'
  );
});

test('continuePrompt: mixed slashes and spaces, every backslash converted', () => {
  const out = continuePrompt('C:\\Users\\Some One/AppData\\Local/claude-ctx\\h.md');
  assert.equal(out, 'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read C:/Users/Some One/AppData/Local/claude-ctx/h.md in full before doing anything else, then continue');
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
// public/prompt-screen.js is not there yet. The ready-state fix adds it (the
// rules that read Claude Code's screen), loaded before ctx-handoff.js in
// index.html. boot runs it from the day the file exists, as the page will, so
// that fix has no line of this shared boot to change. null = no such file.
const PROMPT_SCREEN_FILE = path.join(__dirname, '..', 'public', 'prompt-screen.js');
const PROMPT_SCREEN_SOURCE = fs.existsSync(PROMPT_SCREEN_FILE) ? fs.readFileSync(PROMPT_SCREEN_FILE, 'utf8') : null;
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

// The screen every boot's terminal starts with: Claude Code 2.1.289 waiting at
// an empty prompt after a short turn, rebuilt row for row from a recording of
// the real program in xterm.js (55 rows by 146 columns, nothing scrolled off,
// cursor on row 51). The input box is the pointer row between two rule rows;
// the program puts a no-break space after the pointer, and nothing else while
// the box is empty. The prompt echoed in the conversation starts with the same
// pointer, and the two rows under the box are the status lines. Only the
// folder in the banner is not the recording's.
const PROMPT_POINTER = '\u276f';                      // "❯"
const PROMPT_BOX_EMPTY = PROMPT_POINTER + '\u00a0';   // the input box with nothing typed
const PROMPT_COLS = 146;
const PROMPT_RULE = '\u2500'.repeat(PROMPT_COLS);     // "─" from edge to edge
const PROMPT_CURSOR_ROW = 51;

function emptyPromptScreen() {
  const rows = new Array(55).fill('');
  rows[1] = ' \u2590\u259b\u2588\u2588\u2588\u259b\u2588   Claude Code v2.1.289';
  rows[2] = '\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u2588\u2580  Opus 5.5 with xhigh effort \u00b7 Claude Max';
  rows[3] = ' \u259d\u259d   \u259d\u259d   C:\\proj';
  rows[6] = (PROMPT_POINTER + ' Reply with the single word ok').padEnd(PROMPT_COLS);
  rows[8] = '\u25cf ok';
  rows[10] = '\u273b Worked for 6s \u00b7 done 6:38 AM';
  rows[50] = PROMPT_RULE;
  rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY;
  rows[52] = PROMPT_RULE;
  rows[53] = '  Opus 5.5\u00b7xhigh \u00b7 ctx 50K/1M 5% ' + '\u2591'.repeat(10);
  rows[54] = '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 2 agents';
  return rows;
}

// ── added with the screen check (ready state, commit 2) ────────────────────
const { gateText, chooseHeaderNote } = require(MODULE_PATH);
// The two asks-first reasons of today. Both carry the prefix REASON_: this file already has a top-level
// `const NOT_ENDED` (a table of cases, further up), and a second declaration of that name stops the file from loading.
const REASON_NOT_ENDED = 'This session has not reported the end of its turn';
const REASON_NOT_TOLD = 'This window has seen no busy or idle event for this session since it loaded';
const TEXT_IN_BOX = "There is text in this session's input box";
const NO_PROMPT = "Switchboard cannot see an empty prompt on this session's screen";
const ASKING = 'Session is asking you something';
const ASKING_TIP = 'Session is asking you something. Answer it in the terminal first.';
const DID_NOT_STOP_TIP = 'Session did not stop. It takes no typing. Press Stop to try once more.';
const SWITCH_WAIT = 'Waiting for the session to confirm the Ultracode switch';
const BOX_CANCEL_LINE = 'If the terminal is asking you something, cancel: the typed line could answer it.';
const BOX_SENT_LINE = 'If your own text is there, it is sent together with this line.';            // T1
const BOX_HELD_LINE = 'If your own text is there, the line is typed after it and is not sent.';    // B6, shown from task 08
const NOT_TYPED_CHANGED = 'Not typed. The session changed while the box was open.';
const scr = (state) => ({ state, why: 'test' });
// The one box's text: the reason, the question, the last line.
function boxText(reason, line, last = BOX_CANCEL_LINE) {
  return (reason ? reason + '.\n\n' : '') + 'Type "' + line + '" into this session anyway?\n\n' + last;
}
// The empty prompt with these lines in the conversation above it.
function promptScreenWith(lines) {
  const rows = emptyPromptScreen();
  lines.forEach((text, index) => { rows[12 + index] = text; });
  return rows;
}
// The recorded question (auto mode's offer): a panel above the box, the cursor below it.
function questionScreen() {
  const rows = emptyPromptScreen();
  rows[40] = PROMPT_RULE;
  rows[41] = '  Teach auto mode about your environment?';
  rows[43] = '  Auto mode works better when it knows your environment. Takes about a minute.';
  rows[45] = '  ' + PROMPT_POINTER + ' 1. Yes';
  rows[46] = '    2. Not now';
  rows[47] = "    3. Don't show again";
  rows[49] = '  Enter to confirm \u00b7 Esc to cancel';
  return rows;
}
function showQuestion(h) { h.knobs.rows = questionScreen(); h.knobs.cursorY = 53; }
function showEmptyPrompt(h) { h.knobs.rows = emptyPromptScreen(); h.knobs.cursorY = PROMPT_CURSOR_ROW; }
const titleOf = (h, id) => h.byId[id].getAttribute('title');

// opts: globals 'app' (default) | 'none' | 'tdz'; diagDir; storage (a Map
// shared between two boots = a reload of one window); startMs; readCtxState
// (true = window.api has the main-process call, answered by knobs.ctxReply);
// names (true = continue-name.js is loaded first, as in the app); localStorage
// (what window.localStorage is; shared between two boots = a restart).
// Also promptScreen (false = the page is loaded without
// public/prompt-screen.js, as when that file is missing; while there is no
// such file it changes nothing).
//
// With the app's globals the window has a terminal open for the session
// (fakeTerminal, further down), as app.js's window._openSessions gives it. Its
// screen is knobs.rows, which starts as emptyPromptScreen() with the cursor in
// the input box, and what the page types into the session shows up there.
let sourceOverride = null;   // the text boot runs in place of SOURCE (withHold)
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
    // The terminal's live screen, what has scrolled off its top, the first
    // buffer line in view (null = the live screen) and the row of the live
    // screen the cursor is on.
    rows: emptyPromptScreen(),
    scrollback: [],
    viewTop: null,
    cursorY: PROMPT_CURSOR_ROW,
  };
  knobs.terminal = fakeTerminal(knobs);
  // The far end of a write: the program draws what was typed on the screen of
  // the terminal this window has open for that session, when it has one.
  const typeInto = (id, data) => {
    const open = context.window._openSessions ? context.window._openSessions.get(id) : null;
    if (open && open.terminal && typeof open.terminal.fakeTyped === 'function') open.terminal.fakeTyped(data);
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
    sendInput: (id, data) => { sent.push([id, data]); typeInto(id, data); },
    onCliBusyState: (cb) => { listeners.busy = cb; },
    onProcessExited: (cb) => { listeners.exit = cb; },
    // A fork event as the window gets it: the script's own listener first
    // (index.html loads ctx-handoff.js before app.js), then what app.js's
    // listener does to the terminal this fake window has open: it goes with the
    // session to the new id (public/app.js:411-412).
    onSessionForked: (cb) => {
      listeners.fork = (oldId, newId, ...rest) => {
        const result = cb(oldId, newId, ...rest);
        const open = context.window._openSessions;
        if (open && open.has(oldId)) {
          const entry = open.get(oldId);
          open.delete(oldId);
          open.set(newId, entry);
        }
        return result;
      };
    },
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
  if (PROMPT_SCREEN_SOURCE !== null && opts.promptScreen !== false) run(PROMPT_SCREEN_SOURCE);
  run(sourceOverride || SOURCE);
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
      window._openSessions = new Map([['${SID}', { terminal: __knobs.terminal }]]);
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
  h.busyEvent(true);
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
  assert.deepEqual(h.confirms, [boxText(REASON_NOT_ENDED, REQUEST_LINE)]);
  assert.deepEqual(h.confirmOptions.map((o) => ({ ...o })), [{ confirm: 'Type it anyway' }]);
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
  assert.deepEqual(h.confirms, [boxText(REASON_NOT_TOLD, REQUEST_LINE)]);
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
  h.knobs.ctxReply = () => ctxReply(h, { busy: true, state: endedState(h, { last_prompt_at: h.sec - 10 }) });
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
  busy.knobs.ctxReply = () => mainReply(busy, { busy: true, state: endedState(busy, { last_prompt_at: busy.sec - 10 }) });
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
    options: { model: 'm', initialPrompt: 'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read C:/h/handoff.md in full before doing anything else, then continue' },
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
      initialPrompt: 'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read C:/h/handoff.md in full before doing anything else, then continue',
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
      options: { model: 'm', initialPrompt: 'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read C:/h/handoff.md in full before doing anything else, then continue' },
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
  typingGate, ultracodeValue, ultracodeModel, ultracodeScreen, ultracodeOutcome,
  parseStoredUltracode, staleReading, staleTitle,
} = require(MODULE_PATH);

const ON_LINE = 'Ultracode on (this session only): workflows may run. Effort stays high.';
const OLD_ON_LINE = 'Set effort level to ultracode (this session only): workflows may run';
const OFF_LINE = 'Ultracode off. Effort stays high.';

// Which of gateCases' combinations have a turn that ended (part M), from the
// fixtures' own numbers: a Stop at 1010 s that is after the prompt (hookState()
// and hookState({ last_prompt_at: null }); null, oldHookState() and the Stop at
// 900 s are not), no spinner after it (STOP_MS + 1 is after it, STOP_MS - 1 is
// not), and no line typed after it (STOP_MS + 5 is after it, STOP_MS - 5 is not).
// Busy refuses only where this is false.
const endedFor = (args) => !!args.state && args.state.last_stop_at === 1010
  && args.lastBusyAtMs !== STOP_MS + 1 && args.request.atMs !== STOP_MS + 5;
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
      assert.equal(gate.why, args.ownedElsewhere ? 'Shown in another window' : args.pendingRow ? 'Session is still starting' : args.busy === true && !endedFor(args) ? 'Session is working' : 'Session is not running');
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
  assert.deepEqual(typingGate(), { allowed: false, override: false, reason: 'Session is not running', advice: '', why: 'Session is not running', overrideTitle: OVERRIDE_TITLE });
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
    [{ busy: true, lastBusyAtMs: STOP_MS + 1 }, 'Session is working'],
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
    assert.equal(model.title, over.busyKnown === false
      ? 'Ultracode is on. This window has seen no busy or idle event for this session since it loaded. Click to switch it off anyway (asks first).'
      : 'Ultracode is on. This session has not reported the end of its turn. Click to switch it off anyway (asks first).');
  }
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
// knobs.scrollback what has gone off its top, knobs.viewTop the first buffer
// line in view (null = scrolled to the bottom, the live screen), and
// knobs.cursorY the row of the live screen the cursor is on (xterm.js counts
// cursorY from baseY, as it does here). boot makes one for every window.
//
// fakeTyped is not xterm.js: it is the far end of window.api.sendInput, what
// the program draws when a write reaches it. Text shows in the input box, after
// the pointer on the cursor row; a write that is only a carriage return is
// Enter, and empties the box. Nothing is drawn while the cursor is not on a row
// that starts with the pointer: on a screen with no input box under the cursor
// the fake does not guess. It does not wrap a long line, repeat the sent line
// in the conversation, or start a turn.
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
        return { baseY, viewportY: knobs.viewTop === null ? baseY : knobs.viewTop, cursorY: knobs.cursorY, getLine: lineAt };
      },
    },
    fakeTyped(data) {
      if (knobs.echo === false) return;
      const row = knobs.rows[knobs.cursorY];
      if (typeof row !== 'string' || !row.startsWith(PROMPT_POINTER)) return;
      knobs.rows[knobs.cursorY] = data === '\r' ? PROMPT_BOX_EMPTY : row + data;
    },
  };
}

// A session whose turn has ended, with the hook's ultracode value as given
// (undefined = the hook wrote no key), boot's terminal (its screen is
// h.knobs.rows), and the bolt icon. reloaded = this window has had no busy or
// idle event.
async function bootUltra(ultracode, { reloaded = false, storage, startMs, readCtxState } = {}) {
  const h = boot({ storage, startMs, readCtxState });
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

  h.knobs.rows = promptScreenWith(['> /effort ultracode', '  ' + ON_LINE]);
  await h.advance(999);
  assert.equal(ultraHeader(h).look, 'off', 'the first look is a second after the Enter');
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
  await h.advance(250);   // the Enter (B7): the looks count from it
  h.knobs.rows = promptScreenWith(['> /effort ultracode off', '  ' + OFF_LINE]);
  // Seen at the second look, not the first: the line came late.
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'off');
  assert.equal(h.inputs().ultracodeValue, false);
  assert.equal(ultraHeader(h).title, 'Ultracode is off. Click to switch it on.');
});

test('browser: a line that arrives late is still seen, up to the last look', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  await h.advance(250);   // the Enter (B7): the looks count from it
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
  h.knobs.rows = promptScreenWith(['  ' + ON_LINE, '> something else']);
  await clickUltra(h);
  await h.advance(250);   // the Enter (B7): the looks count from it
  await h.advance(4999);
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  assert.equal(h.header().note, null);
  await h.advance(1);
  // Back to the look it had.
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: true, asksFirst: false, look: 'off',
    title: 'Ultracode is off. Click to switch it on.',
  });
  assert.equal(ULTRACODE_NOT_CONFIRMED, 'No confirmation seen');
  assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
  assert.equal(h.storage.has(ULTRA_KEY), false);
  assert.equal(h.inputs().ultracode, false);
  // The note does not stay for ever.
  await h.ticks(61);
  assert.equal(h.header().note, null);
});

test('browser: a screen that cannot be read is never a confirmation', async () => {
  const h = await bootUltra(false);
  h.run('window._openSessions = new Map()');
  await clickUltra(h);
  assert.equal(h.confirms.length, 1, 'a screen that cannot be read asks first');
  await h.advance(500);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode']]);
  // Readable by the time of the looks, with the line on it: still nothing,
  // because nobody counted before the text was typed.
  h.run(`window._openSessions = new Map([['${SID}', { terminal: __knobs.terminal }]])`);
  h.knobs.rows = [ON_LINE];
  await h.advance(5250);
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
    await h.advance(500);
    // Readable again, with the line on it. Zero before would make this "more".
    h.run(`window._openSessions = new Map([['${SID}', { terminal: __knobs.terminal }]])`);
    h.knobs.rows = ['> /effort ultracode', ON_LINE];
    await h.advance(5250);
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
  await h.advance(250);   // the Enter (B7): the looks count from it
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
  await h.advance(250);   // the Enter (B7): the looks count from it
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
  await quiet.advance(5250);
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
    await h.advance(250);   // the Enter (B7): the looks count from it
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
  assert.equal(ultraHeader(h).title, 'Ultracode is on. This window has seen no busy or idle event for this session since it loaded. Click to switch it off anyway (asks first).');
  await clickUltra(h);
  assert.deepEqual(h.confirms, [boxText(REASON_NOT_TOLD, '/effort ultracode off')]);
  assert.deepEqual(h.confirmOptions.map((o) => ({ ...o })), [{ confirm: 'Type it anyway' }]);
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
  h.knobs.duringQuestion = () => h.busyEvent(true);
  h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
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

test('browser: the hook\'s next report takes over from the confirmation', async () => {
  const h = await bootUltra(false);
  await clickUltra(h);
  await h.advance(250);   // the Enter (B7): the looks count from it
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
  await first.advance(250);   // the Enter (B7): the looks count from it
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
  await h.advance(250);   // the Enter (B7): the looks count from it
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

// ── terminal-manager.js: what is typed by hand ─────────────────────────────

const TERMINAL_MANAGER = path.join(__dirname, '..', 'public', 'terminal-manager.js');

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
  await h.advance(250);   // the Enter (B7): the looks count from it
  h.knobs.rows = promptScreenWith(['> /effort ultracode', '  ' + ON_LINE]);
  await h.advance(1000);
  assert.equal(ultraHeader(h).look, 'on');
  // By the last look the line has gone off the top of the screen.
  h.knobs.rows = promptScreenWith(['a long answer', 'that pushed it off']);
  await h.advance(5000);
  assert.equal(ultraHeader(h).look, 'on');
  assert.equal(ultraHeader(h).asksFirst, false);
  assert.equal(h.header().note, null);
  assert.equal(JSON.parse(h.storage.get(ULTRA_KEY)).value, true);
});

test('browser: the screen is counted before the text goes in, so a line that is there straight after it is new', async () => {
  const h = await bootUltra(false);
  h.knobs.onSend = (data) => {
    if (data === ULTRACODE_TEXT.on) h.knobs.rows[12] = '  ' + ON_LINE;
  };
  h.run(`{
    const send = window.api.sendInput;
    window.api.sendInput = (id, data) => { __knobs.onSend(data); send(id, data); };
  }`);
  await clickUltra(h);
  await h.advance(1250);
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
  h.knobs.rows = promptScreenWith(['  ' + ON_LINE]);
  await h.advance(750);
  assert.equal(ultraHeader(h).look, 'on');
  await h.click('primary');
  assert.deepEqual(h.sent[2], [SID, REQUEST_LINE]);
  assert.equal(h.confirms.length, 0);
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

// ── pin: a plain Hand off click, on the shared terminal ────────────────────
//
// Written before the relaunch fixes, to hold through them. Today the click
// path does not look at the screen at all. The ready-state fix is designed to
// look at it before typing, and to hold the Enter until the typed line shows in
// the input box. On an empty prompt neither changes what is typed: the line,
// then Enter as a write of its own, and no question.

// The live screen of the terminal this window has open for the session, read
// the way a page reads xterm.js: terminal.rows lines from the buffer's baseY,
// and the cursor's row.
function openScreen(h, id = SID) {
  return JSON.parse(h.run(`(() => {
    const terminal = window._openSessions.get('${id}').terminal;
    const buffer = terminal.buffer.active;
    const rows = [];
    for (let y = 0; y < terminal.rows; y++) rows.push(buffer.getLine(buffer.baseY + y).translateToString(true));
    return JSON.stringify({ rows, cursorY: buffer.cursorY });
  })()`));
}

// A session-forked event as the window gets it. h.listeners.fork is this
// script's listener and then the terminal moving to the new id (boot's
// onSessionForked); this adds the rest of what app.js's own listener does to
// the globals this fake window has: the session's row moves to the new id, and
// the new id is the session in view. The list of running ids is main's; here
// it has the new id at once.
async function forkEvent(h, oldId, newId) {
  h.listeners.fork(oldId, newId);
  h.run(`(() => {
    const session = sessionMap.get('${oldId}');
    session.sessionId = '${newId}';
    sessionMap.delete('${oldId}');
    sessionMap.set('${newId}', session);
    if (activeSessionId === '${oldId}') activeSessionId = '${newId}';
    activePtyIds = new Set([...activePtyIds].map(id => (id === '${oldId}' ? '${newId}' : id)));
  })()`);
  await flush();
}

// A session-forked event for a /clear, as the window gets it: four arguments.
// The rest is forkEvent's: what app.js's own listener does to this fake window's globals.
async function clearEvent(h, oldId, newId, clearedAtMs) {
  h.listeners.fork(oldId, newId, 'clear', { clearedAtMs });
  h.run(`(() => {
    const session = sessionMap.get('${oldId}');
    session.sessionId = '${newId}';
    sessionMap.delete('${oldId}');
    sessionMap.set('${newId}', session);
    if (activeSessionId === '${oldId}') activeSessionId = '${newId}';
    activePtyIds = new Set([...activePtyIds].map(id => (id === '${oldId}' ? '${newId}' : id)));
  })()`);
  await flush();
}

// h.refresh() for a session other than SID.
async function refreshId(h, id) {
  await h.advance(600);
  await h.run(`handoffRefresh('${id}')`);
  await flush();
  h.run('handoffRenderHeader()');
}
const stateFile = (id) => VM_DIR + '\\' + id + '.state.json';
const entryOf = (h, id) => JSON.parse(h.run(`JSON.stringify(handoffRt.cache.get('${id}') || null)`));

test('browser (pin): with a terminal showing an empty prompt, a plain Hand off click types the line and Enter follows as a second write, with no question', async (t) => {
  const POINTER = '❯';
  const RULE_ROW = /^─{10,}/;
  const withoutRow = (rows, y) => rows.filter((_, index) => index !== y);
  // Both shared boots give this window.
  const windows = {
    'the window boot gives': () => bootEnded(),
    'the window bootUltra gives': () => bootUltra(false),
  };

  for (const [name, start] of Object.entries(windows)) {
    await t.test(name, async () => {
      const h = await start();

      // An empty prompt: a full screen, the cursor in the input box, the box
      // holding the pointer and nothing typed, a rule row above and below it.
      const empty = openScreen(h);
      const box = empty.cursorY;
      assert.equal(empty.rows.length, 55);
      assert.ok(Number.isInteger(box) && box > 0 && box < 54, `cursor row ${box}`);
      assert.ok(empty.rows[box].startsWith(POINTER), 'the cursor is on the pointer row');
      assert.equal(empty.rows[box].slice(POINTER.length).trim(), '', 'nothing is typed in the box');
      assert.equal(empty.rows[box], POINTER + '\u00a0', 'the empty box as the program draws it: the pointer and a no-break space');
      assert.match(empty.rows[box - 1], RULE_ROW);
      assert.match(empty.rows[box + 1], RULE_ROW);

      // A plain click: Hand off is on offer and does not ask first.
      const header = h.header();
      assert.equal(header.primary, 'Hand off');
      assert.equal(header.primaryEnabled, true);
      assert.equal(header.primaryOverride, false);

      const clickMs = h.now;
      await h.click('primary');
      assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'the line is typed at the click, as one write');
      assert.doesNotMatch(h.sent[0][1], /[\r\n]/, 'no Enter inside the line\'s own write');
      assert.equal(h.confirms.length, 0, 'no question before typing');
      // The program shows it: after the pointer, on the cursor's row.
      const typed = openScreen(h);
      assert.equal(typed.cursorY, box);
      assert.ok(typed.rows[box].startsWith(POINTER));
      assert.equal(typed.rows[box].slice(POINTER.length).trim(), REQUEST_LINE);
      assert.deepEqual(withoutRow(typed.rows, box), withoutRow(empty.rows, box), 'no other row moved');

      await h.advance(249);
      assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'Enter does not come straight after the line');
      await h.advance(1);
      assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']], 'Enter follows as a second write');
      assert.equal(h.confirms.length, 0);
      assert.deepEqual(openScreen(h), empty, 'Enter sent the line: the box is empty again');

      // The click is on record as a request made then.
      const request = h.request();
      assert.equal(request.phase, 'requested');
      assert.equal(request.reason, '');
      assert.ok(request.atMs >= clickMs && request.atMs <= clickMs + 250, `atMs ${request.atMs}, click ${clickMs}`);
      assert.ok(!request.unsent, 'a line whose Enter went is not on record as unsent');

      // One line and one Enter, and nothing after them.
      await h.advance(2000);
      assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
      assert.equal(h.confirms.length, 0, 'no question after it either');
      // Nor does the record change its mind later: the box is empty and stays
      // empty, and an empty box after the Enter is not "typed but not sent".
      const later = h.request();
      assert.equal(later.phase, 'requested');
      assert.ok(!later.unsent, 'a line whose Enter went is still not on record as unsent, 2 s later');
    });
  }

  // The Enter is for the session, not for the id it had at the click: when the
  // session gets a new id between the two writes, the Enter goes to that id.
  await t.test('a fork between the line and its Enter', async () => {
    const h = await bootEnded();
    const empty = openScreen(h);
    const box = empty.cursorY;
    assert.equal(empty.rows[box], POINTER + '\u00a0');

    await h.click('primary');
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    await h.advance(100);
    await forkEvent(h, SID, NEW_SID);
    // The terminal went with the session, the typed line still in its box.
    assert.equal(h.run(`window._openSessions.has('${SID}')`), false);
    assert.equal(openScreen(h, NEW_SID).rows[box].slice(POINTER.length).trim(), REQUEST_LINE);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'the fork itself types nothing');

    await h.advance(149);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'the fork does not bring the Enter forward');
    await h.advance(1);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [NEW_SID, '\r']], 'Enter goes to the id the session has now');
    assert.equal(h.confirms.length, 0);
    assert.deepEqual(openScreen(h, NEW_SID), empty, 'Enter sent the line: the box is empty again');

    await h.advance(2000);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [NEW_SID, '\r']]);
    assert.equal(h.confirms.length, 0, 'no question after it either');

    // The request is on record with the session, under its new id, and stays so.
    const request = JSON.parse(h.run(`JSON.stringify(handoffRt.cache.get('${NEW_SID}').request)`));
    assert.equal(request.phase, 'requested');
    assert.ok(!request.unsent, 'a line whose Enter went is not on record as unsent');
  });
});

// ── the screen in the gate: pure rules ─────────────────────────────────────
const gateFacts = (gate) => ({ allowed: gate.allowed, override: gate.override, reason: gate.reason, advice: gate.advice });

test('ctx-handoff: the new pure names are exported, and the two old question texts are gone', () => {
  const mod = require(MODULE_PATH);
  assert.equal(typeof mod.gateText, 'function');
  assert.equal(typeof mod.chooseHeaderNote, 'function');
  assert.equal('OVERRIDE_CONFIRM' in mod, false);
  assert.equal('ultracodeQuestion' in mod, false);
});

test('ctx-handoff: typingGate asks first unless the screen says empty', () => {
  const gate = (screen) => typingGate(buttonArgs({ screen }));
  assert.deepEqual(gateFacts(gate(scr('empty'))), { allowed: true, override: false, reason: '', advice: '' });
  assert.deepEqual(gateFacts(gate(scr('draft'))), { allowed: true, override: true, reason: TEXT_IN_BOX, advice: '' });
  for (const screen of [scr('unknown'), undefined, null, 'empty', {}, scr('a state of a later version')]) {
    assert.deepEqual(gateFacts(gate(screen)), { allowed: true, override: true, reason: NO_PROMPT, advice: '' }, JSON.stringify(screen));
  }
  assert.deepEqual(gateFacts(gate(scr('question'))), { allowed: false, override: false, reason: ASKING, advice: 'Answer it in the terminal first.' });
  // B3, B4 and B2 on Hand off, character for character.
  assert.equal(buttonModel(buttonArgs({ screen: scr('draft') })).primary.title,
    "There is text in this session's input box. Click to type the request anyway (asks first).");
  assert.equal(buttonModel(buttonArgs({ screen: scr('unknown') })).primary.title,
    "Switchboard cannot see an empty prompt on this session's screen. Click to type the request anyway (asks first).");
  const asked = buttonModel(buttonArgs({ screen: scr('question') })).primary;
  assert.deepEqual({ enabled: asked.enabled, override: asked.override, title: asked.title },
    { enabled: false, override: false, title: 'Session is asking you something. Answer it in the terminal first.' });
});

test('ctx-handoff: typingGate names one reason, the stronger first', () => {
  const all = { ownedElsewhere: true, didNotStop: true, pendingRow: true, busy: true, lastBusyAtMs: STOP_MS + 1, lineOnWay: true, screen: scr('question') };
  const refusals = [
    ['ownedElsewhere', 'Shown in another window', ''],
    ['didNotStop', 'Session did not stop', 'It takes no typing. Press Stop to try once more.'],
    ['pendingRow', 'Session is still starting', ''],
    ['busy', 'Session is working', ''],
    ['lineOnWay', 'Waiting for the session to confirm the Ultracode switch', ''],
    ['screen', 'Session is asking you something', 'Answer it in the terminal first.'],
  ];
  const over = { ...all };
  for (const [key, reason, advice] of refusals) {
    const gate = typingGate(buttonArgs(over));
    assert.deepEqual(gateFacts(gate), { allowed: false, override: false, reason, advice }, key);
    assert.equal(gate.why, reason, 'the old field carries the same sentence');
    delete over[key];
  }
  assert.deepEqual(gateFacts(typingGate(buttonArgs({ running: false }))), { allowed: false, override: false, reason: 'Session is not running', advice: '' });
  // Only the boolean true counts for the two new flags.
  for (const value of [false, undefined, null, 1, 'yes']) {
    assert.equal(typingGate(buttonArgs({ didNotStop: value, lineOnWay: value })).allowed, true, String(value));
  }
  // Asks first: today's order (the turn not ended, then "not told"), then the two screen reasons.
  const asks = [
    [{ state: null, busyKnown: false, screen: scr('draft') }, REASON_NOT_ENDED],
    [{ busyKnown: false, screen: scr('draft') }, REASON_NOT_TOLD],
    [{ screen: scr('draft') }, TEXT_IN_BOX],
    [{ screen: scr('unknown') }, NO_PROMPT],
  ];
  for (const [more, reason] of asks) {
    const gate = typingGate(buttonArgs(more));
    assert.deepEqual(gateFacts(gate), { allowed: true, override: true, reason, advice: '' }, reason);
    assert.equal(gate.why, '');
  }
  // A refusal is never an asks-first.
  assert.equal(typingGate(buttonArgs({ state: null, screen: scr('question') })).allowed, false);
  // The two old fields keep today's values.
  assert.equal(typingGate(buttonArgs({ state: null })).overrideTitle, OVERRIDE_TITLE);
  assert.equal(typingGate(buttonArgs({ screen: scr('draft') })).overrideTitle, OVERRIDE_TITLE_UNSEEN);
});

test('ctx-handoff: gateText builds the tooltip, the asks-first title, the box and the note from the one reason', () => {
  const asking = typingGate(buttonArgs({ screen: scr('question') }));
  const working = typingGate(buttonArgs({ busy: true, lastBusyAtMs: STOP_MS + 1 }));
  const stuck = typingGate(buttonArgs({ didNotStop: true }));
  const waiting = typingGate(buttonArgs({ lineOnWay: true }));
  const draft = typingGate(buttonArgs({ screen: scr('draft') }));
  const unseen = typingGate(buttonArgs({ screen: scr('unknown') }));
  const plain = typingGate(buttonArgs());

  assert.equal(gateText(asking, 'tooltip'), 'Session is asking you something. Answer it in the terminal first.');           // B2
  assert.equal(gateText(stuck, 'tooltip'), 'Session did not stop. It takes no typing. Press Stop to try once more.');        // A12
  assert.equal(gateText(waiting, 'tooltip'), 'Waiting for the session to confirm the Ultracode switch');                     // B12
  assert.equal(gateText(working, 'tooltip'), 'Session is working');

  const off = { prefix: 'Ultracode is off. ', action: 'Click to switch it on' };
  const on = { prefix: 'Ultracode is on. ', action: 'Click to switch it off' };
  assert.equal(gateText(draft, 'asks-first', off),
    "Ultracode is off. There is text in this session's input box. Click to switch it on anyway (asks first).");             // B3
  assert.equal(gateText(draft, 'asks-first', on),
    "Ultracode is on. There is text in this session's input box. Click to switch it off anyway (asks first).");             // B3
  assert.equal(gateText(unseen, 'asks-first', off),
    "Ultracode is off. Switchboard cannot see an empty prompt on this session's screen. Click to switch it on anyway (asks first)."); // B4
  // No reason (only the hand-typed rule asks): the title as it was built.
  assert.equal(gateText(plain, 'asks-first', off), 'Ultracode is off. Click to switch it on (asks first).');

  // B6: the reason, the question with the exact text, the last line.
  assert.equal(gateText(draft, 'box', { line: REQUEST_LINE, hold: false }),
    "There is text in this session's input box.\n\n"
    + 'Type "Write the context handoff now. [ctx-handoff:request]" into this session anyway?\n\n'
    + 'If your own text is there, it is sent together with this line.');                                                     // T1's last line
  assert.equal(gateText(draft, 'box', { line: '/effort ultracode', hold: true }),
    "There is text in this session's input box.\n\n"
    + 'Type "/effort ultracode" into this session anyway?\n\n'
    + 'If your own text is there, the line is typed after it and is not sent.');                                             // B6's last line
  assert.equal(gateText(unseen, 'box', { line: '/effort ultracode off', hold: false }),
    "Switchboard cannot see an empty prompt on this session's screen.\n\n"
    + 'Type "/effort ultracode off" into this session anyway?\n\n'
    + 'If the terminal is asking you something, cancel: the typed line could answer it.');
  assert.equal(gateText(unseen, 'box', { line: '/effort ultracode off', hold: true }),
    gateText(unseen, 'box', { line: '/effort ultracode off', hold: false }), 'the hold changes the text-in-the-box line only');
  assert.equal(gateText(plain, 'box', { line: '/effort ultracode', hold: false }),
    'Type "/effort ultracode" into this session anyway?\n\n'
    + 'If the terminal is asking you something, cancel: the typed line could answer it.');

  assert.equal(gateText(asking, 'note'), 'Not typed. Session is asking you something. Answer it in the terminal first.');    // B9
  assert.equal(gateText(working, 'note'), 'Not typed. Session is working.');                                                 // B9
});

test("ctx-handoff: Hand off's two existing tooltips come out of the builder byte for byte", () => {
  assert.equal(OVERRIDE_TITLE, 'This session has not reported the end of its turn. Click to type the request anyway (asks first).');
  assert.equal(OVERRIDE_TITLE_UNSEEN, 'This window has seen no busy or idle event for this session since it loaded. Click to type the request anyway (asks first).');
  const handOff = { prefix: '', action: 'Click to type the request' };
  assert.equal(gateText(typingGate(buttonArgs({ state: null })), 'asks-first', handOff), OVERRIDE_TITLE);
  assert.equal(gateText(typingGate(buttonArgs({ busyKnown: false })), 'asks-first', handOff), OVERRIDE_TITLE_UNSEEN);
  assert.equal(buttonModel(buttonArgs({ state: null })).primary.title, OVERRIDE_TITLE);
  assert.equal(buttonModel(buttonArgs({ busyKnown: false })).primary.title, OVERRIDE_TITLE_UNSEEN);
  const update = buttonModel(buttonArgs({ state: writtenState(), handoffReadable: true, busyKnown: false })).update;
  assert.equal(update.title, OVERRIDE_TITLE_UNSEEN);
});

test('ctx-handoff: Ultracode gives the reason in its asks-first title, for every reason the gate has', () => {
  const title = (over) => ultracodeModel(ultraArgs(over)).title;
  assert.equal(title({ state: null }),
    'Ultracode is off. This session has not reported the end of its turn. Click to switch it on anyway (asks first).');                              // B5
  assert.equal(title({ busyKnown: false }),
    'Ultracode is off. This window has seen no busy or idle event for this session since it loaded. Click to switch it on anyway (asks first).');   // B5
  assert.equal(title({ screen: scr('draft') }),
    "Ultracode is off. There is text in this session's input box. Click to switch it on anyway (asks first).");                                     // B3
  assert.equal(title({ screen: scr('unknown') }),
    "Ultracode is off. Switchboard cannot see an empty prompt on this session's screen. Click to switch it on anyway (asks first).");               // B4
  assert.equal(title({ ultracodeValue: true, screen: scr('draft') }),
    "Ultracode is on. There is text in this session's input box. Click to switch it off anyway (asks first).");
  assert.equal(title({}), 'Ultracode is off. Click to switch it on.');
});

test('ctx-handoff: a stop that did not finish, a question and a line on its way dim every button with one tooltip', () => {
  const written = { state: writtenState(), handoffReadable: true };
  for (const [over, tip] of [[{ didNotStop: true }, DID_NOT_STOP_TIP], [{ screen: scr('question') }, ASKING_TIP], [{ lineOnWay: true }, SWITCH_WAIT]]) {
    const hand = buttonModel(buttonArgs(over)).primary;
    const update = buttonModel(buttonArgs({ ...written, ...over })).update;
    const ultra = ultracodeModel(ultraArgs({ ultracodeValue: true, ...over }));
    for (const [name, part] of [['Hand off', hand], ['Update', update], ['Ultracode', ultra]]) {
      assert.deepEqual({ enabled: part.enabled, override: part.override, title: part.title }, { enabled: false, override: false, title: tip }, name + ': ' + tip);
    }
    assert.equal(update.visible, true);
  }
});

test('ctx-handoff: chooseHeaderNote shows the later of the live notes', () => {
  const NOW = 5000000;
  const note = (text, agoMs, open = false) => ({ text, atMs: NOW - agoMs, open });
  assert.equal(chooseHeaderNote([], NOW), null);
  assert.equal(chooseHeaderNote(undefined, NOW), null);
  assert.equal(chooseHeaderNote([note('a', 1000)], NOW).text, 'a');
  assert.equal(chooseHeaderNote([note('older', 5000), note('later', 1000)], NOW).text, 'later');
  assert.equal(chooseHeaderNote([note('later', 1000), note('older', 5000)], NOW).text, 'later', 'whatever the order they are handed in');
  // A note about a click lives 60 seconds.
  assert.equal(chooseHeaderNote([note('a', 59999)], NOW).text, 'a');
  assert.equal(chooseHeaderNote([note('a', 60000)], NOW), null);
  // A note about a request that is still outstanding lives while it is passed in.
  assert.equal(chooseHeaderNote([note('still out', 900000, true)], NOW).text, 'still out');
  assert.equal(chooseHeaderNote([note('still out', 900000, true), note('click', 1000)], NOW).text, 'click');
  assert.equal(chooseHeaderNote([note('still out', 900000, true), note('click', 60000)], NOW).text, 'still out');
  // Nothing to show is not a note.
  for (const bad of [note('', 10), note(null, 10), { text: 'x', open: false }, null, 'x']) {
    assert.equal(chooseHeaderNote([bad], NOW), null, JSON.stringify(bad));
  }
});

test('ctx-handoff: the header note of buttonModel is the chooser\'s: the later of the request note, the Continue error and the click note', () => {
  const NOW = 2000000;
  const timeout = { phase: 'timeout', atMs: NOW - 30000, reason: HANDOFF_NOT_LANDED };
  const base = { nowMs: NOW, request: timeout };
  assert.equal(buttonModel(buttonArgs(base)).note, HANDOFF_NOT_LANDED);
  // A click note later than the request shows; one older than 60 s gives way again.
  assert.equal(buttonModel(buttonArgs({ ...base, clickNote: 'Not typed. Session is working.', clickNoteAtMs: NOW - 1000 })).note, 'Not typed. Session is working.');
  assert.equal(buttonModel(buttonArgs({ ...base, clickNote: 'Not typed. Session is working.', clickNoteAtMs: NOW - 60000 })).note, HANDOFF_NOT_LANDED);
  // Of a Continue error and a click note, the later.
  const both = (errorAgo, clickAgo) => buttonModel(buttonArgs({
    nowMs: NOW, continueError: 'The new session could not be started.', continueErrorAtMs: NOW - errorAgo,
    clickNote: 'No confirmation seen', clickNoteAtMs: NOW - clickAgo,
  })).note;
  assert.equal(both(1000, 5000), 'The new session could not be started.');
  assert.equal(both(5000, 1000), 'No confirmation seen');
  assert.equal(both(70000, 80000), null);
  // A request that was typed after the Continue error is the later one.
  assert.equal(buttonModel(buttonArgs({ nowMs: NOW, request: { phase: 'timeout', atMs: NOW - 30000, reason: HANDOFF_NOT_LANDED },
    continueError: 'x', continueErrorAtMs: NOW - 50000 })).note, HANDOFF_NOT_LANDED);
});

test('ctx-handoff: the three buttons show the same of plain, asks first, cannot click, with the same reason', () => {
  const kind = (part) => (!part.enabled ? 'cannot' : part.override ? 'asks' : 'plain');
  const screens = [scr('empty'), scr('draft'), scr('unknown'), scr('question'), undefined];
  let seen = { plain: 0, asks: 0, cannot: 0 };
  const check = (args, hand, plainTitle) => {
    const gate = typingGate(args);
    for (const typed of [null, { atMs: STOP_MS + 1, enter: false }, { atMs: STOP_MS + 1, enter: true }]) {
      for (const value of [true, false]) {
        const ultra = ultracodeModel({ ...args, ultracodeValue: value, switching: false, typed, headerOff: false });
        assert.equal(kind(ultra), kind(hand));
        const word = value ? { prefix: 'Ultracode is on. ', action: 'Click to switch it off' } : { prefix: 'Ultracode is off. ', action: 'Click to switch it on' };
        if (kind(hand) === 'cannot') {
          assert.equal(hand.title, gateText(gate, 'tooltip'));
          assert.equal(ultra.title, hand.title);
        } else if (kind(hand) === 'asks') {
          assert.equal(hand.title, gateText(gate, 'asks-first', { prefix: '', action: 'Click to type the request' }));
          assert.equal(ultra.title, gateText(gate, 'asks-first', word));
          assert.ok(gate.reason.length > 0, 'an asks-first always has its reason');
        } else {
          assert.equal(hand.title, plainTitle);
          assert.equal(ultra.title, word.prefix + word.action + '.');
        }
      }
    }
    seen[kind(hand)]++;
  };
  // Hand off and Ultracode, over every combination the gate looks at.
  for (const base of gateCases()) {
    if (!base.running) continue;   // Hand off is not shown for a session that is not running
    for (const screen of screens) {
      for (const didNotStop of [false, true]) {
        const args = { ...base, screen, didNotStop, lineOnWay: false };
        check(args, buttonModel(args).primary, 'Ask this session to write its context handoff');
      }
    }
  }
  // Update and Ultracode, on a session that has written a handoff.
  for (const screen of screens) {
    for (const over of [{}, { busy: true }, { ownedElsewhere: true }, { pendingRow: true }, { busyKnown: false }, { didNotStop: true }]) {
      const args = buttonArgs({ state: writtenState(), handoffReadable: true, screen, lineOnWay: false, ...over });
      const update = buttonModel(args).update;
      assert.equal(update.visible, true);
      check(args, update, 'Ask this session to write the handoff again');
    }
  }
  assert.ok(seen.plain > 0 && seen.asks > 0 && seen.cannot > 0, 'the table reaches all three');

  // The two states where they differ on purpose.
  // (1) Ultracode's value is not known yet: Ultracode is dimmed, Hand off goes by the gate.
  const unknown = ultracodeModel(ultraArgs({ ultracodeValue: null }));
  assert.deepEqual({ enabled: unknown.enabled, title: unknown.title }, { enabled: false, title: ULTRACODE_UNKNOWN_TITLE });
  assert.equal(buttonModel(buttonArgs()).primary.enabled, true);
  // (2) Each button shows its own waiting label while its own line is on its way.
  const requested = { request: { phase: 'requested', atMs: STOP_MS + 1 } };
  assert.equal(buttonModel(buttonArgs(requested)).primary.label, 'Writing' + ELLIPSIS);
  assert.equal(buttonModel(buttonArgs(requested)).primary.title, 'Waiting for the session to write the handoff');
  assert.equal(ultracodeModel(ultraArgs({ ultracodeValue: true, ...requested })).title, 'Waiting for the session to write the handoff');
  const switching = ultracodeModel(ultraArgs({ ultracodeValue: true, switching: true, lineOnWay: true }));
  assert.equal(switching.label, 'Ultracode' + ELLIPSIS);
  assert.equal(switching.title, 'Waiting for the session to confirm the switch');
  assert.equal(buttonModel(buttonArgs({ lineOnWay: true })).primary.title, 'Waiting for the session to confirm the Ultracode switch');   // B12
});

// ── the screen in the gate: the page ───────────────────────────────────────
const ULTRA_BTN = 'handoff-ultracode-btn';
const PRIMARY_BTN = 'handoff-primary-btn';
const UPDATE_BTN = 'handoff-update-btn';
const confirmOptions = (h) => h.confirmOptions.map((o) => ({ ...o }));
// A running session that has written a handoff: Continue, with Update beside it.
async function bootUltraWritten() {
  const h = await bootUltra(false);
  h.setHandoffFile(true);
  h.setState(writtenVmState(h, { ultracode: false }));
  await h.refresh();
  assert.equal(h.header().update, true);
  return h;
}

test('browser: the page reads the live screen with its cursor row, and the rows alone for the Ultracode looks', async () => {
  const h = await bootUltra(false);
  const read = JSON.parse(h.run('JSON.stringify(handoffScreenRead("' + SID + '"))'));
  assert.equal(read.rows.length, 55);
  assert.equal(read.cursorY, PROMPT_CURSOR_ROW);
  assert.equal(read.rows[PROMPT_CURSOR_ROW], PROMPT_BOX_EMPTY);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(handoffScreenRows("' + SID + '"))')), read.rows);
  assert.deepEqual(h.inputs().screen.state, 'empty');
  // A cursor row that is not a number is "no cursor", not a throw.
  h.knobs.cursorY = undefined;
  assert.equal(JSON.parse(h.run('JSON.stringify(handoffScreenRead("' + SID + '"))')).cursorY, null);
  assert.equal(h.inputs().screen.state, 'unknown');
  // No terminal in this window, and an id that is not open: null, and no throw.
  h.run('window._openSessions = new Map()');
  assert.equal(h.run('handoffScreenRead("' + SID + '")'), null);
  assert.equal(h.run('handoffScreenRows("' + SID + '")'), null);
  assert.equal(h.inputs().screen.state, 'unknown');
  assert.deepEqual(h.errors, []);
});

test('browser: with the recorded question on screen, Hand off, the update button and the Ultracode button send nothing', async () => {
  const h = await bootUltra(false);
  showQuestion(h);
  await h.tick();   // the buttons follow the screen at the next tick, a second at most
  assert.equal(h.header().primaryEnabled, false);
  assert.equal(titleOf(h, PRIMARY_BTN), ASKING_TIP);
  assert.deepEqual({ enabled: ultraHeader(h).enabled, asksFirst: ultraHeader(h).asksFirst, title: ultraHeader(h).title },
    { enabled: false, asksFirst: false, title: ASKING_TIP });
  await h.click('primary');
  await clickUltra(h);
  await h.advance(6000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.header().note, null, 'a click on a dimmed button leaves no note');

  const w = await bootUltraWritten();
  showQuestion(w);
  await w.tick();
  assert.equal(w.byId[UPDATE_BTN].getAttribute('aria-disabled'), 'true');
  assert.equal(titleOf(w, UPDATE_BTN), ASKING_TIP);
  await w.click('update');
  await w.advance(6000);
  assert.deepEqual(w.sent, []);
  assert.equal(w.confirms.length, 0);

  // The question is answered: a plain click again at the next tick.
  showEmptyPrompt(h);
  await h.tick();
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, false);
  assert.equal(ultraHeader(h).title, 'Ultracode is off. Click to switch it on.');
});

test('browser: Hand off asks first over text in the input box', () => withHold(true, async () => {
  const h = await bootUltra(false);
  h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + 'half a thought';
  await h.tick();
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, true);
  assert.equal(titleOf(h, PRIMARY_BTN), "There is text in this session's input box. Click to type the request anyway (asks first).");
  assert.equal(ultraHeader(h).asksFirst, true);
  assert.equal(ultraHeader(h).title, "Ultracode is off. There is text in this session's input box. Click to switch it on anyway (asks first).");

  h.knobs.confirmAnswer = false;   // Cancel
  await h.click('primary');
  await h.advance(1000);
  // The one box. With the Enter hold its last line is B6's.
  assert.deepEqual(h.confirms, [
    "There is text in this session's input box.\n\n"
    + 'Type "Write the context handoff now. [ctx-handoff:request]" into this session anyway?\n\n'
    + 'If your own text is there, the line is typed after it and is not sent.',
  ]);
  assert.deepEqual(confirmOptions(h), [{ confirm: 'Type it anyway' }], 'a plain button: no danger flag');
  assert.deepEqual(h.sent, []);
  assert.equal(h.header().note, null, 'Cancel leaves no note');

  h.knobs.confirmAnswer = true;    // Type it anyway
  await h.click('primary');
  await h.advance(499);
  assert.deepEqual(h.sent, []);
  await h.advance(1);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  await h.advance(1300);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'typed after his own text, and not sent');
  assert.equal(h.header().note, NOT_SENT);

  // Ultracode over the same text: the same box with its own line.
  const u = await bootUltra(false);
  u.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + 'half a thought';
  u.knobs.confirmAnswer = false;
  await clickUltra(u);   // no tick: the click decides afresh
  assert.deepEqual(u.confirms, [boxText(TEXT_IN_BOX, '/effort ultracode', BOX_HELD_LINE)]);
  assert.deepEqual(confirmOptions(u), [{ confirm: 'Type it anyway' }]);
  assert.deepEqual(u.sent, []);
}));

test('browser: a screen that cannot be read asks first, and still types after a yes', async () => {
  const B4 = "Switchboard cannot see an empty prompt on this session's screen. Click to type the request anyway (asks first).";
  const h = await bootUltra(false);
  h.run('window._openSessions = new Map()');   // no terminal for the session in this window
  await h.tick();
  assert.equal(h.header().primaryOverride, true);
  assert.equal(titleOf(h, PRIMARY_BTN), B4);
  assert.equal(ultraHeader(h).title, "Ultracode is off. Switchboard cannot see an empty prompt on this session's screen. Click to switch it on anyway (asks first).");
  h.knobs.confirmAnswer = false;
  await h.click('primary');
  await h.advance(2000);
  assert.deepEqual(h.confirms, [boxText(NO_PROMPT, REQUEST_LINE)]);
  assert.deepEqual(h.sent, []);
  h.knobs.confirmAnswer = true;
  await h.click('primary');
  await h.advance(750);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']], 'the text, and Enter 250 ms after it');

  // A working line above the box is "not recognised" too.
  const working = await bootUltra(false);
  working.knobs.rows[47] = '\u273b Transmogrifying\u2026 (running UserPromptSubmit hook \u00b7 4s)';
  await working.tick();
  assert.equal(titleOf(working, PRIMARY_BTN), B4);
});

test('browser: without prompt-screen.js every click asks first', () => withHold(true, async () => {
  const h = await bootEnded({ promptScreen: false });
  assert.equal(h.inputs().screen.state, 'unknown');
  assert.equal(h.header().primaryOverride, true);
  assert.equal(titleOf(h, PRIMARY_BTN), "Switchboard cannot see an empty prompt on this session's screen. Click to type the request anyway (asks first).");
  await h.click('primary');
  assert.equal(h.confirms.length, 1);
  await h.advance(750);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'the line is typed; without the screen check its Enter is held');
  assert.deepEqual(h.errors, []);
}));

test('browser: a question that opens while the in-page box is up stops the typing', async () => {
  const NOTE = 'Not typed. Session is asking you something. Answer it in the terminal first.';
  for (const press of ['primary', 'ultracode']) {
    const h = await bootUltra(false);
    h.knobs.cursorY = 53;   // the cursor is not in the box: the screen is not recognised
    await h.tick();
    assert.equal(h.header().primaryOverride, true, press);
    h.knobs.duringQuestion = () => showQuestion(h);
    h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
    if (press === 'primary') await h.click('primary'); else await clickUltra(h);
    await h.advance(6000);
    assert.deepEqual(h.sent, [], press);
    assert.equal(h.header().note, NOTE, press);
    assert.equal(titleOf(h, 'handoff-note'), NOTE, 'the tooltip has all of it');
    assert.equal(ultraHeader(h).label, 'Ultracode', 'not left saying it is switching');
    // 60 seconds, then it goes.
    await h.ticks(61);
    assert.equal(h.header().note, null, press);
  }
});

test('browser: a yes that types nothing says why in the header note', async () => {
  // The session started working.
  const busy = await bootReloaded();
  busy.knobs.duringQuestion = () => busy.busyEvent(true);
  busy.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
  await busy.click('primary');
  await busy.advance(1000);
  assert.deepEqual(busy.sent, []);
  assert.equal(busy.header().note, 'Not typed. Session is working.');

  // Ultracode changed by itself meanwhile, in each direction.
  for (const [was, word] of [[true, 'off'], [false, 'on']]) {
    const h = await bootUltra(was, { reloaded: true });
    h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
    h.knobs.duringQuestion = () => h.setState(endedState(h, { ultracode: !was }));
    await clickUltra(h);
    await h.advance(1000);
    assert.deepEqual(h.sent, []);
    assert.equal(h.header().note, 'Not typed. Ultracode is already ' + word + '.');
  }

  // Another session took the pane, or the header went off: the note waits on the session that was clicked.
  for (const [leave, back] of [['activeSessionId = "' + NEW_SID + '"', 'activeSessionId = "' + SID + '"'], ['gridViewActive = true', 'gridViewActive = false']]) {
    for (const press of ['primary', 'ultracode']) {
      const h = await bootUltra(true, { reloaded: true });
      h.knobs.duringQuestion = () => h.run(leave);
      h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
      if (press === 'primary') await h.click('primary'); else await clickUltra(h);
      await h.advance(1000);
      assert.deepEqual(h.sent, [], leave);
      h.run(back);
      await h.tick();
      assert.equal(h.header().note, NOT_TYPED_CHANGED, leave + ' / ' + press);
    }
  }

  // The session ended (it left the running set) while the box was open. That is neither "started working"
  // nor "opened a question": B9's "every other case", although the gate has a reason of its own for it.
  for (const press of ['primary', 'ultracode']) {
    const h = await bootUltra(true, { reloaded: true });
    h.knobs.duringQuestion = () => h.run('activePtyIds = new Set()');
    h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
    if (press === 'primary') await h.click('primary'); else await clickUltra(h);
    await h.advance(6000);
    assert.deepEqual(h.sent, [], 'ended / ' + press);
    assert.equal(h.header().note, NOT_TYPED_CHANGED, 'ended / ' + press);
  }

  // A click that then types clears the note of the click before it.
  const again = await bootReloaded();
  again.knobs.duringQuestion = () => again.busyEvent(true);
  again.run('window.__askBusy = true; confirmDialog = async () => { if (window.__askBusy) __knobs.duringQuestion(); return true; }');
  await again.click('primary');
  await again.advance(1000);
  assert.equal(again.header().note, 'Not typed. Session is working.');
  again.run('window.__askBusy = false');
  again.setBusy(false);
  await again.tick();
  await again.click('primary');
  await again.advance(500);
  assert.deepEqual(again.sent, [[SID, REQUEST_LINE]]);
  assert.equal(again.header().note, null);
  // "Writing…" shows no note in any case, so the record itself is asked too.
  assert.equal(again.run('handoffRt.cache.get("' + SID + '").ultraNote'), '');
});

test('browser: the session gets a new id while the box is open: the yes still types, under the new id', async () => {
  const hand = await bootReloaded();
  hand.knobs.duringQuestion = () => { forkEvent(hand, SID, NEW_SID); };
  hand.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
  await hand.click('primary');
  await hand.advance(750);
  assert.deepEqual(hand.sent, [[NEW_SID, REQUEST_LINE], [NEW_SID, '\r']]);

  const ultra = await bootUltra(true, { reloaded: true });
  ultra.files.set(VM_DIR + '\\' + NEW_SID + '.state.json', JSON.stringify(endedState(ultra, { ultracode: true })));
  ultra.knobs.duringQuestion = () => { forkEvent(ultra, SID, NEW_SID); };
  ultra.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
  await clickUltra(ultra);
  await ultra.advance(750);
  assert.deepEqual(ultra.sent, [[NEW_SID, '/effort ultracode off'], [NEW_SID, '\r']]);
});

test('browser: of two live header notes the later one shows', async () => {
  const h = await bootUltraWritten();
  await clickUltra(h);
  await h.advance(5250);
  assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
  // Ten seconds later a Continue comes to nothing: that is the later news.
  await h.advance(10000);
  h.knobs.resolveOptions = async () => { throw new Error('settings unreadable'); };
  await h.click('primary');
  assert.equal(h.header().primary, 'Continue in new session');
  assert.equal(h.header().note, 'The new session could not be started.');
  // Each goes after its own 60 seconds.
  await h.ticks(61);
  assert.equal(h.header().note, null);
});

test('browser: Hand off and Update are dimmed while an Ultracode switch is on its way', async () => {
  const h = await bootUltra(false);
  assert.equal(h.header().primaryEnabled, true);
  await clickUltra(h);
  assert.equal(h.header().primaryEnabled, false);
  assert.equal(h.header().primaryOverride, false);
  assert.equal(titleOf(h, PRIMARY_BTN), 'Waiting for the session to confirm the Ultracode switch');
  assert.equal(ultraHeader(h).title, 'Waiting for the session to confirm the switch', 'Ultracode keeps its own waiting label');
  await h.click('primary');
  await h.advance(400);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode'], [SID, '\r']]);
  assert.equal(h.header().note, null, 'a click on a dimmed button leaves no note');
  // Confirmed: Hand off is back.
  h.knobs.rows = promptScreenWith(['  ' + ON_LINE]);
  await h.advance(850);
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(titleOf(h, PRIMARY_BTN), 'Ask this session to write its context handoff');

  const w = await bootUltraWritten();
  await clickUltra(w);
  assert.equal(w.byId[UPDATE_BTN].getAttribute('aria-disabled'), 'true');
  assert.equal(titleOf(w, UPDATE_BTN), 'Waiting for the session to confirm the Ultracode switch');
  // Given up after the last look: back as well.
  await w.advance(5250);
  assert.equal(w.byId[UPDATE_BTN].getAttribute('aria-disabled'), 'false');
});

test('browser: a session that did not stop takes no typing from the three buttons', async () => {
  const h = await bootUltraWritten();
  // `var`, not `let`, on purpose (app.js itself declares the set with `let`). By now the page has drawn its header
  // several times and so has already asked `typeof didNotStopIds`; in a vm context of Node 24, code that has asked
  // that does not see a `let` which a LATER script declares, but it does see a `var`. Seen in a scratch run: with
  // `let` here this test failed, at this boot or at the next one. In the app the set is declared when app.js loads.
  h.run('var didNotStopIds = new Set(["' + SID + '"])');
  await h.tick();
  for (const id of [ULTRA_BTN, UPDATE_BTN]) {
    assert.equal(h.byId[id].getAttribute('aria-disabled'), 'true', id);
    assert.equal(titleOf(h, id), 'Session did not stop. It takes no typing. Press Stop to try once more.', id);
  }
  await clickUltra(h);
  await h.click('update');
  await h.advance(6000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
  // Hand off, on a session with no handoff yet.
  const plain = await bootUltra(false);
  plain.run('var didNotStopIds = new Set(["' + SID + '"])');
  await plain.tick();
  assert.equal(plain.header().primaryEnabled, false);
  assert.equal(titleOf(plain, PRIMARY_BTN), 'Session did not stop. It takes no typing. Press Stop to try once more.');
  // The set is replaced on every answer: an empty one brings the buttons back.
  plain.run('didNotStopIds = new Set()');
  await plain.tick();
  assert.equal(plain.header().primaryEnabled, true);
  // A window whose app.js has no such set (an older page) is not dimmed: see every other test of this file.
});

test('browser: Update asks first like Hand off, with the one box and the request line', async () => {
  const B4 = "Switchboard cannot see an empty prompt on this session's screen. Click to type the request anyway (asks first).";
  const w = await bootUltraWritten();
  assert.equal(w.byId[UPDATE_BTN].className.includes('handoff-btn-override'), false, 'plain on an empty prompt');
  // Text in the input box: B3's reason on Update, and the amber outline.
  w.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + 'half a thought';
  await w.tick();
  assert.equal(w.byId[UPDATE_BTN].className.includes('handoff-btn-override'), true);
  assert.equal(w.byId[UPDATE_BTN].getAttribute('aria-disabled'), 'false');
  assert.equal(titleOf(w, UPDATE_BTN), "There is text in this session's input box. Click to type the request anyway (asks first).");
  // A screen that is not recognised (the cursor is not in the box): B4's reason, and the one box with the request line.
  showEmptyPrompt(w);
  w.knobs.cursorY = 53;
  await w.tick();
  assert.equal(titleOf(w, UPDATE_BTN), B4);
  w.knobs.confirmAnswer = false;   // Cancel
  await w.click('update');
  await w.advance(2000);
  assert.deepEqual(w.confirms, [boxText(NO_PROMPT, REQUEST_LINE)]);
  assert.deepEqual(confirmOptions(w), [{ confirm: 'Type it anyway' }]);
  assert.deepEqual(w.sent, []);
  assert.equal(w.header().note, null, 'Cancel leaves no note');
  w.knobs.confirmAnswer = true;    // Type it anyway
  await w.click('update');
  await w.advance(499);
  assert.deepEqual(w.sent, []);
  await w.advance(1);
  // Only the text is asked for here. The Enter that follows is the typing path's, which task 08 rewrites;
  // 'browser: a screen that cannot be read asks first, and still types after a yes' holds it for this click path.
  assert.deepEqual(w.sent, [[SID, REQUEST_LINE]], 'the request line, 500 ms after the yes');
  assert.deepEqual(w.errors, []);
});

test('browser: a screen check that throws reads as "not recognised": the click asks first, and nothing is logged', async () => {
  const h = await bootEnded();
  assert.equal(h.header().primaryOverride, false, 'a plain Hand off on an empty prompt');
  h.run('window.PromptScreen = { promptScreen: () => { throw new Error("the marks broke"); } }');
  await h.tick();
  assert.equal(h.inputs().screen.state, 'unknown');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, true);
  assert.equal(titleOf(h, PRIMARY_BTN), "Switchboard cannot see an empty prompt on this session's screen. Click to type the request anyway (asks first).");
  h.knobs.confirmAnswer = false;
  await h.click('primary');
  await h.advance(1000);
  assert.deepEqual(h.confirms, [boxText(NO_PROMPT, REQUEST_LINE)]);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.errors, [], 'the reader answers "unknown" itself; nothing reaches the console');
});

test('browser: a Hand off\'s Enter goes to the session that was clicked when another session is in view', async (t) => {
  await t.test('another session is in view when the Enter is due', async () => {
    const h = await bootEnded();
    await h.click('primary');
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    await h.advance(100);
    h.run(`activeSessionId = '${NEW_SID}'`);
    await h.advance(150);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
    await h.advance(2000);
    assert.equal(h.sent.length, 2);
  });

  await t.test('the session in view has a terminal of its own, with an empty box', async () => {
    const h = await bootEnded();
    h.knobs.other = fakeTerminal({ rows: emptyPromptScreen(), scrollback: [], viewTop: null, cursorY: PROMPT_CURSOR_ROW });
    h.run(`window._openSessions.set('${NEW_SID}', { terminal: __knobs.other })`);
    await h.click('primary');
    await h.advance(100);
    h.run(`activeSessionId = '${NEW_SID}'`);
    await h.advance(150);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  });
});

// ── the Enter hold (ready state, commit 3) ─────────────────────────────────
const NOT_SENT = 'Typed but not sent. Look at the session\'s input box.';            // B8
const ENTER_HOLD_LINE = /^const ENTER_HOLD = (?:true|false);/m;
const SOURCE_HOLD = {
  on: SOURCE.replace(ENTER_HOLD_LINE, 'const ENTER_HOLD = true;'),
  off: SOURCE.replace(ENTER_HOLD_LINE, 'const ENTER_HOLD = false;'),
};
// Runs fn with the page loaded with the hold on or off, whatever the file ships.
async function withHold(on, fn) {
  sourceOverride = on ? SOURCE_HOLD.on : SOURCE_HOLD.off;
  try { return await fn(); } finally { sourceOverride = null; }
}

test('ctx-handoff: the Enter hold ships switched on, and its switch is one line', () => {
  const mod = require(MODULE_PATH);
  assert.equal(mod.ENTER_HOLD, true);
  assert.equal(mod.HANDOFF_NOT_SENT, NOT_SENT);
  assert.equal(SOURCE.split(/\r?\n/).filter(line => ENTER_HOLD_LINE.test(line)).length, 1);
  assert.notEqual(SOURCE_HOLD.on, SOURCE_HOLD.off);
});

test('nextRequest: a typed-but-not-sent request goes back to "Writing…" only on the hook\'s acknowledgement', () => {
  const atMs = 5000000;
  const atS = atMs / 1000;
  const unsent = { phase: 'timeout', atMs, reason: '', unsent: true };
  const look = (state, afterMs) => nextRequest({ request: unsent, state, nowMs: atMs + afterMs, running: true });
  assert.equal(look(null, 5000), unsent, 'nothing known: unchanged, the same object');
  assert.equal(look(null, 25000), unsent, 'not "not picked up": the app knows it did not send it');
  assert.equal(look({ crossed_at: atS - 60, manual: true, pending: true }, 5000), unsent, 'an acknowledgement of an older request');
  assert.deepEqual(look({ crossed_at: atS + 2, manual: true, pending: true }, 30000), { phase: 'requested', atMs, reason: '' });
  assert.deepEqual(look({ crossed_at: atS + 2, manual: false, pending: false, written_at: atS + 40 }, 50000), { phase: 'idle', atMs, reason: '' });
  assert.deepEqual(look({ crossed_at: atS + 2, manual: false, pending: false, written_at: null }, 50000), { phase: 'idle', atMs, reason: '' });
  assert.deepEqual(look(null, REQUEST_EXPIRY_MS + 1), { phase: 'idle', atMs, reason: '' });
});

test('parseStoredRequest: the unsent flag comes back only as true, and only on a timeout record', () => {
  const at = AT_MS;
  assert.deepEqual(parseStoredRequest(JSON.stringify({ phase: 'timeout', atMs: at, reason: '', unsent: true }), at + 5000),
    { phase: 'timeout', atMs: at, reason: '', unsent: true });
  const without = [
    { phase: 'timeout', atMs: at, reason: '', unsent: 'yes' },
    { phase: 'timeout', atMs: at, reason: '', unsent: false },
    { phase: 'requested', atMs: at, reason: '', unsent: true },
    { phase: 'idle', atMs: at, unsent: true },
  ];
  for (const stored of without) assert.equal('unsent' in parseStoredRequest(JSON.stringify(stored), at + 5000), false, JSON.stringify(stored));
});

test('typingGate: a line that was typed and not sent is not "the last line typed" for the Stop rule', () => {
  const screen = { state: 'empty', why: '' };
  const sent = { phase: 'timeout', atMs: STOP_MS + 5, reason: 'x' };
  assert.equal(typingGate(buttonArgs({ screen, request: sent })).override, true, 'no Stop since a line that was sent');
  assert.equal(typingGate(buttonArgs({ screen, request: { phase: 'timeout', atMs: STOP_MS + 5, reason: '', unsent: true } })).override, false);
});

test('browser: Enter is held until the typed text is seen (only with the Enter hold)', async (t) => {
  await t.test('the text never shows: no Enter, the note for 60 seconds, Hand off again', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    const clickMs = h.now;
    await h.click('primary');
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    assert.equal(h.header().primary, `Writing${ELLIPSIS}`);
    await h.advance(1299);
    assert.equal(h.sent.length, 1);
    assert.equal(h.request().phase, 'requested');
    assert.equal(h.header().note, null);
    await h.advance(1);   // the last look, at 1300
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'no Enter');
    assert.deepEqual(h.request(), { phase: 'timeout', atMs: clickMs, reason: '', unsent: true });
    assert.equal(h.header().primary, 'Hand off');
    assert.equal(h.header().primaryEnabled, true);
    assert.equal(h.header().primaryOverride, false, 'this fake box is empty, and the next click follows the screen');
    assert.equal(h.header().note, NOT_SENT);
    assert.equal(h.byId['handoff-note'].getAttribute('title'), NOT_SENT);
    await h.advance(700);
    assert.equal(h.sent.length, 1, 'no Enter 2 s after the click either');
    // 25 s on with nothing from the hook: still "typed but not sent", not "not picked up".
    await h.ticks(25);
    assert.deepEqual(h.request(), { phase: 'timeout', atMs: clickMs, reason: '', unsent: true });
    assert.equal(h.header().note, NOT_SENT);
    await h.ticks(32);    // 59 s after the click
    assert.equal(h.header().note, NOT_SENT);
    await h.ticks(2);     // 61 s
    assert.equal(h.header().note, null);
    assert.equal(h.request().unsent, true, 'only the note ages out');
    assert.deepEqual(h.errors, []);
  }));

  await t.test('a late acknowledgement turns it into "Writing…"', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    const clickMs = h.now;
    await h.click('primary');
    await h.advance(1300);
    assert.equal(h.request().unsent, true);
    // He pressed Enter there himself, and the hook saw the request.
    h.setState(endedState(h, { manual: true, pending: true, crossed_at: clickMs / 1000 + 3 }));
    await h.refresh();
    assert.deepEqual(h.request(), { phase: 'requested', atMs: clickMs, reason: '' });
    assert.equal(h.header().primary, `Writing${ELLIPSIS}`);
    assert.equal(h.header().note, null);
  }));

  await t.test('the text shows at a later look: Enter once, at that look', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    const clickMs = h.now;
    await h.click('primary');
    await h.advance(450);   // the looks at 250 and 400 saw an empty box
    assert.equal(h.sent.length, 1);
    h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + REQUEST_LINE;
    await h.advance(149);
    assert.equal(h.sent.length, 1, 'not between two looks');
    await h.advance(1);     // the look at 600
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
    // The text stays on this fake screen: a look that was not called off would press Enter again.
    await h.advance(2000);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.request(), { phase: 'requested', atMs: clickMs, reason: '' });
    assert.equal(h.header().note, null);
  }));

  await t.test('a wrapped input row counts as seen', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    await h.click('primary');
    h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + REQUEST_LINE.slice(0, 30);
    h.knobs.rows[PROMPT_CURSOR_ROW + 1] = REQUEST_LINE.slice(30);
    h.knobs.rows[PROMPT_CURSOR_ROW + 2] = PROMPT_RULE;
    h.knobs.cursorY = PROMPT_CURSOR_ROW + 1;
    await h.advance(250);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  }));

  await t.test('a slash-command menu under the box does not stand in for the box, and does not stop the Enter', () => withHold(true, async () => {
    const h = await bootUltra(false);
    await clickUltra(h);
    h.knobs.rows[PROMPT_CURSOR_ROW + 2] = PROMPT_POINTER + ' /effort ultracode   Turn ultracode on';
    h.knobs.rows[PROMPT_CURSOR_ROW + 3] = '  /effort high';
    await h.advance(250);
    assert.deepEqual(h.sent, [[SID, '/effort ultracode'], [SID, '\r']]);
  }));

  await t.test('a question that opens between the text and its Enter is not answered', () => withHold(true, async () => {
    const h = await bootEnded();
    await h.click('primary');
    await h.advance(100);
    h.knobs.rows[40] = PROMPT_RULE;
    h.knobs.rows[41] = '  Do you want to proceed?';
    h.knobs.rows[42] = '  ' + PROMPT_POINTER + ' 1. Yes';
    h.knobs.rows[43] = '    2. No';
    h.knobs.rows[45] = '  Enter to confirm \u00b7 Esc to cancel';
    h.knobs.cursorY = 53;
    await h.advance(1200);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'the typed line is in the box; the Enter is not sent');
    assert.equal(h.request().unsent, true);
  }));

  await t.test('the line showing on another session\'s screen is not this session\'s', () => withHold(true, async () => {
    const h = await bootEnded();
    const otherKnobs = { rows: emptyPromptScreen(), scrollback: [], viewTop: null, cursorY: PROMPT_CURSOR_ROW };
    h.knobs.other = fakeTerminal(otherKnobs);
    h.run(`window._openSessions.set('${NEW_SID}', { terminal: __knobs.other })`);
    h.knobs.echo = false;
    await h.click('primary');
    otherKnobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + REQUEST_LINE;
    h.run(`activeSessionId = '${NEW_SID}'`);
    await h.advance(1300);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  }));

  await t.test('typed over your own text: the box says so, the line is not sent, and the next click asks first', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + 'my own text';
    await h.tick();
    assert.equal(h.header().primaryOverride, true);
    await h.click('primary');
    assert.equal(h.confirms.length, 1);
    assert.ok(h.confirms[0].startsWith('There is text in this session\'s input box.'), h.confirms[0]);
    assert.ok(h.confirms[0].includes('Type "Write the context handoff now. [ctx-handoff:request]" into this session anyway?'), h.confirms[0]);
    assert.ok(h.confirms[0].endsWith(BOX_HELD_LINE), h.confirms[0]);
    await h.advance(500);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    await h.advance(1300);
    assert.equal(h.sent.length, 1, 'no Enter: the box does not start with the line');
    assert.equal(h.knobs.rows[PROMPT_CURSOR_ROW], PROMPT_BOX_EMPTY + 'my own text' + REQUEST_LINE);
    assert.equal(h.request().unsent, true);
    assert.equal(h.header().note, NOT_SENT);
    assert.equal(h.header().primary, 'Hand off');
    assert.equal(h.header().primaryOverride, true);
    assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'),
      'There is text in this session\'s input box. Click to type the request anyway (asks first).');
  }));
});

test('browser: an unsent Hand off goes with the session through a fork and through a reload', async (t) => {
  await t.test('a fork between two looks: the Enter goes to the new id', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    await h.click('primary');
    await h.advance(300);
    await forkEvent(h, SID, NEW_SID);
    h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + REQUEST_LINE;   // the same terminal, now under the new id
    await h.advance(100);   // the look at 400
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [NEW_SID, '\r']]);
  }));

  await t.test('a fork, and the text never shows: the flag is on the record under the new id', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    await h.click('primary');
    await h.advance(300);
    await forkEvent(h, SID, NEW_SID);
    await h.advance(1000);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    assert.equal(JSON.parse(h.run(`JSON.stringify(handoffRt.cache.get('${NEW_SID}').request)`)).unsent, true);
    assert.equal(JSON.parse(h.storage.get('handoff-request:' + NEW_SID)).unsent, true);
    assert.equal(h.storage.has('handoff-request:' + SID), false);
  }));

  await t.test('a reload of the window keeps the flag', () => withHold(true, async () => {
    const storage = new Map();
    const first = await bootEnded({ storage });
    first.knobs.echo = false;
    const clickMs = first.now;
    await first.click('primary');
    await first.advance(1300);
    assert.deepEqual(JSON.parse(storage.get('handoff-request:' + SID)), { phase: 'timeout', atMs: clickMs, reason: '', unsent: true });
    const second = boot({ storage, startMs: first.now + 1000 });
    second.setSidecar(VM_SIDECAR);
    second.setState(endedState(first));
    await second.refresh();
    assert.deepEqual(second.request(), { phase: 'timeout', atMs: clickMs, reason: '', unsent: true });
    assert.equal(second.header().note, NOT_SENT);
    assert.equal(second.header().primary, 'Hand off');
  }));
});

test('browser: an Ultracode line whose Enter was held back says "Typed but not sent", not "No confirmation seen"', () => withHold(true, async () => {
  const h = await bootUltra(false);
  h.knobs.echo = false;
  await clickUltra(h);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode']]);
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  await h.advance(1299);
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  assert.equal(h.header().primaryEnabled, false, 'Hand off waits for the switch (B12)');
  await h.advance(1);
  assert.equal(h.sent.length, 1, 'no Enter');
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: true, asksFirst: false, look: 'off',
    title: 'Ultracode is off. Click to switch it on.',
  });
  assert.equal(h.header().note, NOT_SENT);
  assert.equal(h.header().primaryEnabled, true, 'Hand off is back');
  // The looks for the program's answer were dropped with it.
  h.knobs.rows[12] = '  ' + ON_LINE;
  await h.advance(6000);
  assert.equal(ultraHeader(h).look, 'off');
  assert.equal(h.header().note, NOT_SENT, 'never replaced by "No confirmation seen"');
  assert.equal(h.storage.has(ULTRA_KEY), false);
  await h.ticks(55);    // 61 s after the note was set
  assert.equal(h.header().note, null);
  assert.deepEqual(h.errors, []);
}));

test('browser: the Ultracode looks count from the Enter: with an Enter held 1.3 s the confirmation is still seen', () => withHold(true, async () => {
  const h = await bootUltra(false);
  h.knobs.echo = false;
  await clickUltra(h);
  await h.advance(1000);
  h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + '/effort ultracode';   // the text shows late
  await h.advance(300);   // the look at 1300 sends the Enter
  assert.deepEqual(h.sent, [[SID, '/effort ultracode'], [SID, '\r']]);
  await h.advance(4900);  // 6200 after the click: later than every look counted from the click
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  h.knobs.rows[12] = '  ' + ON_LINE;
  await h.advance(99);
  assert.equal(ultraHeader(h).look, 'off');
  await h.advance(1);     // 5000 after the Enter
  assert.equal(ultraHeader(h).look, 'on');
  assert.equal(h.header().note, null);
}));

test('browser: Enter goes without a look only after a yes on a screen that could not be read at the click', async (t) => {
  await t.test('no terminal in this window, asked first, yes: Enter 250 ms after the text', () => withHold(true, async () => {
    const h = await bootEnded();
    h.run('window._openSessions = new Map()');
    await h.tick();
    assert.equal(h.header().primaryOverride, true);
    assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'),
      'Switchboard cannot see an empty prompt on this session\'s screen. Click to type the request anyway (asks first).');
    await h.click('primary');
    assert.equal(h.confirms.length, 1);
    await h.advance(500);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    await h.advance(249);
    assert.equal(h.sent.length, 1);
    await h.advance(1);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
    await h.advance(2000);
    assert.equal(h.sent.length, 2);
    assert.equal(h.request().phase, 'requested');
    assert.ok(!h.request().unsent);
  }));

  await t.test('a screen that can be read but is not recognised, asked first, yes: the Enter is held', () => withHold(true, async () => {
    const h = await bootEnded();
    h.knobs.rows[PROMPT_CURSOR_ROW - 1] = '';   // no rule row above the pointer: not an input box
    await h.tick();
    assert.equal(h.header().primaryOverride, true);
    await h.click('primary');
    await h.advance(500);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    await h.advance(1300);
    assert.equal(h.sent.length, 1);
    assert.equal(h.request().unsent, true);
  }));

  await t.test('a plain click, and the screen cannot be read at the looks: not sent', () => withHold(true, async () => {
    const h = await bootEnded();
    await h.click('primary');
    assert.equal(h.confirms.length, 0);
    h.run('window._openSessions = new Map()');
    await h.advance(1300);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    assert.equal(h.request().unsent, true);
  }));

  await t.test('the page loaded without prompt-screen.js: asked first, and the Enter is held', () => withHold(true, async () => {
    const h = await bootEnded({ promptScreen: false });
    assert.equal(h.header().primaryOverride, true);
    await h.click('primary');
    assert.equal(h.confirms.length, 1);
    await h.advance(500);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
    await h.advance(1300);
    assert.equal(h.sent.length, 1);
    assert.equal(h.request().unsent, true);
  }));
});

test('browser: with ENTER_HOLD off the Enter follows 250 ms after the text whatever the screen shows, and the box shows T1\'s line', async (t) => {
  await t.test('Hand off', () => withHold(false, async () => {
    const h = await bootEnded();
    h.knobs.echo = false;
    const clickMs = h.now;
    await h.click('primary');
    await h.advance(249);
    assert.equal(h.sent.length, 1);
    await h.advance(1);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
    await h.advance(2000);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.request(), { phase: 'requested', atMs: clickMs, reason: '' });
    assert.equal(h.header().note, null);
  }));

  await t.test('Ultracode: no "Typed but not sent"; the looks still count from the Enter', () => withHold(false, async () => {
    const h = await bootUltra(false);
    h.knobs.echo = false;
    await clickUltra(h);
    await h.advance(250);
    assert.deepEqual(h.sent, [[SID, '/effort ultracode'], [SID, '\r']]);
    await h.advance(4999);
    assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
    await h.advance(1);
    assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
  }));

  await t.test('the box over your own text', () => withHold(false, async () => {
    const h = await bootEnded();
    h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + 'my own text';
    await h.tick();
    await h.click('primary');
    assert.ok(h.confirms[0].startsWith('There is text in this session\'s input box.'), h.confirms[0]);
    assert.ok(h.confirms[0].endsWith(BOX_SENT_LINE), h.confirms[0]);
    await h.advance(750);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  }));
});

test('ctx-handoff: one place sends a typed line and its Enter', () => {
  const lines = SOURCE.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('function handoffTypeLine('));
  assert.ok(start > 0, 'handoffTypeLine is a top-level function');
  const end = lines.findIndex((line, index) => index > start && /^(async )?function /.test(line));
  const code = (line) => !/^\s*(\/\/|\*|\/\*)/.test(line);
  const sends = lines.map((line, index) => ({ line, index })).filter(({ line }) => code(line) && /\bsendInput\(/.test(line));
  assert.equal(sends.length, 2, 'the text, and the Enter');
  for (const { line, index } of sends) assert.ok(index > start && index < end, `ctx-handoff.js:${index + 1} ${line.trim()}`);
  assert.equal(sends.filter(({ line }) => line.includes('entry.id')).length, 2, 'both go to entry.id');
  assert.equal(sends.filter(({ line }) => line.includes('\'\\r\'')).length, 1, 'one line sends the Enter');
});

// ── four more: Jason's answer CK-I, and five states found by the check of the plan ──

test('browser: a line that shows only after the last look is never sent, and a second "Type it anyway" over it holds the doubled line', () => withHold(true, async () => {
  const h = await bootEnded();
  h.knobs.echo = false;
  await h.click('primary');
  await h.advance(1300);   // the last look: typed but not sent
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  assert.equal(h.request().unsent, true);
  // The slow echo arrives 100 ms after the last look: the app's own line now sits in the box.
  await h.advance(100);
  h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + REQUEST_LINE;
  h.knobs.echo = true;
  await h.advance(3000);
  await h.tick();
  assert.equal(h.sent.length, 1, 'no Enter at any later time');
  assert.equal(h.request().unsent, true);
  assert.equal(h.header().note, NOT_SENT);
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryOverride, true, 'the next click follows the screen: text in the box');
  assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'),
    'There is text in this session\'s input box. Click to type the request anyway (asks first).');
  // CK-I: "Type it anyway" over the app's own unsent line types the line a second time behind it.
  await h.click('primary');
  assert.equal(h.confirms.length, 1);
  assert.ok(h.confirms[0].endsWith(BOX_HELD_LINE), h.confirms[0]);
  await h.advance(500);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, REQUEST_LINE]]);
  assert.equal(h.knobs.rows[PROMPT_CURSOR_ROW], PROMPT_BOX_EMPTY + REQUEST_LINE + REQUEST_LINE, 'the line stands in the box twice');
  await h.advance(1300);
  assert.equal(h.sent.length, 2, 'no Enter: a doubled line is not sent');
  assert.equal(h.request().unsent, true);
  assert.equal(h.header().note, NOT_SENT, 'B8\'s note shows again');
}));

test('browser: with two sessions in the window the typing path keeps to the session that was clicked', async (t) => {
  // A second session of this window: running, its turn ended, at an empty prompt in a terminal of its own.
  const addSecond = async (h) => {
    h.knobs.other = fakeTerminal({ rows: emptyPromptScreen(), scrollback: [], viewTop: null, cursorY: PROMPT_CURSOR_ROW });
    h.run(`window._openSessions.set('${NEW_SID}', { terminal: __knobs.other });
      sessionMap.set('${NEW_SID}', { sessionId: '${NEW_SID}', projectPath: 'C:/proj', type: 'claude' });
      activePtyIds = new Set(['${SID}', '${NEW_SID}']);
      sessionBusyState.set('${NEW_SID}', false);`);
    h.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify(VM_SIDECAR));
    h.files.set(VM_DIR + '\\' + NEW_SID + '.state.json', JSON.stringify(endedState(h)));
    h.listeners.busy(NEW_SID, false);
    await h.run(`handoffRefresh('${NEW_SID}')`);
    await flush();
  };
  const view = async (h, id) => { h.run(`activeSessionId = '${id}'`); await h.tick(); };
  const requestOf = (h, id) => JSON.parse(h.run(`JSON.stringify(handoffRt.cache.get('${id}').request)`));

  await t.test('Hand off: the hold gives up while the other session is in view', () => withHold(true, async () => {
    const h = await bootEnded();
    await addSecond(h);
    h.knobs.echo = false;
    await h.click('primary');
    await h.advance(100);
    await view(h, NEW_SID);
    await h.advance(1200);   // the last look, 1300 after the text
    await h.tick();
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE]], 'no Enter, to either session');
    assert.equal(requestOf(h, SID).unsent, true, 'the record of the session that was clicked');
    assert.equal(h.header().primary, 'Hand off', 'the header is the other session\'s');
    assert.equal(h.header().note, null, 'and nothing is drawn on it');
    // Back in view inside the 60 seconds: the note is there. After them it is gone.
    await h.advance(3700);
    await view(h, SID);
    assert.equal(h.header().note, NOT_SENT);
    await h.ticks(57);       // 62 s after the click
    assert.equal(h.header().note, null);
  }));

  await t.test('Ultracode: the same, and the switch of the clicked session is dropped', () => withHold(true, async () => {
    const h = await bootUltra(false);
    await addSecond(h);
    h.knobs.echo = false;
    await clickUltra(h);
    await h.advance(100);
    await view(h, NEW_SID);
    await h.advance(1200);
    await h.tick();
    assert.deepEqual(h.sent, [[SID, '/effort ultracode']]);
    assert.equal(h.header().note, null, 'nothing on the header of the session in view');
    assert.equal(h.run(`handoffRt.cache.get('${SID}').ultraSwitch`), null);
    await h.advance(3700);
    await view(h, SID);
    assert.equal(ultraHeader(h).label, 'Ultracode');
    assert.equal(h.header().note, NOT_SENT);
    await h.ticks(57);
    assert.equal(h.header().note, null);
  }));

  await t.test('two lines on their way at once: each path looks at its own screen and sends to its own id', () => withHold(true, async () => {
    const h = await bootEnded();
    await addSecond(h);
    h.knobs.echo = false;          // the first session's line does not show; the second session's does
    await h.click('primary');      // the first session
    await h.advance(300);
    await view(h, NEW_SID);
    assert.equal(h.header().primaryOverride, false, 'the second session is at an empty prompt');
    await h.click('primary');      // the second session
    await h.advance(250);
    assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [NEW_SID, REQUEST_LINE], [NEW_SID, '\r']]);
    await h.advance(1050);         // 1600 after the first click: every look of both paths is over
    assert.equal(h.sent.length, 3, 'the first session gets no Enter, the second no second one');
    assert.equal(requestOf(h, SID).unsent, true);
    assert.equal(requestOf(h, NEW_SID).phase, 'requested');
    assert.ok(!requestOf(h, NEW_SID).unsent);
  }));
});

test('browser: Update types through the same path: its Enter is held too, and Update can be clicked again', () => withHold(true, async () => {
  const w = await bootUltra(false);
  w.setHandoffFile(true);
  w.setState(writtenVmState(w, { ultracode: false }));
  await w.refresh();
  assert.equal(w.header().update, true);
  w.knobs.echo = false;
  const clickMs = w.now;
  await w.click('update');
  assert.deepEqual(w.sent, [[SID, REQUEST_LINE]]);
  await w.advance(1300);
  assert.deepEqual(w.sent, [[SID, REQUEST_LINE]], 'no Enter');
  assert.deepEqual(w.request(), { phase: 'timeout', atMs: clickMs, reason: '', unsent: true });
  assert.equal(w.header().note, NOT_SENT);
  assert.equal(w.header().primary, 'Continue in new session');
  assert.equal(w.header().update, true);
  assert.equal(w.byId['handoff-update-btn'].getAttribute('aria-disabled'), 'false', 'Update can be clicked again');
}));

test('browser: an Enter whose write throws does not leave the switch waiting: the looks are armed all the same', () => withHold(true, async () => {
  const h = await bootUltra(false);
  h.run(`{
    const send = window.api.sendInput;
    window.api.sendInput = (id, data) => {
      if (data.length === 1 && data.charCodeAt(0) === 13) throw new Error('the write of the Enter failed');
      send(id, data);
    };
  }`);
  await clickUltra(h);
  await h.advance(250);
  assert.deepEqual(h.sent, [[SID, '/effort ultracode']], 'the Enter never left');
  assert.equal(h.errors.length, 1, 'logged, once');
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  await h.advance(4999);
  assert.equal(ultraHeader(h).label, `Ultracode${ELLIPSIS}`);
  await h.advance(1);   // the last look, 5000 after the Enter was tried
  assert.equal(ultraHeader(h).label, 'Ultracode', 'not left saying it is switching');
  assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
  assert.equal(h.header().primaryEnabled, true, 'Hand off does not wait for a reload (B12)');
  assert.equal(h.errors.length, 1);
}));

// ── the hand-typed record is gone (ready state, commit 4; decision 2) ──────

test('ctx-handoff: the hand-typed record is gone from the window code', () => {
  const gone = /draftOpen|handoffNoteTyped|handoffSetTyped|handoffStoreTyped|handoffRestoreTyped|parseStoredTyped|HANDOFF_TYPED_PREFIX|handoff-typed|noteTypedByHand/;
  for (const file of ['ctx-handoff.js', 'terminal-manager.js']) {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => assert.doesNotMatch(line, gone, `${file}:${index + 1}`));
  }
  const mod = require(MODULE_PATH);
  for (const name of ['draftOpen', 'parseStoredTyped', 'handoffNoteTyped']) assert.equal(name in mod, false, name);
  assert.equal('noteTypedByHand' in require('../public/terminal-manager'), false);
});

test('terminal-manager: what is typed by hand is still sent, from the same five places', () => {
  const lines = fs.readFileSync(TERMINAL_MANAGER, 'utf8').split(/\r?\n/);
  assert.equal(lines.filter(line => /^\s*window\.api\.sendInput\((.*)\);\s*$/.test(line)).length, 5);
  assert.equal(lines.filter(line => line.includes('sendInput(')).length, 5, 'a send in a spelling this scan does not read');
});

test('ultracodeModel: a key typed by hand without Enter does not make it ask first (the screen decides)', () => {
  const empty = { state: 'empty', why: '' };
  const model = ultracodeModel(ultraArgs({ screen: empty, typed: { atMs: STOP_MS + 1, enter: false } }));
  assert.equal(model.enabled, true);
  assert.equal(model.override, false);
  assert.equal(model.title, 'Ultracode is off. Click to switch it on.');
  // What the screen shows still decides, for Ultracode as for Hand off.
  const draft = { state: 'draft', why: '' };
  assert.equal(ultracodeModel(ultraArgs({ screen: draft })).override, true);
  assert.equal(buttonModel(buttonArgs({ screen: draft })).primary.override, true);
});

test('browser: no entry and no input carries a hand-typed record', async () => {
  const h = await bootUltra(false);
  assert.equal('typed' in h.inputs(), false);
  assert.equal(h.run(`'typed' in handoffRt.cache.get('${SID}')`), false);
  assert.equal(h.run('typeof handoffNoteTyped'), 'undefined');
  assert.equal([...h.storage.keys()].some(key => key.startsWith('handoff-typed:')), false);
});

test('browser: after "No confirmation seen" or a refusal the next click follows the screen', async (t) => {
  await t.test('an empty box: a plain click, for Ultracode and for Hand off', async () => {
    const h = await bootUltra(false);
    await clickUltra(h);
    await h.advance(5250);   // the Enter at 250, the last look 5 s after it
    assert.equal(h.header().note, ULTRACODE_NOT_CONFIRMED);
    assert.deepEqual(ultraHeader(h), {
      shown: true, label: 'Ultracode', enabled: true, asksFirst: false, look: 'off',
      title: 'Ultracode is off. Click to switch it on.',
    });
    assert.equal(h.header().primaryOverride, false);
    await clickUltra(h);
    assert.equal(h.confirms.length, 0);
    assert.deepEqual(h.sent[2], [SID, '/effort ultracode']);
  });

  await t.test('text in the box: both buttons ask first, with the same reason', async () => {
    const h = await bootUltra(false);
    h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + '/effort ultracode';
    await h.tick();
    assert.equal(ultraHeader(h).asksFirst, true);
    assert.equal(ultraHeader(h).title,
      'Ultracode is off. There is text in this session\'s input box. Click to switch it on anyway (asks first).');
    assert.equal(h.header().primaryOverride, true);
    assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'),
      'There is text in this session\'s input box. Click to type the request anyway (asks first).');
  });

  await t.test('a refusal: a plain click', async () => {
    const h = await bootUltra(false);
    await clickUltra(h);
    await h.advance(250);
    h.knobs.rows[12] = 'Ultracode isn\'t available on haiku';
    await h.advance(1000);
    assert.equal(h.header().note, ULTRACODE_NO_MODEL);
    assert.equal(ultraHeader(h).asksFirst, false);
  });
});

// ── part M: a busy session whose turn has ended ─────────────────────────────
// Claude Code 2.1.296 keeps its spinner title on after a turn ends while a
// workflow is pending, so busy stays true for the whole run. Busy refuses only
// while the turn has not ended (no Stop after the last prompt, a spinner after
// the Stop, or no Stop since the last line typed here); once it has, the checks
// of an idle session decide. lastBusyAtMs: the spinner came on when the turn
// started, before its Stop, and never went off.
const WAITING = { busy: true, busyKnown: true, lastBusyAtMs: STOP_MS - 5000 };

test('typingGate: busy, turn ended, empty prompt: Hand off types plainly', () => {
  // null: a reloaded window, told busy by main, has seen no event at all.
  for (const lastBusyAtMs of [STOP_MS - 5000, STOP_MS, null]) {
    const args = buttonArgs({ ...WAITING, lastBusyAtMs, screen: scr('empty') });
    assert.deepEqual(gateFacts(typingGate(args)), { allowed: true, override: false, reason: '', advice: '' }, String(lastBusyAtMs));
    const hand = buttonModel(args).primary;
    assert.deepEqual({ kind: hand.kind, enabled: hand.enabled, override: hand.override, title: hand.title },
      { kind: 'handoff', enabled: true, override: false, title: 'Ask this session to write its context handoff' }, String(lastBusyAtMs));
  }
});

test('typingGate: busy, turn ended, text in the box: asks first and names the text', () => {
  const args = buttonArgs({ ...WAITING, screen: scr('draft') });
  const gate = typingGate(args);
  assert.deepEqual(gateFacts(gate), { allowed: true, override: true, reason: TEXT_IN_BOX, advice: '' });
  assert.equal(buttonModel(args).primary.title, TEXT_IN_BOX + '. Click to type the request anyway (asks first).');
  assert.equal(gateText(gate, 'box', { line: REQUEST_LINE, hold: true }).split('\n\n')[0], TEXT_IN_BOX + '.');
});

test('typingGate: busy, turn ended, a screen it cannot read: asks first', () => {
  for (const screen of [scr('unknown'), undefined, null]) {
    const args = buttonArgs({ ...WAITING, screen });
    assert.deepEqual(gateFacts(typingGate(args)), { allowed: true, override: true, reason: NO_PROMPT, advice: '' }, JSON.stringify(screen));
    const hand = buttonModel(args).primary;
    assert.equal(hand.enabled, true, JSON.stringify(screen));
    assert.equal(hand.override, true, JSON.stringify(screen));
  }
});

test('typingGate: busy, turn ended, a question on the screen: refused, "Session is asking you something"', () => {
  const args = buttonArgs({ ...WAITING, screen: scr('question') });
  assert.deepEqual(gateFacts(typingGate(args)), { allowed: false, override: false, reason: ASKING, advice: 'Answer it in the terminal first.' });
  const hand = buttonModel(args).primary;
  assert.equal(hand.enabled, false);
  assert.equal(hand.override, false);
  assert.equal(hand.title, ASKING + '. Answer it in the terminal first.');
});

test('typingGate: busy, turn ended, this window not told: asks first', () => {
  for (const busyKnown of [false, undefined]) {
    assert.deepEqual(gateFacts(typingGate(buttonArgs({ ...WAITING, busyKnown }))),
      { allowed: true, override: true, reason: REASON_NOT_TOLD, advice: '' }, String(busyKnown));
  }
});

test('typingGate: busy with the turn not ended: refused, "Session is working", whatever the screen', () => {
  const notEnded = [
    ['prompt after the stop', { state: hookState({ last_prompt_at: 1020, last_stop_at: 1010 }) }],
    ['never stopped', { state: hookState({ last_prompt_at: 1000, last_stop_at: null }) }],
  ];
  for (const [name, over] of notEnded) {
    for (const screen of [scr('empty'), scr('draft'), scr('unknown'), scr('question')]) {
      const args = buttonArgs({ ...WAITING, ...over, screen });
      assert.deepEqual(gateFacts(typingGate(args)), { allowed: false, override: false, reason: WHY_BUSY, advice: '' }, `${name} / ${screen.state}`);
      assert.equal(buttonModel(args).primary.title, WHY_BUSY, `${name} / ${screen.state}`);
    }
  }
});

test('typingGate: busy, a Stop recorded but a busy event after it: refused', () => {
  for (const lastBusyAtMs of [STOP_MS + 1, STOP_MS + 60000]) {
    const args = buttonArgs({ ...WAITING, lastBusyAtMs });
    assert.deepEqual(gateFacts(typingGate(args)), { allowed: false, override: false, reason: WHY_BUSY, advice: '' }, String(lastBusyAtMs));
  }
});

test('typingGate: busy, turn ended but a line was typed here after the Stop: refused', () => {
  for (const request of [{ phase: 'idle', atMs: STOP_MS + 5000, reason: '' }, { phase: 'timeout', atMs: STOP_MS + 5000, reason: 'x' }]) {
    const args = buttonArgs({ ...WAITING, request });
    assert.deepEqual(gateFacts(typingGate(args)), { allowed: false, override: false, reason: WHY_BUSY, advice: '' }, request.phase);
  }
});

test('typingGate: busy with no state file, or one without the turn keys: refused, as before', () => {
  for (const [name, state] of [['null', null], ['undefined', undefined], ['old hook', oldHookState()]]) {
    for (const lastBusyAtMs of [null, STOP_MS - 5000]) {
      const args = buttonArgs({ ...WAITING, state, lastBusyAtMs });
      assert.deepEqual(gateFacts(typingGate(args)), { allowed: false, override: false, reason: WHY_BUSY, advice: '' }, name);
      assert.equal(buttonModel(args).primary.title, WHY_BUSY, name);
      assert.equal(ultracodeModel({ ...args, ultracodeValue: true }).title, WHY_BUSY, name);
    }
  }
});

test('buttonModel and ultracodeModel: Update and Ultracode follow the gate for a busy session, ended or not', () => {
  const kind = (part) => (!part.enabled ? 'cannot' : part.override ? 'asks' : 'plain');
  const cases = [
    [{ screen: scr('empty') }, 'plain', ''],
    [{ screen: scr('draft') }, 'asks', TEXT_IN_BOX],
    [{ screen: scr('unknown') }, 'asks', NO_PROMPT],
    [{ screen: scr('question') }, 'cannot', ASKING],
    [{ state: writtenState({ last_prompt_at: 1020 }) }, 'cannot', WHY_BUSY],
    [{ lastBusyAtMs: STOP_MS + 1 }, 'cannot', WHY_BUSY],
  ];
  for (const [over, want, reason] of cases) {
    const name = JSON.stringify(over);
    const args = buttonArgs({ ...WAITING, state: writtenState(), handoffReadable: true, ...over });
    const gate = typingGate(args);
    const model = buttonModel(args);
    const ultra = ultracodeModel({ ...args, ultracodeValue: true, switching: false, headerOff: false });
    assert.equal(gate.reason, reason, name);
    assert.equal(model.primary.kind, 'continue', name);
    assert.equal(model.update.visible, true, name);
    assert.equal(kind(model.update), want, name);
    assert.equal(kind(ultra), want, name);
    if (want === 'plain') {
      assert.equal(model.update.title, 'Ask this session to write the handoff again', name);
      assert.equal(ultra.title, 'Ultracode is on. Click to switch it off.', name);
    } else if (want === 'cannot') {
      assert.equal(model.update.title, gateText(gate, 'tooltip'), name);
      assert.equal(ultra.title, model.update.title, name);
    }
  }
});

// A session whose turn has ended while its spinner stayed on (a workflow runs
// on): one busy event when the turn started, the hook's Stop 29 s later, no
// idle event. → { h, stopAt } (stopAt in seconds, as the hook writes it)
async function bootWaiting(opts, stateOver = {}) {
  const h = boot(opts);
  h.setSidecar(VM_SIDECAR);
  h.busyEvent(true);
  await h.advance(30000);
  const stopAt = h.sec - 1;
  h.setState(endedState(h, { last_prompt_at: h.sec - 31, last_stop_at: stopAt, ...stateOver }));
  await h.refresh();
  return { h, stopAt };
}

test('browser: a session whose spinner stays on after its turn ended gets a plain Hand off, and the click types', async () => {  // B1
  const { h, stopAt } = await bootWaiting();
  assert.equal(h.inputs().busy, true);
  assert.equal(h.inputs().busyKnown, true);
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, false);
  await h.click('primary');
  await h.advance(600);
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  // The line it typed is stamped later than the Stop, which is what stopAfterSent
  // reads once the request is idle again (4a-8 pins that rule). Here the button
  // shows "Writing…" meanwhile, so it cannot be clicked.
  assert.ok(h.request().atMs > stopAt * 1000);
  await h.advance(1000);
  await h.tick();
  assert.equal(h.header().primaryEnabled, false);
});

test('browser: the next prompt under the same spinner refuses again, "Session is working"', async () => {  // B2
  const { h, stopAt } = await bootWaiting();
  h.setState(endedState(h, { last_prompt_at: h.sec, last_stop_at: stopAt }));   // a scheduled prompt or a message
  await h.refresh();
  assert.equal(h.header().primaryEnabled, false);
  assert.equal(h.header().primaryOverride, false);
  assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'), WHY_BUSY);
  await h.click('primary');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
});

test('browser: after a reload, main saying busy with the turn ended gives a plain Hand off', async () => {  // B3
  const h = boot({ readCtxState: true });
  h.knobs.ctxReply = () => ctxReply(h, { busy: true });
  await h.refresh();
  assert.equal(h.inputs().busy, true);
  assert.equal(h.inputs().busyKnown, true);
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, false);
  await h.click('primary');
  await h.advance(600);
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
});

test('browser: a turn that starts under the spinner while the box is open is not typed into', async () => {  // B4
  const { h, stopAt } = await bootWaiting();
  // The waiting screen of fact 5: the grey suggestion reads as text in the box,
  // and the workflow row under the status line (it starts with the pointer, at
  // column 0 here, the case that could pass for a box) is not a second box.
  h.knobs.rows[PROMPT_CURSOR_ROW] = PROMPT_BOX_EMPTY + 'keep going until the plan workflow finishes';
  h.knobs.rows[54] = PROMPT_POINTER + ' ◯ sidebar-plan-write ▰▰▰▰▰▰▰▰▰▱ 11/12 · 1h01m · ↓ 1.4m tokens';
  await h.tick();
  assert.equal(h.inputs().screen.state, 'draft');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, true);
  h.knobs.duringQuestion = () => h.setState(endedState(h, { last_prompt_at: h.sec, last_stop_at: stopAt }));
  h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
  await h.click('primary');
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.header().note, 'Not typed. Session is working.');
});

test('browser: Ultracode switches a busy session whose turn has ended, and refuses once a turn runs', async () => {  // B5
  // The spinner on with no busy event after the Stop: what the window holds while a workflow runs on.
  const h = await bootUltra(false);
  h.setBusy(true);
  await h.tick();
  assert.equal(h.inputs().busy, true);
  assert.equal(ultraHeader(h).enabled, true);
  assert.equal(ultraHeader(h).asksFirst, false);
  assert.equal(h.header().primaryEnabled, true);
  await clickUltra(h);
  await h.advance(600);
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.sent[0], [SID, '/effort ultracode']);

  const r = await bootUltra(false);
  r.setBusy(true);
  r.setState(endedState(r, { ultracode: false, last_prompt_at: r.sec }));
  await r.refresh();
  assert.equal(ultraHeader(r).enabled, false);
  assert.equal(ultraHeader(r).title, 'Session is working');
  await clickUltra(r);
  await r.advance(6000);
  assert.deepEqual(r.sent, []);
});

test('browser: a working line above the box of a busy session whose turn has ended: asks first, never plain', async () => {  // B7
  // The guard that is left when the state file has not caught up with a turn (R1).
  // The line must stand in the 20 rows above the box (prompt-screen.js:86),
  // not at row 12 where promptScreenWith puts its lines.
  const { h } = await bootWaiting();
  showEmptyPrompt(h);
  h.knobs.rows[48] = '✻ Pondering… (3s · esc to interrupt)';
  await h.tick();
  assert.equal(h.inputs().screen.state, 'unknown');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, true);
  h.knobs.confirmAnswer = false;
  await h.click('primary');
  await h.advance(1000);
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.sent, []);
});

test('browser: the recorded question on a busy session whose turn has ended: refused, nothing typed', async () => {  // B8
  const { h } = await bootWaiting();
  showQuestion(h);
  await h.tick();
  assert.equal(h.header().primaryEnabled, false);
  assert.equal(h.byId['handoff-primary-btn'].getAttribute('title'), ASKING_TIP);
  await h.click('primary');
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
});

test('browser: a plain click on a busy session reads the turn marker again first, and a turn started meanwhile is not typed into', async () => {  // B9
  const { h, stopAt } = await bootWaiting();
  assert.equal(h.header().primaryOverride, false);
  // A scheduled prompt under the same spinner: the hook stamped it, the cache has not read it.
  h.setState(endedState(h, { last_prompt_at: h.sec, last_stop_at: stopAt }));
  await h.click('primary');
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.header().note, 'Not typed. Session is working.');
});

test('browser: two quick clicks on a busy session type the request once', async () => {  // B10
  const { h } = await bootWaiting();
  await h.click('primary');
  await h.click('primary');
  await h.advance(1000);
  assert.equal(h.sent.filter(([, text]) => text === REQUEST_LINE).length, 1);
  assert.equal(h.inputs().clickNote, '');
});

test('browser: a plain Ultracode click on a busy session reads the turn marker again first', async () => {  // B11
  const h = await bootUltra(false);
  h.setBusy(true);
  await h.tick();
  assert.equal(ultraHeader(h).enabled, true);
  assert.equal(ultraHeader(h).asksFirst, false);
  h.setState(endedState(h, { ultracode: false, last_prompt_at: h.sec }));   // not read yet
  await clickUltra(h);
  await h.advance(6000);
  assert.deepEqual(h.sent, []);
});

test('browser: a second click while a busy click reads the marker again does nothing, even once the session has turned idle', async () => {  // K-1
  const { h } = await bootWaiting();
  await h.click('primary');
  await h.advance(100);
  h.busyEvent(false);
  await h.advance(10);
  await h.click('primary');
  assert.deepEqual(h.sent, []);
  await h.advance(1000);
  assert.equal(h.sent.filter(([, text]) => text === REQUEST_LINE).length, 1);
  assert.equal(h.inputs().clickNote, '');
});

test('browser: a re-key while a busy click reads the marker again leaves no id behind', async () => {  // M-2
  const { h } = await bootWaiting();
  await h.click('primary');
  h.listeners.fork(SID, NEW_SID);
  await h.advance(1000);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify([...handoffRt.rereading])')), []);
});

// ── the auto handoff switch (Task N) ───────────────────────────────────────
//
// The header's switch for the hook's opt-out marker, <claude-ctx>/<id>.off:
// the pure model first, then the page with main's two calls (readHandoffOff,
// setHandoffOff) answered from knobs. No file is made anywhere: the marker is
// a Set of ids in knobs.

const {
  autoHandoffModel, AUTO_ON_TITLE, AUTO_OFF_TITLE, AUTO_ENV_TITLE, AUTO_FAILED_OFF, AUTO_FAILED_ON, AUTO_REKEYED,
} = require(MODULE_PATH);

const AUTO_BTN = 'handoff-auto-btn';
const AUTO_WAIT_TITLE = 'Waiting for Switchboard to write the switch';
const AUTO_METER_TITLE = 'Automatic handoff prompts are off for this session. Hand off and Update still work.';

// A running session whose hook files were read, prompts on, shown in this window.
function autoArgs(over = {}) {
  return {
    isTerminal: false, running: true, headerOff: false, ownedElsewhere: false,
    hookSeen: true, off: false, env: false, saving: false, ...over,
  };
}

test('autoHandoffModel: hidden for a plain terminal, a session not running, a header that is not this session\'s, no hook files, or a value main has not told', () => {
  assert.equal(autoHandoffModel(autoArgs()).visible, true, 'the case the others are held against');
  const hidden = {
    'a plain terminal': { isTerminal: true },
    'a session not running': { running: false },
    'a header that is not this session\'s': { headerOff: true },
    'no hook files': { hookSeen: false },
    'a value main has not told (null)': { off: null },
    'a value main has not told (no key)': { off: undefined },
    'a value that is not true or false': { off: 'true' },
  };
  for (const [name, over] of Object.entries(hidden)) {
    for (const base of [{}, { off: true }, { env: true }, { saving: true }, { ownedElsewhere: true }]) {
      const model = autoHandoffModel(autoArgs({ ...base, ...over }));
      assert.equal(model.visible, false, name);
      assert.equal(model.enabled, false, name);
      assert.equal(model.target, null, name);
    }
  }
  // No input at all is hidden too, and no throw.
  for (const input of [undefined, null, {}]) assert.equal(autoHandoffModel(input).visible, false);
});

test('autoHandoffModel: on reads "Auto handoff on" and a click turns it off; off reads "Auto handoff off" and a click turns it on; each title says what a click does and that Hand off and Update still work', () => {
  assert.deepEqual(autoHandoffModel(autoArgs({ off: false })), {
    visible: true, label: 'Auto handoff on', look: 'on', enabled: true, target: true, title: AUTO_ON_TITLE,
  });
  assert.deepEqual(autoHandoffModel(autoArgs({ off: true })), {
    visible: true, label: 'Auto handoff off', look: 'off', enabled: true, target: false, title: AUTO_OFF_TITLE,
  });
  assert.match(AUTO_ON_TITLE, /^Automatic handoff prompts are on\b/);
  assert.match(AUTO_ON_TITLE, /Click to turn them off for this session\./);
  assert.match(AUTO_OFF_TITLE, /^Automatic handoff prompts are off for this session\./);
  assert.match(AUTO_OFF_TITLE, /Click to turn them back on\b/);
  for (const title of [AUTO_ON_TITLE, AUTO_OFF_TITLE]) assert.match(title, /Hand off and Update still work\./);
});

test('autoHandoffModel: off by CLAUDE_CTX_HANDOFF shows off, cannot be clicked, and the title names the variable', () => {
  for (const off of [false, true]) {
    assert.deepEqual(autoHandoffModel(autoArgs({ env: true, off })), {
      visible: true, label: 'Auto handoff off', look: 'off', enabled: false, target: null, title: AUTO_ENV_TITLE,
    }, `the marker ${off ? 'there' : 'not there'}`);
  }
  assert.match(AUTO_ENV_TITLE, /CLAUDE_CTX_HANDOFF/);
  // The environment's word comes before the other two reasons a click does nothing.
  assert.equal(autoHandoffModel(autoArgs({ env: true, ownedElsewhere: true })).title, AUTO_ENV_TITLE);
  assert.equal(autoHandoffModel(autoArgs({ env: true, saving: true })).title, AUTO_ENV_TITLE);
});

test('autoHandoffModel: shown in another window, or a write on its way: not clickable', () => {
  assert.deepEqual(autoHandoffModel(autoArgs({ ownedElsewhere: true, off: false })), {
    visible: true, label: 'Auto handoff on', look: 'on', enabled: false, target: null, title: WHY_OWNED,
  });
  assert.deepEqual(autoHandoffModel(autoArgs({ ownedElsewhere: true, off: true })), {
    visible: true, label: 'Auto handoff off', look: 'off', enabled: false, target: null, title: WHY_OWNED,
  });
  for (const off of [false, true]) {
    assert.deepEqual(autoHandoffModel(autoArgs({ saving: true, off })), {
      visible: true, label: `Auto handoff${ELLIPSIS}`, look: off ? 'off' : 'on', enabled: false, target: null, title: AUTO_WAIT_TITLE,
    }, `the marker ${off ? 'there' : 'not there'}`);
  }
  // Both at once: the other window's is the reason named.
  assert.equal(autoHandoffModel(autoArgs({ ownedElsewhere: true, saving: true })).title, WHY_OWNED);
});

test('autoHandoffModel: busy, a turn not ended, a question on the screen, a pending row or a stop that did not finish change nothing: it types nothing', () => {
  // Each of these keeps Hand off from typing plainly (typingGate). None of
  // them is an input of the switch.
  const stops = {
    'busy, its turn not ended': { busy: true, state: hookState({ last_stop_at: 900 }) },
    'a turn not ended': { state: hookState({ last_stop_at: 900 }) },
    'a question on the screen': { screen: scr('question') },
    'a pending row': { pendingRow: true },
    'a stop that did not finish': { didNotStop: true },
  };
  for (const off of [false, true]) {
    const calm = buttonArgs(autoArgs({ off }));
    assert.deepEqual(gateFacts(typingGate(calm)), { allowed: true, override: false, reason: '', advice: '' });
    const model = autoHandoffModel(calm);
    assert.equal(model.enabled, true);
    assert.equal(model.target, !off);
    for (const [name, over] of Object.entries(stops)) {
      const args = { ...calm, ...over };
      const gate = typingGate(args);
      assert.equal(gate.allowed && !gate.override, false, `${name}: Hand off does not type plainly`);
      assert.deepEqual(autoHandoffModel(args), model, `${name}, the marker ${off ? 'there' : 'not there'}`);
    }
  }
});

// What the switch shows, read off its element. No element: not shown.
function autoSwitch(h) {
  const btn = h.byId[AUTO_BTN];
  const shown = !!btn && btn.style.display !== 'none';
  return {
    shown,
    label: shown ? btn.textContent : null,
    enabled: shown && btn.getAttribute('aria-disabled') === 'false',
    look: shown ? (/handoff-auto-(on|off)/.exec(btn.className) || [])[1] : null,
    title: shown ? btn.getAttribute('title') : null,
  };
}
const AUTO_ON = { shown: true, label: 'Auto handoff on', enabled: true, look: 'on', title: AUTO_ON_TITLE };
const AUTO_OFF = { shown: true, label: 'Auto handoff off', enabled: true, look: 'off', title: AUTO_OFF_TITLE };

async function clickAuto(h) {
  h.byId[AUTO_BTN].listeners.click();
  await flush();
}

// The meter's state text ("handoff due", "handoff off") as it is on screen.
function autoMeterState(h) {
  const el = h.byId['handoff-meter'].children[2];
  return { shown: el.style.display !== 'none', text: el.textContent, className: el.className, title: el.getAttribute('title') };
}

// A promise the test settles when it chooses: main's answer, held back.
function autoDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// Boots as bootEnded does, then gives window.api main's two calls for the
// switch, answered from h.knobs, and reads again.
//   knobs.offFiles          the ids whose <id>.off is there, as main would find it
//   knobs.offEnv            CLAUDE_CTX_HANDOFF opts every session out
//   knobs.readOff(id)       what read-handoff-off answers (a value, a promise, or a throw = the invoke rejects)
//   knobs.setOff(id, off)   what set-handoff-off does and answers, the same way
//   knobs.offReads, knobs.offSets   the calls the page made, in order
// opts: off (the marker is there at the start), env, readOff, setOff.
async function bootAuto(opts = {}) {
  const h = await bootEnded();
  const knobs = h.knobs;
  knobs.offFiles = new Set(opts.off ? [SID] : []);
  knobs.offEnv = opts.env === true;
  knobs.offReads = [];
  knobs.offSets = [];
  knobs.readOff = opts.readOff || ((id) => ({ off: knobs.offFiles.has(id), env: knobs.offEnv }));
  // Main as it answers when the write works: the marker is made or deleted,
  // and the reply says what is there now, for the id it was asked with.
  knobs.setOff = opts.setOff || ((id, off) => {
    if (off) knobs.offFiles.add(id); else knobs.offFiles.delete(id);
    return { ok: true, off: knobs.offFiles.has(id), env: knobs.offEnv, code: null, id };
  });
  knobs.readHandoffOff = (id) => { knobs.offReads.push(id); return Promise.resolve().then(() => knobs.readOff(id)); };
  knobs.setHandoffOff = (id, off) => { knobs.offSets.push([id, off]); return Promise.resolve().then(() => knobs.setOff(id, off)); };
  h.run(`
    window.api.readHandoffOff = (id) => __knobs.readHandoffOff(id);
    window.api.setHandoffOff = (id, off) => __knobs.setHandoffOff(id, off);
  `);
  await h.refresh();
  return h;
}

// The hook's files for the id a fork gives the session: its header stays on.
function autoNewIdFiles(h) {
  h.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify(VM_SIDECAR));
  h.files.set(VM_DIR + '\\' + NEW_SID + '.state.json', JSON.stringify(endedState(h)));
}

// h.refresh() for a session under another id than SID.
async function autoRefresh(h, id) {
  await h.advance(600);
  await h.run(`handoffRefresh('${id}')`);
  await flush();
  h.run('handoffRenderHeader()');
}

test('browser: the auto handoff switch sits just after the meter, and Ultracode is still just before Hand off', async () => {
  const h = await bootAuto();
  const ids = h.byId['terminal-header-controls'].children.map(el => el.id);
  assert.ok(ids.includes('handoff-meter'));
  assert.equal(ids.indexOf('handoff-meter') + 1, ids.indexOf(AUTO_BTN));
  assert.equal(ids.indexOf('terminal-header-status') + 1, ids.indexOf('handoff-meter'), 'the meter is where it was');
  assert.equal(ids.indexOf('handoff-ultracode-btn') + 1, ids.indexOf('handoff-primary-btn'));
  const btn = h.byId[AUTO_BTN];
  assert.equal(btn.tag, 'button');
  assert.equal(btn.type, 'button');
  assert.ok(btn.className.split(' ').includes('handoff-btn-small'), btn.className);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
});

test('browser: a click turns automatic handoff prompts off through main, and a second click turns them back on', async () => {
  const h = await bootAuto();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.deepEqual([...h.knobs.offFiles], [SID], 'main made the marker');
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  await h.refresh();
  assert.deepEqual(autoSwitch(h), AUTO_OFF, 'the next read says the same');
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true], [SID, false]]);
  assert.deepEqual([...h.knobs.offFiles], [], 'main deleted it');
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  await h.advance(2000);
  assert.deepEqual(h.sent, [], 'nothing is typed into the session');
  assert.equal(h.confirms.length, 0, 'no box');
  assert.equal(h.header().note, null);
});

test('browser: a marker the session made itself shows as off at the next read, with no click', async () => {
  const h = await bootAuto();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  h.knobs.offFiles.add(SID);
  await h.refresh();
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  // ...and one it took away shows as on again.
  h.knobs.offFiles.delete(SID);
  await h.refresh();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  assert.deepEqual(h.knobs.offSets, []);
});

test('browser: while off the meter says "handoff off" where it said "handoff due"', async () => {
  const h = await bootAuto();
  h.setState(endedState(h, { pending: true, crossed_at: h.sec - 60 }));
  await h.refresh();
  assert.deepEqual(autoMeterState(h), {
    shown: true, text: 'handoff due', className: 'handoff-meter-state handoff-due',
    title: 'This session has passed its handoff threshold and has not written one yet',
  });
  h.knobs.offFiles.add(SID);
  await h.refresh();
  assert.deepEqual(autoMeterState(h), {
    shown: true, text: 'handoff off', className: 'handoff-meter-state handoff-off', title: AUTO_METER_TITLE,
  });
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  // Back on: due again.
  h.knobs.offFiles.delete(SID);
  await h.refresh();
  assert.equal(autoMeterState(h).text, 'handoff due');
});

test('browser: while off, Hand off and Update still type the request', async () => {
  const h = await bootAuto({ off: true });
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  assert.equal(h.header().primary, 'Hand off');
  await h.click('primary');
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  await h.advance(250);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  assert.equal(h.confirms.length, 0);

  // Update, beside Continue, on a session that has written a handoff.
  const u = await bootAuto({ off: true });
  u.setHandoffFile(true);
  u.setState(writtenVmState(u));
  await u.refresh();
  assert.deepEqual(autoSwitch(u), AUTO_OFF);
  assert.equal(u.header().update, true);
  await u.click('update');
  assert.deepEqual(u.sent, [[SID, REQUEST_LINE]]);
  await u.advance(250);
  assert.deepEqual(u.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  assert.equal(u.confirms.length, 0);
  for (const w of [h, u]) assert.deepEqual(w.knobs.offSets, [], 'neither click touched the marker');
});

test('browser: a switch that fails says so in the header note, opens no box, and shows what the file is', async () => {
  // The make failed and there is no marker.
  const h = await bootAuto();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  h.knobs.setOff = (id) => ({ ok: false, off: false, env: false, code: 'EPERM', id });
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.equal(h.header().note, AUTO_FAILED_OFF + ' (EPERM).');
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.sent, []);

  // The delete failed and the marker is still there; then a call that gets no
  // answer at all.
  const g = await bootAuto({ off: true });
  assert.deepEqual(autoSwitch(g), AUTO_OFF);
  g.knobs.setOff = (id) => ({ ok: false, off: true, env: false, code: 'EBUSY', id });
  await clickAuto(g);
  assert.equal(g.header().note, AUTO_FAILED_ON + ' (EBUSY).');
  assert.deepEqual(autoSwitch(g), AUTO_OFF);
  g.knobs.setOff = () => { throw new Error('the invoke rejected'); };
  await clickAuto(g);
  assert.deepEqual(g.knobs.offSets, [[SID, false], [SID, false]]);
  assert.equal(g.header().note, AUTO_FAILED_ON + '.');
  assert.deepEqual(autoSwitch(g), AUTO_OFF);
  assert.equal(g.confirms.length, 0);
  assert.deepEqual(g.sent, []);
});

test('browser: a read that went out before the click does not turn the switch back', async () => {
  const h = await bootAuto();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  // A read goes out, and main's answer about the marker is held back.
  const answer = h.knobs.readOff;
  h.knobs.readReply = autoDeferred();
  h.knobs.readOff = () => h.knobs.readReply.promise;
  await h.advance(600);
  const reads = h.knobs.offReads.length;
  h.run(`handoffRefresh('${SID}')`);
  await flush();
  assert.deepEqual(h.knobs.offReads.slice(reads), [SID], 'the read is out');
  h.knobs.readOff = answer;
  // The click, in the same millisecond: main makes the marker and says so.
  const clickMs = h.now;
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  // Now the held answer comes. It says what that read found: no marker yet.
  h.knobs.readReply.resolve({ off: false, env: false });
  await flush();
  assert.equal(h.now, clickMs, 'the clock did not move between the read and the click');
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  // A read sent after the click counts again.
  await h.refresh();
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  h.knobs.offFiles.delete(SID);
  await h.refresh();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
});

test('browser: two quick clicks on the switch write once', async () => {
  const h = await bootAuto();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  const write = h.knobs.setOff;
  h.knobs.setReply = autoDeferred();
  h.knobs.setOff = (id, off) => h.knobs.setReply.promise.then(() => write(id, off));
  await clickAuto(h);
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  h.knobs.setReply.resolve();
  await flush();
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  // The write is in: the next click is a new one.
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true], [SID, false]]);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
});

test('browser: a main without the two calls shows no switch and leaves the rest of the header as it was', async () => {
  // A page that has no such call at all: the header every test above this
  // section sees.
  const before = await bootEnded();
  // The new preload against a main started before the change: both invokes
  // reject, as readCtxState's does there (knobs.ctxFail 'reject').
  const noHandler = (channel) => () => { throw new Error(`Error invoking remote method '${channel}': No handler registered`); };
  const h = await bootAuto({ readOff: noHandler('read-handoff-off'), setOff: noHandler('set-handoff-off') });
  assert.equal(autoSwitch(h).shown, false);
  assert.deepEqual(h.header(), before.header());
  assert.deepEqual(h.header(), { meter: true, primary: 'Hand off', primaryEnabled: true, primaryOverride: false, update: false, note: null });
  assert.deepEqual(meterLook(h), meterLook(before));
  assert.equal(autoMeterState(h).text, autoMeterState(before).text);
  // The poll changes none of it, and the switch's element, where the page has
  // one, takes no click.
  await h.ticks(3);
  await before.ticks(3);
  if (h.byId[AUTO_BTN]) await clickAuto(h);
  assert.equal(autoSwitch(h).shown, false);
  assert.deepEqual(h.header(), before.header());
  assert.deepEqual(h.knobs.offSets, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirms.length, 0);
});

test('browser: off by CLAUDE_CTX_HANDOFF: the switch shows off and a click writes nothing', async () => {
  const h = await bootAuto({ env: true });
  assert.deepEqual(autoSwitch(h), { shown: true, label: 'Auto handoff off', enabled: false, look: 'off', title: AUTO_ENV_TITLE });
  assert.equal(autoMeterState(h).text, 'handoff off');
  await clickAuto(h);
  await h.advance(2000);
  assert.deepEqual(h.knobs.offSets, []);
  assert.deepEqual(autoSwitch(h), { shown: true, label: 'Auto handoff off', enabled: false, look: 'off', title: AUTO_ENV_TITLE });
});

test('browser: grid view and a task log hide the switch, and a click there writes nothing', async () => {
  const offs = { 'grid view': ['gridViewActive = true', 'gridViewActive = false'], 'a task log': ['activeTaskView = { id: 7 }', 'activeTaskView = null'] };
  for (const [name, [on, back]] of Object.entries(offs)) {
    const h = await bootAuto();
    assert.deepEqual(autoSwitch(h), AUTO_ON, name);
    h.run(on);
    // No render in between: the switch is still on screen until the next tick.
    await clickAuto(h);
    assert.deepEqual(h.knobs.offSets, [], name);
    await h.tick();
    assert.equal(autoSwitch(h).shown, false, name);
    await clickAuto(h);
    await h.advance(2000);
    assert.deepEqual(h.knobs.offSets, [], name);
    // Back in the session's own header it is there again, and works.
    h.run(back);
    await h.tick();
    assert.deepEqual(autoSwitch(h), AUTO_ON, name);
    await clickAuto(h);
    assert.deepEqual(h.knobs.offSets, [[SID, true]], name);
  }
});

test('browser: after a fork the switch reads the new id\'s marker', async () => {
  // Off under the old id; the new id has no marker.
  const h = await bootAuto({ off: true });
  autoNewIdFiles(h);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  const reads = h.knobs.offReads.length;
  await forkEvent(h, SID, NEW_SID);
  assert.deepEqual(h.knobs.offReads.slice(reads), [NEW_SID]);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  // ...and a click is for the new id.
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[NEW_SID, true]]);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);

  // On under the old id; the new id has a marker (main's detector made it).
  const g = await bootAuto();
  autoNewIdFiles(g);
  g.knobs.offFiles.add(NEW_SID);
  assert.deepEqual(autoSwitch(g), AUTO_ON);
  await forkEvent(g, SID, NEW_SID);
  assert.deepEqual(autoSwitch(g), AUTO_OFF);
});

test('browser: a re-key while the switch is being written does not show an answer for another id, and says to click again', async () => {
  const h = await bootAuto();
  autoNewIdFiles(h);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  h.knobs.setReply = autoDeferred();
  h.knobs.setOff = () => h.knobs.setReply.promise;
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  await forkEvent(h, SID, NEW_SID);
  // Past the 500 ms rule, so that the read the click asks for is a read.
  await h.advance(600);
  const reads = h.knobs.offReads.length;
  // An answer for the id the click was sent with: that id's marker was made,
  // not this session's.
  h.knobs.offFiles.add(SID);
  h.knobs.setReply.resolve({ ok: true, off: true, env: false, code: null, id: SID });
  await flush();
  assert.equal(h.header().note, AUTO_REKEYED);
  assert.deepEqual(h.knobs.offReads.slice(reads), [NEW_SID], 'the new id is read');
  assert.deepEqual(autoSwitch(h), AUTO_ON, 'the new id has no marker: the answer for the old id is not shown');
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.equal(h.confirms.length, 0);
});

test('browser: a fork between a click and its answer ends with the switch showing what was clicked', async () => {
  const h = await bootAuto();
  autoNewIdFiles(h);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  h.knobs.setReply = autoDeferred();
  h.knobs.setOff = () => h.knobs.setReply.promise;
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  await forkEvent(h, SID, NEW_SID);
  // Main had re-keyed before the write reached it: it made the live id's
  // marker and answers with that id.
  h.knobs.offFiles.add(NEW_SID);
  h.knobs.setReply.resolve({ ok: true, off: true, env: false, code: null, id: NEW_SID });
  await flush();
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  assert.equal(h.header().note, null);
  // The next read of the new id says the same.
  await autoRefresh(h, NEW_SID);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
});

test('browser: a switch click that fails while a Hand off request is out shows the file as it is, and its note once the request ends', async () => {
  const h = await bootAuto();
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  await h.click('primary');
  await h.advance(250);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  assert.equal(h.header().primary, `Writing${ELLIPSIS}`);
  h.knobs.setOff = (id) => ({ ok: false, off: false, env: false, code: 'EPERM', id });
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.deepEqual(autoSwitch(h), AUTO_ON, 'the file as it is: no marker');
  assert.equal(h.header().primary, `Writing${ELLIPSIS}`);
  assert.equal(h.header().note, null, 'no note beside "Writing…"');
  // The handoff is written half a minute later: the request ends, and the
  // note of the failed click is within its 60 s.
  const clickS = h.request().atMs / 1000;
  h.setHandoffFile(true);
  h.setState(endedState(h, {
    crossed_at: clickS + 0.2, written_at: clickS + 20, handoff_path: VM_HANDOFF,
    last_prompt_at: clickS + 0.2, last_stop_at: clickS + 25,
  }));
  await h.advance(30000);
  await h.refresh();
  assert.equal(h.request().phase, 'idle');
  assert.equal(h.header().primary, 'Continue in new session');
  assert.equal(h.header().note, AUTO_FAILED_OFF + ' (EPERM).');
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  assert.equal(h.confirms.length, 0);
});

test('browser: a click\'s write that is on its way blocks a second click after a fork too', async () => {
  const h = await bootAuto();
  autoNewIdFiles(h);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  h.knobs.setReply = autoDeferred();
  h.knobs.setOff = () => h.knobs.setReply.promise;
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  await forkEvent(h, SID, NEW_SID);
  // The second click, on the session under its new id, while the first write
  // is still out.
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  h.knobs.offFiles.add(NEW_SID);
  h.knobs.setReply.resolve({ ok: true, off: true, env: false, code: null, id: NEW_SID });
  await flush();
  assert.deepEqual(h.knobs.offSets, [[SID, true]]);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
});

test('browser: while off, a Hand off request leaves the meter at "handoff off" and the button at "Writing…"', async () => {
  const h = await bootAuto({ off: true });
  assert.equal(autoMeterState(h).text, 'handoff off');
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  await h.click('primary');
  await h.advance(250);
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [SID, '\r']]);
  // The hook took the request: a crossing of its own kind (manual), pending
  // until the file is written. With prompts on the meter would say "handoff due".
  const clickS = h.request().atMs / 1000;
  h.setState(endedState(h, { pending: true, manual: true, crossed_at: clickS + 0.2, last_prompt_at: clickS + 0.2 }));
  await h.refresh();
  assert.equal(h.inputs().state.manual, true);
  assert.equal(h.inputs().state.pending, true);
  assert.deepEqual(autoMeterState(h), {
    shown: true, text: 'handoff off', className: 'handoff-meter-state handoff-off', title: AUTO_METER_TITLE,
  });
  assert.equal(h.header().primary, `Writing${ELLIPSIS}`);
  assert.equal(h.header().primaryEnabled, false);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
});

test('browser: a switch click that works clears the note an earlier switch click left, and leaves a note another control wrote', async () => {
  // The write failed, and the note says so.
  const h = await bootAuto();
  const write = h.knobs.setOff;
  h.knobs.setOff = (id) => ({ ok: false, off: false, env: false, code: 'EPERM', id });
  await clickAuto(h);
  assert.equal(h.header().note, AUTO_FAILED_OFF + ' (EPERM).');
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  // The next click works: the switch reads off and the note of the failed one is gone.
  h.knobs.setOff = write;
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true], [SID, true]]);
  assert.deepEqual(autoSwitch(h), AUTO_OFF);
  assert.equal(h.header().note, null);

  // A note another control wrote stays when a switch click works.
  const NOTE = 'Not typed. The session changed.';
  h.run(`handoffSetClickNote(handoffRt.cache.get('${SID}'), ${JSON.stringify(NOTE)})`);
  assert.equal(h.header().note, NOTE);
  await clickAuto(h);
  assert.deepEqual(h.knobs.offSets, [[SID, true], [SID, true], [SID, false]]);
  assert.deepEqual(autoSwitch(h), AUTO_ON);
  assert.equal(h.header().note, NOTE);
  assert.equal(h.confirms.length, 0);
  assert.deepEqual(h.sent, []);

  // Each other note the switch writes goes too when a click works.
  for (const note of [AUTO_FAILED_ON + ' (EPERM).', AUTO_REKEYED]) {
    h.run(`handoffSetClickNote(handoffRt.cache.get('${SID}'), ${JSON.stringify(note)})`);
    assert.equal(h.header().note, note);
    await clickAuto(h);
    assert.equal(h.header().note, null);
  }
});

test("preload source check: 'session-forked' forwards four arguments", () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(preload.includes(
    "ipcRenderer.on('session-forked', (_event, oldId, newId, reason, info) => callback(oldId, newId, reason, info));"),
    'the reason and the clear time reach the windows');
  assert.equal(preload.split("ipcRenderer.on('session-forked'").length - 1, 1, 'one listener for the channel');
});

const {
  freshEntry, ENTRY_FIELD_CLASS, entryAfterClear, CLEAR_WAIT_REASON,
} = require('../public/ctx-handoff');

test('clear re-key: every field of a fresh handoff entry is classed as terminal or conversation', () => {
  const fresh = freshEntry(SID);
  // Every field has a class. The one name the table may hold that the entry
  // does not is `typed`: the hand-typed record, which its own commit removes
  // and a revert of that commit brings back.
  for (const field of Object.keys(fresh)) {
    assert.ok(ENTRY_FIELD_CLASS[field] === 'terminal' || ENTRY_FIELD_CLASS[field] === 'conversation',
      `the entry field "${field}" has no class: say whether it belongs to the terminal or to the conversation`);
  }
  for (const field of Object.keys(ENTRY_FIELD_CLASS)) {
    assert.ok(field in fresh || field === 'typed', `the table names "${field}", which a fresh entry does not have`);
  }
  assert.ok(Object.isFrozen(ENTRY_FIELD_CLASS));
  const terminal = Object.keys(ENTRY_FIELD_CLASS).filter((f) => ENTRY_FIELD_CLASS[f] === 'terminal').sort();
  assert.deepEqual(terminal, [
    'autoEnv', 'autoOff', 'autoSaving', 'autoSeq',
    'lastBusyAtMs', 'mainBusy', 'request', 'seenBusyEvent', 'typed',
    'ultraConfirmed', 'ultraNote', 'ultraNoteAtMs', 'ultraSwitch',
  ]);
  // A fresh entry reads nothing from storage.
  assert.equal(fresh.id, SID);
  assert.deepEqual(fresh.request, { phase: 'idle', atMs: 0, reason: '' });
  assert.equal(fresh.ultraConfirmed, null);
  assert.notEqual(freshEntry(SID), fresh, 'a new object each time');
  // The live entry is built from it: same fields, no more and no fewer.
  const h = boot();
  assert.deepEqual(
    JSON.parse(h.run(`JSON.stringify(Object.keys(handoffEntry('${SID}')).sort())`)),
    Object.keys(fresh).sort());
});

test('renderer: the entry after a clear (pure function)', async (t) => {
  const CLEARED = 1000000;        // info.clearedAtMs: when the hook saw the cleared session start
  const NOW = CLEARED + 4000;     // when the re-key reached this window
  const SWITCH = { target: 'off', atMs: 999000 };
  const old = (over = {}) => Object.assign(freshEntry(SID), {
    sidecar: VM_SIDECAR,
    state: { ultracode: false, last_stop_at: 10, handoff_path: 'C:\\h\\handoff.md', written_at: 5 },
    handoffReadable: true, readableFor: 5, readableCheckedAtMs: 77,
    request: { phase: 'idle', atMs: CLEARED - 1, reason: 'left over' },
    lastBusyAtMs: 900000, seenBusyEvent: true, mainBusy: false,
    notRunningSinceMs: 3, continueLockUntil: 9e15,
    continueError: 'an old Continue error', continueErrorAtMs: 55,
    pruneMarked: true, turn: { busyAtMs: 1, idleAtMs: 2 }, readAtMs: 88,
    ultraConfirmed: { value: true, atMs: 500000 }, ultraSwitch: SWITCH,
    ultraNote: 'a note about the last click', ultraNoteAtMs: 998000,
    autoOff: true, autoEnv: true, autoSeq: 3, autoSaving: true,
  }, over);
  const opts = { clearedAtMs: CLEARED, nowMs: NOW };

  await t.test('a new object with exactly the fields of a fresh entry; the old entry is untouched', () => {
    const before = old();
    const copy = JSON.stringify(before);
    const after = entryAfterClear(before, NEW_SID, opts);
    assert.notEqual(after, before);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(freshEntry(NEW_SID)).sort());
    assert.equal(JSON.stringify(before), copy);
    assert.equal(before.id, SID);
  });
  await t.test('every conversation field has its fresh value: no reading, state, watched turn, read time, handoff or Continue error of the old id', () => {
    const after = entryAfterClear(old(), NEW_SID, opts);
    const fresh = freshEntry(NEW_SID);
    for (const field of Object.keys(fresh)) {
      if (ENTRY_FIELD_CLASS[field] === 'conversation') assert.deepEqual(after[field], fresh[field], field);
    }
    assert.equal(after.id, NEW_SID);
    assert.equal(after.sidecar, null);
    assert.equal(after.state, null);
    assert.equal(after.turn, null);
    assert.equal(after.readAtMs, 0);
    assert.equal(after.handoffReadable, false);
    assert.equal(after.continueError, '');
    assert.equal(after.continueLockUntil, 0);
  });
  await t.test('the terminal facts are carried', () => {
    const after = entryAfterClear(old(), NEW_SID, opts);
    assert.equal(after.lastBusyAtMs, 900000);
    assert.equal(after.seenBusyEvent, true);
    assert.equal(after.mainBusy, false);
    assert.equal(after.ultraSwitch, SWITCH, 'the same record: a line on its way is still on its way');
    assert.equal(after.ultraNote, 'a note about the last click');
    assert.equal(after.ultraNoteAtMs, 998000);
    // Task N's switch (Jason's answer N-4): all four move with the entry.
    assert.equal(after.autoOff, true);
    assert.equal(after.autoEnv, true);
    assert.equal(after.autoSeq, 3);
    assert.equal(after.autoSaving, true);
    if ('typed' in freshEntry(SID)) {
      const typed = { atMs: 7, enter: false };
      assert.equal(entryAfterClear(old({ typed }), NEW_SID, opts).typed, typed);
    }
  });
  await t.test('the value Ultracode showed is carried as ultraConfirmed, stamped with the time of the re-key', () => {
    // Shown before: on (confirmed after the last Stop, although the hook still says off).
    assert.deepEqual(entryAfterClear(old(), NEW_SID, opts).ultraConfirmed, { value: true, atMs: NOW });
    // Shown before from the hook alone.
    const hookOnly = old({ ultraConfirmed: null, state: { ultracode: true, last_stop_at: 10 } });
    assert.deepEqual(entryAfterClear(hookOnly, NEW_SID, opts).ultraConfirmed, { value: true, atMs: NOW });
    const hookOff = old({ ultraConfirmed: null, state: { ultracode: false, last_stop_at: 10 } });
    assert.deepEqual(entryAfterClear(hookOff, NEW_SID, opts).ultraConfirmed, { value: false, atMs: NOW });
    // Not known before: nothing to carry.
    assert.equal(entryAfterClear(old({ ultraConfirmed: null, state: null }), NEW_SID, opts).ultraConfirmed, null);
  });
  await t.test('a request typed before the clear stays behind; one typed at or after it moves', () => {
    assert.deepEqual(entryAfterClear(old(), NEW_SID, opts).request, { phase: 'idle', atMs: 0, reason: '' });
    const atClear = { phase: 'requested', atMs: CLEARED, reason: '' };
    assert.equal(entryAfterClear(old({ request: atClear }), NEW_SID, opts).request, atClear, 'the same record');
    const unsent = { phase: 'idle', atMs: CLEARED + 1, reason: '', unsent: true };
    assert.equal(entryAfterClear(old({ request: unsent }), NEW_SID, opts).request, unsent);
  });
  await t.test('without a clear time no request moves', () => {
    const late = { phase: 'requested', atMs: CLEARED + 5, reason: '' };
    for (const clearedAtMs of [undefined, null, NaN, '1000000', Infinity]) {
      const after = entryAfterClear(old({ request: late }), NEW_SID, { clearedAtMs, nowMs: NOW });
      assert.deepEqual(after.request, { phase: 'idle', atMs: 0, reason: '' }, String(clearedAtMs));
    }
    assert.deepEqual(entryAfterClear(old({ request: late }), NEW_SID).request, { phase: 'idle', atMs: 0, reason: '' }, 'no options at all');
  });
});

test('clear re-key: the carried Ultracode value stands through the first prompt and gives way to a Stop after the re-key', () => {
  const CLEARED = 1000000;
  const NOW = CLEARED + 4000;
  const before = Object.assign(freshEntry(SID), { state: { ultracode: true, last_stop_at: 10 } });
  const carried = entryAfterClear(before, NEW_SID, { clearedAtMs: CLEARED, nowMs: NOW }).ultraConfirmed;
  // The hook stamps the cleared session's start as a Stop (ctx_handoff.py ev_sessionstart): no value yet.
  assert.equal(ultracodeValue({ ultracode: null, ultra_scan: null, last_stop_at: CLEARED / 1000 }, carried), true);
  // The first prompt: the hook has scanned and found no switch, and the only Stop is still that stamp.
  assert.equal(ultracodeValue({ ultracode: null, ultra_scan: SCANNED, last_stop_at: CLEARED / 1000 }, carried), true);
  // The first finished turn: a Stop later than the re-key. Now the hook decides.
  assert.equal(ultracodeValue({ ultracode: false, ultra_scan: SCANNED, last_stop_at: (NOW + 1000) / 1000 }, carried), false);
  // Stamped with the clear's own time instead, the value would be lost at the first prompt.
  assert.equal(ultracodeValue({ ultracode: null, ultra_scan: SCANNED, last_stop_at: CLEARED / 1000 }, { value: true, atMs: CLEARED }), false);
});

// The two fallbacks of the /clear trial (design entries T2 and T6). Jason's answer D-I of 2026-10-06:
// only their TEXTS are held now, each by one test; the behaviour is built only if the trial fails.

// T6: the tooltip the Ultracode button would get if a click made straight after a /clear turns out
// to stick on 'working'. Nothing reads the constant yet.
test('clear re-key (T6): the text for an Ultracode button that has to wait after a /clear', () => {
  assert.equal(CLEAR_WAIT_REASON, 'Session is starting again after /clear');
});

// T2 (a): what the button would read if the program turns out to switch Ultracode off at /clear and
// nothing is carried. It is the text the button already has for a value that is not known.
test("clear re-key (T2 a): the text for a value that is not carried is the button's not-known text", () => {
  assert.equal(ULTRACODE_UNKNOWN_TITLE, "Not known yet. The hook reports it after the session's first turn.");
});

test('browser: a clear re-key moves the same entry object and leaves the old conversation behind', async () => {
  const storage = new Map();
  const h = await bootUltra(true, { storage });
  h.setState(writtenVmState(h, { ultracode: true }));
  h.setHandoffFile(true);
  await h.refresh();
  assert.ok(String(h.header().primary).startsWith('Continue in new session'), 'before: the cleared conversation had a handoff');
  h.run(`(() => {
    const entry = handoffRt.cache.get('${SID}');
    entry.continueError = 'an old Continue error';
    entry.continueErrorAtMs = Date.now();
    entry.request = { phase: 'idle', atMs: Date.now() - 60000, reason: '' };
    handoffStoreRequest(entry);
    globalThis.__before = entry;
  })()`);
  assert.ok([...storage.keys()].some((key) => key.endsWith(SID)), 'before: this window has something stored under the old id');

  await clearEvent(h, SID, NEW_SID, h.now - 3000);

  assert.equal(h.run(`handoffRt.cache.get('${NEW_SID}') === __before`), true, 'the same object: the typing path and the looks hold it');
  assert.equal(h.run(`handoffRt.cache.has('${SID}')`), false);
  const entry = entryOf(h, NEW_SID);
  assert.equal(entry.id, NEW_SID);
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(freshEntry(NEW_SID)).sort(), 'no field outside the table rode along');
  // C2: no reading until the cleared session writes one. (No file exists for the new id yet.)
  assert.equal(entry.sidecar, null);
  assert.equal(entry.state, null);
  assert.equal(entry.turn, null);
  // C11: the Continue button and its error left with the old conversation.
  assert.equal(entry.handoffReadable, false);
  assert.equal(entry.continueError, '');
  assert.ok(!String(h.header().primary).startsWith('Continue in new session'));
  assert.equal(h.header().note, null);
  assert.deepEqual(entry.request, { phase: 'idle', atMs: 0, reason: '' }, 'a request from before the clear stays behind');
  // Nothing of the old id is left in this window's storage; the carried value is stored under the new id.
  assert.deepEqual([...storage.keys()].filter((key) => key.endsWith(SID)), []);
  assert.equal(JSON.parse(storage.get('handoff-ultracode:' + NEW_SID)).value, true);
  // C2, second half: the first reading of the cleared session shows.
  h.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify({ ...VM_SIDECAR, total_input_tokens: 21000, used_percentage: 2 }));
  await refreshId(h, NEW_SID);
  assert.equal(entryOf(h, NEW_SID).sidecar.total_input_tokens, 21000);
  assert.deepEqual(h.errors, []);
});

test("browser: a re-key with no reason, or with a reason that is not 'clear', moves the entry whole", async () => {
  for (const extra of [[], [undefined, undefined], ['fork'], ['Clear', { clearedAtMs: 1 }], [null, { clearedAtMs: 1 }]]) {
    const h = await bootUltra(true);
    h.setState(writtenVmState(h, { ultracode: true }));
    h.setHandoffFile(true);
    await h.refresh();
    const before = entryOf(h, SID);
    assert.ok(before.sidecar && before.state && before.handoffReadable === true, 'before: a reading, a state and a handoff to take along');
    h.listeners.fork(SID, NEW_SID, ...extra);
    const after = entryOf(h, NEW_SID);       // read before the refresh the listener started has answered
    assert.equal(after.id, NEW_SID);
    for (const field of ['sidecar', 'state', 'handoffReadable', 'readableFor', 'request', 'turn', 'ultraConfirmed', 'continueError']) {
      assert.deepEqual(after[field], before[field], field + ' ' + JSON.stringify(extra));
    }
    await flush();
  }
});

// DESIGN acceptance: "text sent, a clear re-key lands, then the text shows: Enter is sent once, under the new id".
test('browser: text typed before a clear re-key lands gets its Enter once, under the new id', () => withHold(true, async () => {
  const h = await bootEnded();
  const clearedAtMs = h.now - 3000;     // the /clear itself was three seconds ago; the click came after it
  h.knobs.echo = false;                 // the program has not drawn the typed line yet
  await h.click('primary');
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE]]);
  await h.advance(100);
  await clearEvent(h, SID, NEW_SID, clearedAtMs);
  h.knobs.echo = true;
  h.knobs.terminal.fakeTyped(REQUEST_LINE);   // now the line shows in the input box
  await h.advance(150);                 // the look at 250 ms
  assert.deepEqual(h.sent, [[SID, REQUEST_LINE], [NEW_SID, '\r']]);
  await h.advance(3000);
  assert.equal(h.sent.filter(([, data]) => data === '\r').length, 1, 'Enter once');
  const request = entryOf(h, NEW_SID).request;
  assert.equal(request.phase, 'requested', 'typed after the clear: the request moved with the terminal');
  assert.ok(!request.unsent);
  assert.equal(h.confirms.length, 0);
}));

// C5.
test('browser: after a clear re-key Ultracode and the bolt keep the value they showed until the first finished turn, and a click types without asking', async () => {
  const h = await bootUltra(true);
  assert.equal(ultraHeader(h).look, 'on');
  const clearedAtMs = h.now - 2000;
  // The cleared session's files as the hook leaves them at its start: a reading,
  // and a state with no Ultracode value, no scan, and the start stamped as a Stop.
  h.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify(VM_SIDECAR));
  h.files.set(stateFile(NEW_SID), JSON.stringify(endedState(h, { last_prompt_at: null, last_stop_at: clearedAtMs / 1000 })));
  await clearEvent(h, SID, NEW_SID, clearedAtMs);
  await refreshId(h, NEW_SID);
  assert.deepEqual(ultraHeader(h), {
    shown: true, label: 'Ultracode', enabled: true, asksFirst: false, look: 'on',
    title: 'Ultracode is on. Click to switch it off.',
  });
  assert.notEqual(h.run(`handoffBoltState('${NEW_SID}')`), null, 'the bolt on the row follows the same value');
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, false, 'on an empty prompt Hand off types without asking');
  // The first prompt: the hook scans and finds no switch record. The value stays.
  h.files.set(stateFile(NEW_SID), JSON.stringify(endedState(h, {
    ultracode: null, ultra_scan: SCANNED, last_prompt_at: h.sec, last_stop_at: clearedAtMs / 1000 })));
  await refreshId(h, NEW_SID);
  assert.equal(ultraHeader(h).look, 'on');
  // The first finished turn: the hook reports off, and that is what shows.
  await h.advance(5000);
  h.files.set(stateFile(NEW_SID), JSON.stringify(endedState(h, {
    ultracode: false, ultra_scan: SCANNED, last_prompt_at: h.sec - 3, last_stop_at: h.sec })));
  await refreshId(h, NEW_SID);
  assert.equal(ultraHeader(h).look, 'off');

  // A plain click right after the switch types under the new id and asks nothing.
  const plain = await bootEnded();
  const cleared = plain.now - 2000;
  plain.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify(VM_SIDECAR));
  plain.files.set(stateFile(NEW_SID), JSON.stringify(endedState(plain, { last_prompt_at: null, last_stop_at: cleared / 1000 })));
  await clearEvent(plain, SID, NEW_SID, cleared);
  await refreshId(plain, NEW_SID);
  await plain.click('primary');
  assert.deepEqual(plain.sent, [[NEW_SID, REQUEST_LINE]]);
  assert.equal(plain.confirms.length, 0);
});

// A /clear after a turn this window watched from busy to idle. The entry then holds the time of
// that turn's busy event, which is a fact about the terminal and is carried (every other fixture
// here has seen an idle event only).
test('browser: after a clear re-key that follows a watched turn both buttons are plain, and the next idle event marks nothing as not updated', async () => {
  const h = await bootUltra(true);
  // A whole turn, watched, with files that move as an ordinary turn's do.
  h.busyEvent(true);
  await h.advance(20000);
  h.setSidecar({ ...VM_SIDECAR, ts: h.sec - 1 });
  h.setState(endedState(h, { ultracode: true, last_prompt_at: h.sec - 20, last_stop_at: h.sec }));
  await h.advance(1000);
  h.busyEvent(false);
  await h.advance(5000);
  const busyAtMs = entryOf(h, SID).lastBusyAtMs;
  assert.equal(typeof busyAtMs, 'number', 'before: the entry holds the time of the busy event');
  assert.notEqual(entryOf(h, SID).turn, null, 'before: a watched turn');
  // The /clear. The hook stamps the cleared session's start, which is later than that busy event,
  // and the cleared session's status line writes its first reading.
  const clearedAtMs = h.now - 2000;
  assert.ok(clearedAtMs > busyAtMs);
  h.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify({
    ...VM_SIDECAR, total_input_tokens: 21000, used_percentage: 2, ts: clearedAtMs / 1000 }));
  h.files.set(stateFile(NEW_SID), JSON.stringify(endedState(h, { last_prompt_at: null, last_stop_at: clearedAtMs / 1000 })));
  await clearEvent(h, SID, NEW_SID, clearedAtMs);
  await refreshId(h, NEW_SID);
  const entry = entryOf(h, NEW_SID);
  assert.equal(entry.lastBusyAtMs, busyAtMs, 'a fact about the terminal: carried');
  assert.equal(entry.turn, null, "the watched turn was the old conversation's");
  // C5: a busy event from before the clear does not make a click ask first.
  assert.equal(h.header().primary, 'Hand off');
  assert.equal(h.header().primaryEnabled, true);
  assert.equal(h.header().primaryOverride, false);
  assert.equal(ultraHeader(h).enabled, true);
  assert.equal(ultraHeader(h).asksFirst, false);
  // The title goes idle again under the new id. The busy listener builds a watched turn from the
  // carried time; the cleared session's files are later than it, so nothing is marked (E5).
  h.listeners.busy(NEW_SID, false);
  assert.equal(entryOf(h, NEW_SID).turn.busyAtMs, busyAtMs, 'the turn is built from the carried time');
  await h.advance(STALE_AFTER_MS + 500);
  await refreshId(h, NEW_SID);
  assert.equal(meterLook(h).stale, false, 'a followed /clear leaves no "not updated" mark');
});

// C5 across a reload of the window: the carried value is in this window's storage under the new id.
test('browser: a window reloaded after a clear re-key, before the first turn has ended, still shows the carried Ultracode value', async () => {
  const storage = new Map();
  const first = await bootUltra(true, { storage });
  const clearedAtMs = first.now - 2000;
  await clearEvent(first, SID, NEW_SID, clearedAtMs);
  assert.equal(storage.has('handoff-ultracode:' + NEW_SID), true, 'the value on show is stored under the new id');
  assert.equal(JSON.parse(storage.get('handoff-ultracode:' + NEW_SID)).atMs, first.now, 'stamped with the time of the re-key');

  // The same window, loaded again five seconds later. Its session is the cleared one now: the row,
  // the view, the running set and the open terminal are under the new id, and the hook's files for
  // that id are as it leaves them at the session's start (no Ultracode value, the start stamped as a Stop).
  const second = await bootUltra(undefined, { storage, startMs: first.now + 5000, reloaded: true });
  second.run(`(() => {
    const session = sessionMap.get('${SID}');
    session.sessionId = '${NEW_SID}';
    sessionMap.delete('${SID}');
    sessionMap.set('${NEW_SID}', session);
    activeSessionId = '${NEW_SID}';
    activePtyIds = new Set(['${NEW_SID}']);
    const open = window._openSessions.get('${SID}');
    window._openSessions.delete('${SID}');
    window._openSessions.set('${NEW_SID}', open);
  })()`);
  second.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify(VM_SIDECAR));
  second.files.set(stateFile(NEW_SID), JSON.stringify(endedState(second, { last_prompt_at: null, last_stop_at: clearedAtMs / 1000 })));
  await refreshId(second, NEW_SID);
  assert.equal(ultraHeader(second).look, 'on');
  assert.notEqual(second.run(`handoffBoltState('${NEW_SID}')`), null, 'the bolt too');
  // The first finished turn: a Stop later than the stored stamp. Now the hook decides.
  await second.advance(5000);
  second.files.set(stateFile(NEW_SID), JSON.stringify(endedState(second, {
    ultracode: false, ultra_scan: SCANNED, last_prompt_at: second.sec - 3, last_stop_at: second.sec })));
  await refreshId(second, NEW_SID);
  assert.equal(ultraHeader(second).look, 'off');
});

// DESIGN:866: both click paths hold the entry object across the asks-first box and read entry.id
// after it. So a clear that lands while the box is open must move that same object.
test('browser: a clear re-key lands while the asks-first box is open: the yes still types, under the new id, and the request is on the moved entry', async () => {
  const h = await bootReloaded();       // no busy or idle event yet in this window: a click asks first
  assert.equal(h.header().primaryOverride, true, 'before: the click asks first');
  const clearedAtMs = h.now - 3000;
  // The cleared session's files as the hook leaves them at its start.
  h.files.set(VM_DIR + '\\' + NEW_SID + '.json', JSON.stringify(VM_SIDECAR));
  h.files.set(stateFile(NEW_SID), JSON.stringify(endedState(h, { last_prompt_at: null, last_stop_at: clearedAtMs / 1000 })));
  // The box, answered yes; the clear lands while it is open (task 07's way of doing this for a fork).
  h.knobs.duringQuestion = () => { clearEvent(h, SID, NEW_SID, clearedAtMs); };
  h.run('confirmDialog = async () => { __knobs.duringQuestion(); return true; }');
  await h.click('primary');
  await h.advance(1500);
  assert.deepEqual(h.sent, [[NEW_SID, REQUEST_LINE], [NEW_SID, '\r']]);
  assert.equal(entryOf(h, NEW_SID).request.phase, 'requested', 'made after the clear, on the entry that moved');
});
