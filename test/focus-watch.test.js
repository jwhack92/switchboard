const test = require('node:test');
const assert = require('node:assert/strict');

// The focus watch (public/focus-watch.js): the rule that notices keys arriving
// at a window Chromium says is unfocused, which is the state where typed
// characters are dropped until the window is left and re-entered.
//
// Everything here runs the shipped state machine against a fake clock, fake
// timers and a fake document.hasFocus(). What that can prove is the rule as
// written. What it cannot prove: that Chromium reports hasFocus() false on a
// real keydown in the stuck state, that 150 ms is long enough after a real
// activation, or what a real native dialog does to focus. Those need the app.

const FocusWatch = require('../public/focus-watch.js');
const { createFocusWatch, keyClass, callSite, CONFIRM_MS, MAX_LOGGED_EPISODES, MAX_NOTICES } = FocusWatch;

/** A watch wired to fakes, plus what it wrote. Starts unfocused and visible. */
function rig(over = {}) {
  const r = {
    t: 5_000_000, focused: false, visible: true, tag: 'INPUT',
    lines: [], notes: [], notices: 0, reports: [],
  };
  const timers = [];
  let seq = 0;
  r.watch = createFocusWatch({
    now: () => r.t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: r.t + ms, fn }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    hasFocus: () => r.focused,
    isVisible: () => r.visible,
    activeTag: () => r.tag,
    note: (kind, detail) => r.notes.push({ kind, ...(detail || {}) }),
    warn: (line) => r.lines.push(line),
    notify: () => { r.notices++; },
    ...over,
  });
  r.watch.onDesync((report) => r.reports.push(report));
  /** Move the clock, running each timer at the moment it falls due. */
  r.advance = (ms) => {
    const end = r.t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      r.t = due.at;
      due.fn();
    }
    r.t = end;
  };
  r.pendingTimers = () => timers.length;
  r.desyncLines = () => r.lines.filter((l) => l.startsWith('[focus] desync '));
  r.endLines = () => r.lines.filter((l) => l.startsWith('[focus] episode-end '));
  return r;
}

/** A keydown the user really pressed. */
function key(over = {}) {
  return {
    type: 'keydown', isTrusted: true, key: 'a', code: 'KeyA', keyCode: 65,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    repeat: false, isComposing: false, ...over,
  };
}

// --- The file itself ---

test('focus-watch.js loads under node, with no window, and exports the detector', () => {
  assert.equal(typeof window, 'undefined', 'this test is only meaningful without a window');
  assert.equal(typeof createFocusWatch, 'function');
  assert.equal(typeof keyClass, 'function');
  assert.equal(typeof callSite, 'function');
  assert.equal(CONFIRM_MS, 150);
  const watch = createFocusWatch();   // no deps at all must not throw
  assert.deepEqual(
    Object.keys(watch).sort(),
    ['mark', 'onCharEvent', 'onDesync', 'onKeydown', 'onWindowBlur', 'onWindowFocus', 'snapshot', 'start', 'wrapDialog'],
  );
});

// --- The rule ---

test('a keydown in a focused window opens no episode', () => {
  const r = rig();
  r.focused = true;
  r.watch.onKeydown(key());
  r.advance(10_000);
  assert.deepEqual(r.lines, []);
  assert.equal(r.notices, 0);
  assert.equal(r.pendingTimers(), 0, 'a healthy key must not even start the wait');
  assert.equal(r.watch.snapshot().episodes, 0);
});

test('an unfocused keydown opens an episode only after the confirm wait', () => {
  const r = rig();
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS - 1);
  assert.deepEqual(r.lines, [], 'nothing before the wait is over');
  assert.equal(r.notices, 0);
  assert.equal(r.watch.snapshot().candidatePending, true);

  r.advance(1);
  assert.equal(r.desyncLines().length, 1);
  assert.equal(r.notices, 1);
  assert.equal(r.reports.length, 1);
  const snap = r.watch.snapshot();
  assert.equal(snap.episodes, 1);
  assert.equal(snap.candidatePending, false);
  assert.equal(snap.episode.n, 1);
  assert.deepEqual(r.notes.filter((n) => n.kind === 'focus-desync'), [
    { kind: 'focus-desync', n: 1, keyClass: 'printable', active: 'INPUT' },
  ]);
});

test('a window focus event before the wait is over cancels it', () => {
  const r = rig();
  r.watch.onKeydown(key());
  r.advance(100);
  r.watch.onWindowFocus();
  r.advance(10_000);
  assert.deepEqual(r.lines, []);
  assert.equal(r.notices, 0);
  assert.equal(r.watch.snapshot().episodes, 0);
});

test('focus coming back by itself, or a focused keydown, cancels the wait too', () => {
  const quiet = rig();
  quiet.watch.onKeydown(key());
  quiet.advance(100);
  quiet.focused = true;              // no event of any kind
  quiet.advance(10_000);
  assert.equal(quiet.watch.snapshot().episodes, 0);
  assert.deepEqual(quiet.lines, []);

  const typed = rig();
  typed.watch.onKeydown(key());
  typed.advance(50);
  typed.focused = true;
  typed.watch.onKeydown(key());
  typed.focused = false;             // even if it reads false again at the deadline
  typed.advance(10_000);
  assert.equal(typed.watch.snapshot().episodes, 0);
  assert.deepEqual(typed.lines, []);
});

test('a page that went hidden during the wait opens no episode', () => {
  const r = rig();
  r.watch.onKeydown(key());
  r.visible = false;
  r.advance(10_000);
  assert.equal(r.watch.snapshot().episodes, 0);
});

test('keys that prove nothing never start the wait', () => {
  const never = {
    'bare Shift': key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }),
    'bare Control': key({ key: 'Control', code: 'ControlRight', ctrlKey: true }),
    'bare Alt': key({ key: 'Alt', code: 'AltLeft', altKey: true }),
    'bare Meta': key({ key: 'Meta', code: 'MetaLeft', metaKey: true }),
    'modifier known only by code': key({ key: 'Unidentified', code: 'ShiftRight' }),
    'auto-repeat': key({ repeat: true }),
    'isComposing': key({ isComposing: true }),
    'keyCode 229': key({ keyCode: 229 }),
    'key Process': key({ key: 'Process' }),
    'key Dead': key({ key: 'Dead' }),
    'Alt held (Alt+Tab)': key({ key: 'Tab', code: 'Tab', altKey: true }),
    'Meta held': key({ metaKey: true }),
    'script-made event': key({ isTrusted: false }),
    'event with no isTrusted': (() => { const e = key(); delete e.isTrusted; return e; })(),
  };
  for (const [name, e] of Object.entries(never)) {
    const r = rig();
    r.watch.onKeydown(e);
    assert.equal(r.pendingTimers(), 0, `${name} started the wait`);
    r.advance(10_000);
    assert.equal(r.watch.snapshot().episodes, 0, `${name} opened an episode`);
    assert.deepEqual(r.lines, [], `${name} wrote a line`);
  }
  // A hidden page is checked when the key arrives as well.
  const hidden = rig();
  hidden.visible = false;
  hidden.watch.onKeydown(key());
  assert.equal(hidden.pendingTimers(), 0);
});

test('keys that do count: a letter, Shift+letter, Enter, Ctrl+letter', () => {
  const does = {
    letter: [key(), 'printable'],
    'Shift+letter': [key({ key: 'A', shiftKey: true }), 'printable'],
    Enter: [key({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'named'],
    'Ctrl+letter': [key({ ctrlKey: true }), 'chord'],
  };
  for (const [name, [e, cls]] of Object.entries(does)) {
    const r = rig();
    r.watch.onKeydown(e);
    r.advance(CONFIRM_MS);
    assert.equal(r.watch.snapshot().episodes, 1, `${name} did not open an episode`);
    assert.equal(r.reports[0].keyClass, cls, name);
  }
});

test('a reader that throws can never open an episode', () => {
  const r = rig({ hasFocus: () => { throw new Error('no document'); } });
  r.watch.onKeydown(key());
  r.advance(10_000);
  assert.equal(r.watch.snapshot().episodes, 0);
  assert.deepEqual(r.lines, []);
});

// --- One report per episode ---

test('fifty keydowns in one episode give one line, one notice and one callback', () => {
  const r = rig();
  for (let i = 0; i < 50; i++) { r.watch.onKeydown(key()); r.advance(40); }
  assert.equal(r.desyncLines().length, 1);
  assert.equal(r.notices, 1);
  assert.equal(r.reports.length, 1);
  assert.equal(r.endLines().length, 0, 'still open');
  assert.equal(r.watch.snapshot().episode.keydowns, 50);

  r.watch.onWindowFocus();
  assert.equal(r.endLines().length, 1);
  assert.match(r.endLines()[0], / keydowns=50 printable=50 charEvents=0 keypress=0 insert=0 endedBy=window-focus$/);
  assert.equal(r.watch.snapshot().episode, null);
});

test('an episode ends on a window focus event or on the first focused keydown', () => {
  const byFocus = rig();
  byFocus.watch.onKeydown(key());
  byFocus.advance(CONFIRM_MS + 850);
  byFocus.watch.onWindowFocus();
  assert.match(byFocus.endLines()[0], /^\[focus\] episode-end n=1 durationMs=1000 keydowns=1 printable=1 .* endedBy=window-focus$/);

  const byKey = rig();
  byKey.watch.onKeydown(key());
  byKey.advance(CONFIRM_MS);
  byKey.focused = true;
  byKey.watch.onKeydown(key());
  assert.match(byKey.endLines()[0], / keydowns=1 .* endedBy=hasFocus-true$/, 'the focused key is not part of the episode');
  assert.equal(byKey.watch.snapshot().lastEpisode.endedBy, 'hasFocus-true');

  // Closed means closed: the next unfocused key starts a second episode.
  byKey.focused = false;
  byKey.watch.onKeydown(key());
  byKey.advance(CONFIRM_MS);
  assert.equal(byKey.desyncLines().length, 2);
  assert.match(byKey.desyncLines()[1], /^\[focus\] desync n=2 /);
});

test('the end line counts printable keys against the characters that actually arrived', () => {
  const r = rig();
  r.watch.onKeydown(key());                                             // printable, starts the wait
  r.watch.onCharEvent('keypress', { isTrusted: true });                 // counted while waiting
  r.advance(CONFIRM_MS);
  r.watch.onKeydown(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }));   // counted, not printable
  r.watch.onKeydown(key({ key: 'B', shiftKey: true }));
  r.watch.onKeydown(key({ key: 'Backspace', code: 'Backspace', keyCode: 8 }));
  r.watch.onCharEvent('beforeinput', { isTrusted: true, inputType: 'insertText' });
  r.watch.onCharEvent('beforeinput', { isTrusted: true, inputType: 'deleteContentBackward' });   // not a character
  r.watch.onCharEvent('keypress', { isTrusted: false });                // script-made
  r.watch.onCharEvent('keypress', null);
  r.watch.onWindowFocus();
  assert.match(r.endLines()[0], / keydowns=4 printable=2 charEvents=2 keypress=1 insert=1 endedBy=window-focus$/);

  // Outside an episode nothing is counted, and nothing carries over.
  r.watch.onCharEvent('keypress', { isTrusted: true });
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  r.watch.onWindowFocus();
  assert.match(r.endLines()[1], / keydowns=1 printable=1 charEvents=0 keypress=0 insert=0 /);
});

test('limits per page load: twenty logged episodes then one last line, three notices', () => {
  const r = rig();
  const total = MAX_LOGGED_EPISODES + 5;
  for (let i = 0; i < total; i++) {
    r.watch.onKeydown(key());
    r.advance(CONFIRM_MS);
    r.watch.onWindowFocus();
    r.advance(1000);
  }
  assert.equal(r.desyncLines().length, MAX_LOGGED_EPISODES);
  assert.equal(r.endLines().length, MAX_LOGGED_EPISODES);
  assert.deepEqual(
    r.lines.filter((l) => !l.startsWith('[focus] desync ') && !l.startsWith('[focus] episode-end ')),
    ['[focus] further episodes not logged (limit 20 per page load)'],
  );
  assert.equal(r.notices, MAX_NOTICES);
  assert.equal(MAX_NOTICES, 3);
  assert.equal(r.reports.length, total, 'the callback and the count go on');
  assert.equal(r.watch.snapshot().episodes, total);
});

test('a throwing sink or callback does not stop the watch', () => {
  const boom = () => { throw new Error('sink failed'); };
  const r = rig({ note: boom, warn: boom, notify: boom });
  r.watch.onDesync(boom);
  r.watch.start();
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  r.watch.onWindowFocus();
  assert.equal(r.watch.snapshot().episodes, 1);
  assert.equal(r.watch.snapshot().lastEpisode.endedBy, 'window-focus');
  assert.equal(r.reports.length, 1, 'the callback registered first still ran');
});

// --- Markers: what came before ---

test('the desync line lists markers since the last window focus, with site and age, and no older ones', () => {
  const r = rig();
  r.watch.mark('drag-start', 'session-drag.js:86');     // before the focus: cleared
  r.advance(1000);
  r.watch.onWindowBlur();
  r.advance(500);
  r.watch.onWindowFocus();
  r.advance(2000);
  r.watch.mark('browse-folder', 'dialogs.js:461');
  r.advance(300);
  r.watch.mark('adopt', '');
  r.advance(700);
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);

  assert.equal(
    r.desyncLines()[0],
    '[focus] desync n=1 keyClass=printable active=INPUT sinceBlurMs=3650 sinceFocusMs=3150'
      + ' sinceDialogCloseMs=none markers=browse-folder@dialogs.js:461+1150ms,adopt+850ms',
  );
  assert.deepEqual(r.reports[0].markers, [
    { kind: 'browse-folder', site: 'dialogs.js:461', ageMs: 1150 },
    { kind: 'adopt', site: '', ageMs: 850 },
  ]);
});

test('with no window focus event yet every marker is a suspect, and none reads "none"', () => {
  const r = rig();
  r.watch.start();
  r.advance(4000);
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  assert.match(r.desyncLines()[0], / sinceBlurMs=none sinceFocusMs=none sinceDialogCloseMs=none markers=page-load\+4150ms$/);

  const bare = rig();
  bare.watch.onWindowFocus();
  bare.advance(10);
  bare.watch.onKeydown(key());
  bare.advance(CONFIRM_MS);
  assert.match(bare.desyncLines()[0], / markers=none$/);
});

test('start() writes one page-load line', () => {
  const r = rig();
  r.focused = true;
  r.watch.start();
  assert.deepEqual(r.lines, ['[focus] page-load hasFocus=true visible=true']);
});

// --- The native dialog wrapper ---

test('the dialog wrapper returns exactly what the original returned, called once, synchronously', () => {
  const r = rig();
  const owner = { name: 'window' };
  const obj = { some: 'object' };
  for (const value of [true, false, undefined, null, 0, '', obj]) {
    const calls = [];
    const original = function (...args) { calls.push({ self: this, args }); return value; };
    const wrapped = r.watch.wrapDialog('confirm', original, owner);
    assert.equal(typeof wrapped, 'function');
    assert.notEqual(wrapped, original);
    const got = wrapped('Stop this session?', 2);
    assert.equal(got, value);
    assert.equal(calls.length, 1, 'the original runs before the wrapper returns, exactly once');
    assert.equal(calls[0].self, owner, 'called on the owner (a native dialog throws on any other this)');
    assert.deepEqual(calls[0].args, ['Stop this session?', 2]);
  }
});

test('with no owner the wrapper keeps the caller\'s this; a non-function is handed back unwrapped', () => {
  const r = rig();
  const seen = [];
  const holder = { ask: r.watch.wrapDialog('confirm', function () { seen.push(this); return true; }) };
  assert.equal(holder.ask(), true);
  assert.equal(seen[0], holder);
  assert.equal(r.watch.wrapDialog('confirm', undefined), undefined);
  assert.equal(r.watch.wrapDialog('alert', null), null);
});

test('the dialog wrapper survives a recorder that throws at every step', () => {
  const boom = () => { throw new Error('recorder failed'); };
  for (const over of [{ note: boom }, { warn: boom }, { now: boom }, { hasFocus: boom }, { setTimer: boom }, { note: boom, now: boom, setTimer: boom, hasFocus: boom, warn: boom }]) {
    const r = rig(over);
    let calls = 0;
    const wrapped = r.watch.wrapDialog('confirm', () => { calls++; return 'the answer'; });
    assert.equal(wrapped('x'), 'the answer', 'with ' + Object.keys(over).join('+') + ' throwing');
    assert.equal(calls, 1);
  }
});

test('a throw from the original dialog still reaches the caller, and the close is still recorded', () => {
  const r = rig();
  const failure = new Error('dialog refused');
  const wrapped = r.watch.wrapDialog('alert', () => { throw failure; });
  assert.throws(() => wrapped('x'), (e) => e === failure);
  assert.deepEqual(r.notes.map((n) => n.kind), ['dialog-open', 'dialog-close']);
});

test('a dialog leaves open, close and settled notes: kind, call site, duration and focus samples only', () => {
  const r = rig();
  const wrapped = r.watch.wrapDialog('confirm', () => { r.t += 2310; return false; });
  wrapped('Stop this session?');
  r.advance(1500);

  const site = r.notes[0].site;
  assert.match(site, /^focus-watch\.test\.js:\d+$/, 'the call site is this test file and a line, no path');
  assert.deepEqual(r.notes, [
    { kind: 'dialog-open', dialog: 'confirm', site },
    { kind: 'dialog-close', dialog: 'confirm', site, openMs: 2310, hasFocus: false },
    { kind: 'dialog-settled', dialog: 'confirm', site, hasFocusAt250: false, hasFocusAt1500: false, focusEventAfter: false },
  ]);
  // Focus never came back: one line, and the dialog is a suspect for the next episode.
  assert.deepEqual(r.lines, [
    `[focus] dialog kind=confirm site=${site} openMs=2310 hasFocusAtReturn=false hasFocusAt250=false hasFocusAt1500=false focusEventAfter=false`,
  ]);
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  assert.match(r.desyncLines()[0], new RegExp(` sinceDialogCloseMs=1650 markers=confirm@${site.replace(/\./g, '\\.')}\\+1650ms$`));
  assert.deepEqual(r.watch.snapshot().lastDialog, {
    kind: 'confirm', site, closedMsAgo: 1650, openMs: 2310,
    hasFocusAtReturn: false, hasFocusAt250: false, hasFocusAt1500: false,
  });
});

test('a dialog after which focus comes back writes no line and is not a suspect', () => {
  const r = rig();
  const wrapped = r.watch.wrapDialog('alert', () => { r.t += 900; });
  wrapped('Could not save');
  r.advance(100);
  r.focused = true;
  r.watch.onWindowFocus();
  r.advance(5000);
  assert.deepEqual(r.lines, []);
  const settled = r.notes.find((n) => n.kind === 'dialog-settled');
  assert.equal(settled.hasFocusAt250, true);
  assert.equal(settled.hasFocusAt1500, true);
  assert.equal(settled.focusEventAfter, true);

  r.focused = false;
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  assert.match(r.desyncLines()[0], / markers=none$/, 'the dialog closed before the last window focus');
});

test('callSite keeps a base name and a line, skips this file\'s own frames, and gives up on anything else', () => {
  const chrome = [
    'Error',
    '    at window.confirm (file:///C:/Users/someone/Bitbucket/switchboard/public/focus-watch.js:212:60)',
    '    at stopSession (file:///C:/Users/someone/Bitbucket/switchboard/public/app.js:1028:8)',
    '    at HTMLButtonElement.<anonymous> (file:///C:/Users/someone/Bitbucket/switchboard/public/app.js:2000:3)',
  ].join('\n');
  assert.equal(callSite(chrome), 'app.js:1028');
  assert.equal(callSite('Error\n    at file:///C:/x/public/sidebar.js:548:11'), 'sidebar.js:548');
  assert.equal(callSite('Error\n    at fn (C:\\Users\\someone\\proj\\public\\schedules.js:101:9)'), 'schedules.js:101');
  assert.equal(callSite('Error\n    at <anonymous>'), '');
  assert.equal(callSite('Error\n    at eval (eval at run (app.js:5:1), <anonymous>:1:1)'), '');
  assert.equal(callSite(undefined), '');
  assert.equal(callSite(''), '');

  // A marker is relayed through terminal-diagnostics.js, whose frame sits
  // between this file's and the caller's. Named, it is passed over as well.
  const relayed = [
    'Error',
    '    at Object.focusMark (file:///C:/Users/someone/Bitbucket/switchboard/public/terminal-diagnostics.js:658:60)',
    '    at promote (file:///C:/Users/someone/Bitbucket/switchboard/public/session-drag.js:88:45)',
  ].join('\n');
  assert.equal(callSite(relayed), 'terminal-diagnostics.js:658', 'not skipped unless asked');
  assert.equal(callSite(relayed, 'terminal-diagnostics.js'), 'session-drag.js:88');
  assert.equal(callSite('Error\n    at Object.focusMark (file:///C:/x/public/terminal-diagnostics.js:658:60)', 'terminal-diagnostics.js'), '');
});

test('marker lists are bounded: eight in a desync line, twelve in the snapshot, the newest kept', () => {
  const r = rig();
  for (let i = 0; i < 60; i++) { r.watch.mark('drag-start', 'session-drag.js:' + (100 + i)); r.advance(10); }
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);

  const listed = r.desyncLines()[0].split(' markers=')[1].split(',');
  assert.equal(listed.length, 8);
  assert.match(listed[0], /^drag-start@session-drag\.js:152\+/, 'the oldest of the last eight');
  assert.match(listed[7], /^drag-start@session-drag\.js:159\+/, 'the newest');
  assert.equal(r.reports[0].markers.length, 8);

  const snap = r.watch.snapshot().markers;
  assert.equal(snap.length, 12);
  assert.equal(snap[0].site, 'session-drag.js:148');
  assert.equal(snap[11].site, 'session-drag.js:159');
});

test('at most twenty dialog lines per page load', () => {
  const r = rig();
  const wrapped = r.watch.wrapDialog('confirm', () => true);
  for (let i = 0; i < 25; i++) { wrapped('x'); r.advance(2000); }
  assert.equal(r.lines.filter((l) => l.startsWith('[focus] dialog ')).length, 20);
  assert.equal(r.notes.filter((n) => n.kind === 'dialog-settled').length, 25, 'the notes go on');
});

test('a dialog whose samples ran late, behind a second dialog, writes no line of its own', () => {
  // A native dialog blocks the page. A second one opened inside the first
  // one's second and a half holds the first one's timers until it returns,
  // so what they then read is the state the second dialog left.
  const r = rig();
  r.focused = true;
  const first = r.watch.wrapDialog('confirm', () => { r.t += 400; return true; });
  const second = r.watch.wrapDialog('alert', () => { r.t += 9000; r.focused = false; });
  first('x');
  r.advance(100);
  second('y');                       // returns 9 s later; nothing ran meanwhile
  r.advance(1500);                   // the first dialog's overdue samples, then the second's own

  const lines = r.lines.filter((l) => l.startsWith('[focus] dialog '));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^\[focus\] dialog kind=alert .* hasFocusAt1500=false /, 'the dialog that was open last is the one named');
});

// --- Privacy ---

// Sentinels that would be unmistakable in any output. None of them may appear
// in a log line, an event-ring note, a callback report or the capture snapshot.
const TYPED_KEY = '\u03a9';                       // the character typed
const TYPED_CODE = 'KeyOmegaSentinel';
const TYPED_KEYCODE = 987654321;
const TYPED_DATA = 'ZebraSentinelData';
const DIALOG_TEXT = 'XYZZY dialog sentinel text';

test('no typed character, key code, input data or dialog text reaches a line, a note, a report or the snapshot', () => {
  const r = rig();
  r.watch.start();
  const secretKey = (over = {}) => key({ key: TYPED_KEY, code: TYPED_CODE, keyCode: TYPED_KEYCODE, data: TYPED_DATA, ...over });

  const wrapped = r.watch.wrapDialog('confirm', () => { r.t += 1200; return true; });
  wrapped(DIALOG_TEXT, DIALOG_TEXT);
  r.advance(1500);
  const snapshots = [r.watch.snapshot()];
  for (let i = 0; i < 6; i++) {
    r.watch.onKeydown(secretKey({ shiftKey: i % 2 === 0 }));
    r.watch.onCharEvent('keypress', { isTrusted: true, key: TYPED_KEY, code: TYPED_CODE, keyCode: TYPED_KEYCODE });
    r.watch.onCharEvent('beforeinput', { isTrusted: true, inputType: 'insertText', data: TYPED_DATA });
    r.advance(CONFIRM_MS);
    snapshots.push(r.watch.snapshot());
  }
  r.watch.onWindowFocus();
  snapshots.push(r.watch.snapshot());

  assert.equal(r.desyncLines().length, 1, 'the scenario did produce an episode');
  assert.equal(r.endLines().length, 1);
  assert.ok(r.lines.some((l) => l.startsWith('[focus] dialog ')), 'and a dialog line');

  const everything = JSON.stringify({ lines: r.lines, notes: r.notes, reports: r.reports, snapshots });
  for (const secret of [TYPED_KEY, TYPED_CODE, String(TYPED_KEYCODE), TYPED_DATA, DIALOG_TEXT, 'XYZZY', 'Sentinel']) {
    assert.equal(everything.includes(secret), false, `"${secret}" leaked into the output`);
  }
});

test('reports, notes and the snapshot have fixed keys', () => {
  const r = rig();
  r.watch.start();
  r.watch.wrapDialog('alert', () => {})('x');
  r.advance(1500);
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  const open = r.watch.snapshot();
  r.watch.onWindowFocus();
  const closed = r.watch.snapshot();

  assert.deepEqual(Object.keys(r.reports[0]), ['n', 'keyClass', 'active', 'sinceBlurMs', 'sinceFocusMs', 'sinceDialogCloseMs', 'markers']);
  for (const m of r.reports[0].markers) assert.deepEqual(Object.keys(m), ['kind', 'site', 'ageMs']);

  const NOTE_KEYS = {
    'dialog-open': ['kind', 'dialog', 'site'],
    'dialog-close': ['kind', 'dialog', 'site', 'openMs', 'hasFocus'],
    'dialog-settled': ['kind', 'dialog', 'site', 'hasFocusAt250', 'hasFocusAt1500', 'focusEventAfter'],
    'focus-desync': ['kind', 'n', 'keyClass', 'active'],
    'focus-desync-end': ['kind', 'n', 'durationMs', 'keydowns', 'printable', 'keypress', 'insert', 'endedBy'],
  };
  assert.deepEqual([...new Set(r.notes.map((n) => n.kind))].sort(), Object.keys(NOTE_KEYS).sort());
  for (const n of r.notes) assert.deepEqual(Object.keys(n), NOTE_KEYS[n.kind], n.kind);

  const SNAPSHOT_KEYS = ['schema', 'hasFocus', 'visible', 'episodes', 'notices', 'candidatePending',
    'sinceWindowFocusMs', 'sinceWindowBlurMs', 'episode', 'lastEpisode', 'lastDialog', 'markers'];
  assert.deepEqual(Object.keys(open), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(closed), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(open.episode), ['n', 'ageMs', 'keydowns', 'printable', 'keypress', 'insert']);
  assert.deepEqual(Object.keys(closed.lastEpisode), ['n', 'endedMsAgo', 'durationMs', 'keydowns', 'printable', 'keypress', 'insert', 'endedBy']);
  assert.deepEqual(Object.keys(closed.lastDialog), ['kind', 'site', 'closedMsAgo', 'openMs', 'hasFocusAtReturn', 'hasFocusAt250', 'hasFocusAt1500']);
  for (const m of closed.markers) assert.deepEqual(Object.keys(m), ['kind', 'site', 'msAgo']);

  // Every value is a flag, a number, null or one of a few short code-chosen words.
  const walk = (v, where) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return;
    if (typeof v === 'string') { assert.match(v, /^[A-Za-z0-9_.:-]{0,48}$/, `${where} = ${JSON.stringify(v)}`); return; }
    for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  walk({ reports: r.reports, notes: r.notes, open, closed }, 'out');
});

test('free text handed to mark() or returned as the active tag cannot reach the log as written', () => {
  const r = rig();
  r.tag = 'INPUT value="some typed words"\n[focus] forged line';
  r.watch.mark('Some Words, typed!\n[focus] forged', 'C:/Users/someone/private notes.js:12');
  r.watch.mark('drag-start', '../../etc/passwd:1');
  r.watch.onKeydown(key());
  r.advance(CONFIRM_MS);
  const line = r.desyncLines()[0];
  assert.equal(r.lines.length, 1);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes(' forged'), false, 'no injected second field or line');
  assert.match(line, / active=[A-Za-z0-9-]{1,24} /);
  assert.match(line, / markers=somewordstypedfocusforge\+150ms,drag-start\+150ms$/, 'kinds are cut to [a-z0-9-], bad sites dropped');
});

test('keyClass names a class and nothing else', () => {
  assert.equal(keyClass(key()), 'printable');
  assert.equal(keyClass(key({ key: ' ' })), 'printable');
  assert.equal(keyClass(key({ key: '\ud83d\ude00' })), 'printable', 'one code point, two UTF-16 units');
  assert.equal(keyClass(key({ key: 'Enter' })), 'named');
  assert.equal(keyClass(key({ key: 'F5' })), 'named');
  assert.equal(keyClass(key({ ctrlKey: true })), 'chord');
  assert.equal(keyClass(key({ key: 'Shift', code: 'ShiftLeft' })), 'modifier');
  assert.equal(keyClass(null), 'named');
});
