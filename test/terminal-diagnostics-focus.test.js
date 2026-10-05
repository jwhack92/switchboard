const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The browser side of the focus watch, in public/terminal-diagnostics.js: the
// listeners that feed it, the notice, the log line, the wrapped window.confirm
// and window.alert, the extra capture fields, and what Ctrl+Shift+D tells the
// user afterwards.
//
// terminal-diagnostics.js touches window and document at load, so it cannot be
// required. The two shipped files run whole in a vm context against a fake
// window and document (the way test/project-auto-open.test.js runs
// dialogs.js): what runs here is the text that ships.
//
// What this cannot prove: how a real native dialog behaves, that Chromium
// fires keypress and beforeinput the way the fakes do, or that the notice is
// readable on screen. Those need the app.

const PUBLIC = path.join(__dirname, '..', 'public');
const FOCUS_WATCH = path.join(PUBLIC, 'focus-watch.js');
const DIAGNOSTICS = path.join(PUBLIC, 'terminal-diagnostics.js');
const INDEX_HTML = path.join(PUBLIC, 'index.html');

/** An element that keeps what the toast puts into it. */
function fakeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), className: '', textContent: '', kids: [], removed: false, heard: [],
    append(...kids) { el.kids.push(...kids); },
    appendChild(kid) { el.kids.push(kid); return kid; },
    addEventListener(type, fn) { el.heard.push({ type, fn }); },
    remove() { el.removed = true; },
  };
  return el;
}

/** A terminal entry with just enough for repair() and buildReport(). */
function fakeEntry() {
  const line = { translateToString: () => '' };
  return {
    session: { sessionId: 'sess-1234-abcd', name: 'a session' },
    terminal: {
      rows: 2, cols: 80,
      buffer: { active: { viewportY: 0, baseY: 0, length: 2, type: 'normal', getLine: () => line } },
      refresh() {}, resize() {},
    },
    element: { querySelectorAll: () => [], getBoundingClientRect: () => ({ toJSON: () => ({}) }) },
  };
}

/**
 * Both files in a context of their own.
 *   focusWatch    'shipped' (default), 'absent' (the script tag failed), or
 *                 source text to run in its place
 *   diagCapture   what window.api.diagCapture does with the report
 *   confirm       the page's original window.confirm
 *   session       true to have one active session
 */
function boot({ focusWatch = 'shipped', diagCapture, confirm, alert, session = false } = {}) {
  const listeners = {};
  const timers = [];
  let seq = 0;
  const app = { warns: [], reports: [], captureCalls: 0, focused: true, body: fakeEl('body') };
  const original = {
    confirm: confirm || function () { return true; },
    alert: alert || function () {},
  };
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800,
    confirm: original.confirm,
    alert: original.alert,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    api: {
      platform: 'win32',
      getZoomFactor: () => 1,
      diagOpenFolder: () => {},
      diagCapture: (report) => {
        app.captureCalls++;
        app.reports.push(JSON.parse(JSON.stringify(report)));
        return diagCapture ? diagCapture(report) : Promise.resolve({ ok: true, json: 'C:/diag/capture-1.json' });
      },
    },
  };
  const ctx = {
    console: { warn: (...a) => app.warns.push(a.join(' ')), log() {}, error() {} },
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, ms: ms || 0, fn }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    window: win,
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      hasFocus: () => app.focused,
      activeElement: { tagName: 'INPUT', className: 'rename-input', classList: { contains: () => false } },
      createElement: (tag) => fakeEl(tag),
      head: fakeEl('head'),
      body: app.body,
      addEventListener() {},
    },
  };
  if (session) {
    ctx.activeSessionId = 's1';
    ctx.openSessions = new Map([['s1', fakeEntry()]]);
  }
  vm.createContext(ctx);
  if (focusWatch === 'shipped') vm.runInContext(fs.readFileSync(FOCUS_WATCH, 'utf8'), ctx, { filename: FOCUS_WATCH });
  else if (focusWatch !== 'absent') vm.runInContext(focusWatch, ctx, { filename: 'focus-watch.js' });
  vm.runInContext(fs.readFileSync(DIAGNOSTICS, 'utf8'), ctx, { filename: DIAGNOSTICS });

  Object.assign(app, {
    ctx, win, original,
    listenerCount: (type) => (listeners[type] || []).length,
    /** Send an event to the window listeners the page registered. */
    fire(type, event) { for (const fn of listeners[type] || []) fn(event); },
    /** Run every timer due within `ms`, soonest first (the toasts' own 12 s and 20 s timers stay put). */
    runTimers(ms) {
      for (;;) {
        const due = timers.filter((t) => t.ms <= ms).sort((a, b) => a.ms - b.ms)[0];
        if (!due) return;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
    /** Let the page's promise chains run. */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    /** The toast on screen, as text. */
    toast() {
      const live = app.body.kids.filter((el) => el.className === 'diag-toast' && !el.removed);
      if (!live.length) return null;
      const el = live[live.length - 1];
      return { title: el.kids[0].textContent, body: el.kids[1].textContent, buttons: el.kids[2].kids.map((b) => b.textContent) };
    },
    toastCount: () => app.body.kids.filter((el) => el.className === 'diag-toast').length,
    /** Press Ctrl+Shift+D and wait for what follows. */
    async hotkey() {
      const e = keydown({ key: 'D', code: 'KeyD', keyCode: 68, ctrlKey: true, shiftKey: true });
      app.fire('keydown', e);
      await app.settle();
      return e;
    },
    /** The report of a capture taken right now, as main would receive it. */
    async report() {
      await win.TermDiag.capture('test', null);
      return app.reports[app.reports.length - 1];
    },
  });
  return app;
}

function keydown(over = {}) {
  const e = {
    type: 'keydown', isTrusted: true, key: 'a', code: 'KeyA', keyCode: 65,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false,
    defaultPrevented: false, prevented: 0,
    preventDefault() { e.prevented++; }, stopPropagation() {},
    ...over,
  };
  return e;
}

// --- Loading ---

test('index.html loads focus-watch.js before terminal-diagnostics.js', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const watch = html.indexOf('<script src="focus-watch.js"></script>');
  const diag = html.indexOf('<script src="terminal-diagnostics.js"></script>');
  assert.notEqual(watch, -1, 'index.html does not load focus-watch.js');
  assert.notEqual(diag, -1);
  assert.ok(watch < diag, 'terminal-diagnostics.js wires window.FocusWatch when it starts, so it must load second');
  assert.equal(html.indexOf('focus-watch.js', watch + 30), -1, 'loaded once');
});

test('both files load; the page-load line goes to console.warn', () => {
  const app = boot();
  assert.equal(typeof app.win.FocusWatch.createFocusWatch, 'function');
  assert.equal(typeof app.win.TermDiag.capture, 'function');
  assert.deepEqual(app.warns, ['[focus] page-load hasFocus=true visible=true']);
});

// --- The dialog wrappers ---

test('window.confirm and window.alert are wrapped, stay functions, and return the original\'s value', () => {
  for (const answer of [true, false]) {
    const calls = [];
    const app = boot({
      confirm: function (...args) { calls.push({ self: this, args }); return answer; },
      alert: function (...args) { calls.push({ self: this, args, alert: true }); },
    });
    assert.equal(typeof app.win.confirm, 'function');
    assert.equal(typeof app.win.alert, 'function');
    assert.notEqual(app.win.confirm, app.original.confirm, 'confirm is wrapped');
    assert.notEqual(app.win.alert, app.original.alert, 'alert is wrapped');

    // Called bare, the way every call site does it (`confirm(...)`, no `window.`).
    const { confirm: bareConfirm, alert: bareAlert } = app.win;
    assert.equal(bareConfirm('Stop this session?'), answer);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].self, app.win, 'the original is called on window (a native dialog throws on any other this)');
    assert.deepEqual(calls[0].args, ['Stop this session?']);

    assert.equal(bareAlert('Could not save'), undefined);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].self, app.win);
    assert.deepEqual(calls[1].args, ['Could not save']);
  }
});

test('a dialog shows up in a capture as kind, call site and timings, never as its text', async () => {
  const app = boot();
  app.focused = false;
  app.win.confirm('XYZZY dialog sentinel text');
  app.runTimers(1500);
  const report = await app.report();

  const dialogNotes = report.events.filter((n) => /^dialog-/.test(n.kind));
  assert.deepEqual(dialogNotes.map((n) => n.kind), ['dialog-open', 'dialog-close', 'dialog-settled']);
  for (const n of dialogNotes) {
    assert.equal(n.dialog, 'confirm');
    assert.match(n.site, /^terminal-diagnostics-focus\.test\.js:\d+$/);
  }
  assert.deepEqual(Object.keys(dialogNotes[1]).sort(), ['dialog', 'hasFocus', 'kind', 'openMs', 'site', 't']);
  assert.equal(report.focusWatch.lastDialog.kind, 'confirm');
  assert.equal(report.focusWatch.lastDialog.hasFocusAt1500, false);
  assert.equal(app.warns.filter((l) => l.startsWith('[focus] dialog kind=confirm ')).length, 1);

  const out = JSON.stringify({ report, warns: app.warns });
  assert.equal(out.includes('XYZZY'), false, 'dialog text reached the capture or the log');
  assert.equal(out.includes('sentinel'), false);
});

// --- Detection, the notice and the log line ---

test('keys in an unfocused window give one notice that names the cure and one log line', () => {
  const app = boot();
  app.focused = false;
  app.fire('keydown', keydown());
  assert.equal(app.toast(), null, 'nothing before the confirm wait');
  app.runTimers(150);
  assert.deepEqual(app.toast(), {
    title: 'Keyboard input is stuck in this window',
    body: 'Click another program and come back. (Recorded.)',
    buttons: ['Dismiss'],
  });
  for (let i = 0; i < 50; i++) app.fire('keydown', keydown());
  app.runTimers(150);
  assert.equal(app.toastCount(), 1, 'one notice per episode');
  const desync = app.warns.filter((l) => l.startsWith('[focus] desync '));
  assert.equal(desync.length, 1, 'one line per episode');
  assert.match(desync[0], /^\[focus\] desync n=1 keyClass=printable active=INPUT /);

  app.focused = true;
  app.fire('focus', {});
  const end = app.warns.filter((l) => l.startsWith('[focus] episode-end '));
  assert.equal(end.length, 1);
  assert.match(end[0], / keydowns=51 printable=51 charEvents=0 .* endedBy=window-focus$/);
});

test('keys in a focused window give no notice and no line beyond page-load', () => {
  const app = boot();
  for (let i = 0; i < 20; i++) app.fire('keydown', keydown());
  app.fire('keypress', { type: 'keypress', isTrusted: true, key: 'a' });
  app.fire('blur', {});
  app.fire('focus', {});
  app.runTimers(5000);
  assert.equal(app.toast(), null);
  assert.deepEqual(app.warns, ['[focus] page-load hasFocus=true visible=true']);
});

test('a window blur reaches the watch, and a hidden page opens no episode', async () => {
  const app = boot();
  assert.equal((await app.report()).focusWatch.sinceWindowBlurMs, null, 'no blur yet');
  app.fire('blur', {});
  assert.equal(typeof (await app.report()).focusWatch.sinceWindowBlurMs, 'number');

  app.focused = false;
  app.ctx.document.visibilityState = 'hidden';
  app.fire('keydown', keydown());
  app.runTimers(150);
  assert.equal(app.toast(), null, 'a hidden page is not a stuck one');
  assert.equal((await app.report()).focusWatch.visible, false);
});

// --- Markers from other files ---
//
// The watch can only name what came before an episode if the suspected paths
// tell it. They do so through window.TermDiag.focusMark(kind), one guarded
// line each, the way the terminal's recorders are called.

const SESSION_DRAG = path.join(PUBLIC, 'session-drag.js');
/** The one form a marker call may take outside terminal-diagnostics.js. */
const GUARDED_MARK = /try \{ window\.TermDiag && window\.TermDiag\.focusMark\(([^;]+)\); \} catch \{\}/;

/** Where the markers have to be: the file, the kind, and the text the marker
 *  sits next to. `before` is the call the marker comes just ahead of, and
 *  every such call in the file must have one; `after` is the opening line of
 *  the function or handler it is the first act of. */
const MARKER_SITES = [
  { file: 'session-drag.js', before: 'window.api.sessionDragStart(', kind: "'drag-start'" },
  { file: 'session-drag.js', after: 'function finish({ cancelled }) {', kind: "cancelled ? 'drag-cancel' : 'drag-end'" },
  { file: 'app.js', after: 'async function adoptSession(', kind: "'adopt'" },
  { file: 'app.js', after: 'window.api.onReleaseSession(', kind: "'release'" },
  { file: 'dialogs.js', before: 'window.api.browseFolder(', kind: "'browse-folder'" },
  { file: 'projects-view.js', before: 'window.api.browseFolder(', kind: "'browse-folder'" },
  { file: 'file-actions.js', before: 'window.api.manageProjectEntry(', kind: "'manage-' + action" },
];

test('every suspected path sets its marker where it acts, in the guarded form', () => {
  for (const { file, before, after, kind } of MARKER_SITES) {
    const anchor = before || after;
    const lines = fs.readFileSync(path.join(PUBLIC, file), 'utf8').split('\n');
    const hits = lines.map((l, i) => (l.includes(anchor) ? i : -1)).filter((i) => i >= 0);
    assert.ok(hits.length > 0, `${file} no longer has "${anchor}"; move its marker and this row`);
    for (const i of hits) {
      // Within three lines: a comment may sit between the two.
      const window3 = before ? lines.slice(Math.max(0, i - 3), i) : lines.slice(i + 1, i + 4);
      const near = window3.map((l) => GUARDED_MARK.exec(l)).filter(Boolean);
      assert.equal(near.length, 1, `${file}:${i + 1} ("${anchor}") has no marker next to it`);
      assert.equal(near[0][1], kind, `${file}:${i + 1}`);
    }
  }
});

test('a marker call anywhere in public/ is the guarded one-liner and passes a kind only', () => {
  let seen = 0;
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js') && f !== 'terminal-diagnostics.js')) {
    fs.readFileSync(path.join(PUBLIC, file), 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes('focusMark')) return;
      seen++;
      const m = GUARDED_MARK.exec(line);
      assert.ok(m, `${file}:${i + 1} calls focusMark without the guard: ${line.trim()}`);
      // A quoted word, or a quoted prefix plus `action`, or a choice of two
      // quoted words. Nothing a user typed and nothing read from the page.
      assert.match(m[1], /^(?:'[a-z-]+'|'[a-z-]+' \+ action|cancelled \? '[a-z-]+' : '[a-z-]+')$/, `${file}:${i + 1}`);
    });
  }
  assert.equal(seen, 9, 'two in session-drag.js, two in app.js, one in dialogs.js, three in projects-view.js, one in file-actions.js');
});

test('TermDiag.focusMark puts the caller\'s file and line, and nothing else it was given, into the desync line and the capture', async () => {
  // No window focus event in this test, so the page-load marker stays listed.
  const app = boot();
  app.win.TermDiag.focusMark('browse-folder', 'ZebraSentinelData', { text: 'ZebraSentinelData' });
  app.win.TermDiag.focusMark('Some Words\n[focus] forged ZebraSentinelData');
  app.focused = false;
  app.fire('keydown', keydown());
  app.runTimers(150);

  const desync = app.warns.filter((l) => l.startsWith('[focus] desync '));
  assert.equal(desync.length, 1);
  // A kind is cut to 24 of [a-z0-9-]; every real caller passes a literal.
  assert.match(
    desync[0],
    / markers=page-load\+\d+ms,browse-folder@terminal-diagnostics-focus\.test\.js:\d+\+\d+ms,somewordsfocusforgedzebr@terminal-diagnostics-focus\.test\.js:\d+\+\d+ms$/,
  );
  const report = await app.report();
  assert.deepEqual(report.focusWatch.markers.map((m) => m.kind), ['page-load', 'browse-folder', 'somewordsfocusforgedzebr']);
  assert.match(report.focusWatch.markers[1].site, /^terminal-diagnostics-focus\.test\.js:\d+$/);
  const out = JSON.stringify({ focusWatch: report.focusWatch, warns: app.warns });
  assert.equal(out.includes('ZebraSentinelData'), false);
  assert.equal(out.includes(' forged'), false);
});

test('focusMark does nothing, quietly, when the watch is absent or broken', () => {
  const absent = boot({ focusWatch: 'absent' });
  assert.equal(absent.win.TermDiag.focusMark('drag-start'), undefined);
  assert.deepEqual(absent.warns, []);

  const broken = boot({ focusWatch: `window.FocusWatch = { createFocusWatch: () => ({
    start() {}, wrapDialog: (k, fn) => fn, mark() { throw new Error('mark failed'); },
  }) };` });
  assert.equal(broken.win.TermDiag.focusMark('drag-start'), undefined, 'no callSite on window.FocusWatch, and a throwing mark');
});

/**
 * session-drag.js run in the page's context, with its document listeners
 * kept so a drag can be acted out. `api` replaces the three drag calls.
 */
function withSessionDrag(app, api = {}) {
  const heard = {};
  const drag = { calls: [] };
  Object.assign(app.ctx.document, {
    addEventListener: (type, fn) => { (heard[type] = heard[type] || []).push(fn); },
    querySelector: () => null,
  });
  Object.assign(app.body, { classList: { add() {}, remove() {} }, style: {} });
  Object.assign(app.ctx, { activePtyIds: new Set(['s1']), sessionMap: new Map(), openSessions: app.ctx.openSessions || new Map() });
  Object.assign(app.win.api, {
    sessionDragStart: async () => { drag.calls.push('start'); return { ok: true }; },
    sessionDragEnd: async () => { drag.calls.push('end'); },
    sessionDragCancel: async () => { drag.calls.push('cancel'); },
    ...api,
  });
  vm.runInContext(fs.readFileSync(SESSION_DRAG, 'utf8'), app.ctx, { filename: SESSION_DRAG });
  vm.runInContext('initSessionDrag()', app.ctx);

  const handle = {
    closest: (sel) => (sel === '.session-drag-handle'
      ? { closest: () => ({ dataset: { sessionId: 's1' } }) } : null),
    setPointerCapture() {}, releasePointerCapture() {},
  };
  const pointer = (over) => ({ pointerId: 7, button: 0, clientX: 10, clientY: 10, target: handle, preventDefault() {}, ...over });
  const fire = (type, e) => { for (const fn of heard[type] || []) fn(e); };
  /** Press on a session's handle and move far enough to start the drag. */
  drag.start = async () => {
    fire('pointerdown', pointer());
    fire('pointermove', pointer({ clientX: 40 }));
    await app.settle();
  };
  drag.release = async () => { fire('pointerup', pointer({ clientX: 40 })); await app.settle(); };
  drag.pointerCancel = async () => { fire('pointercancel', pointer()); await app.settle(); };
  drag.escape = async () => { fire('keydown', { key: 'Escape', preventDefault() {} }); await app.settle(); };
  /** The marker kinds in a capture taken now, without the page-load one. */
  drag.kinds = async () => (await app.report()).focusWatch.markers.map((m) => m.kind).filter((k) => k !== 'page-load');
  return drag;
}

test('a session drag is on the suspect list: start and end, with session-drag.js and a line', async () => {
  const app = boot();
  const drag = withSessionDrag(app);
  await drag.start();
  await drag.release();
  assert.deepEqual(drag.calls, ['start', 'end']);

  app.focused = false;
  app.fire('keydown', keydown());
  app.runTimers(150);
  const desync = app.warns.filter((l) => l.startsWith('[focus] desync '));
  assert.equal(desync.length, 1);
  assert.match(desync[0], / markers=page-load\+\d+ms,drag-start@session-drag\.js:\d+\+\d+ms,drag-end@session-drag\.js:\d+\+\d+ms$/);
});

test('a drag that is cancelled, by the pointer, by Escape or by main refusing it, is marked drag-cancel', async () => {
  const byPointer = boot();
  const a = withSessionDrag(byPointer);
  await a.start();
  await a.pointerCancel();
  assert.deepEqual(await a.kinds(), ['drag-start', 'drag-cancel']);

  const byEscape = boot();
  const b = withSessionDrag(byEscape);
  await b.start();
  await b.escape();
  assert.deepEqual(await b.kinds(), ['drag-start', 'drag-cancel']);

  const refused = boot();
  const c = withSessionDrag(refused, { sessionDragStart: async () => ({ ok: false }) });
  await c.start();
  assert.deepEqual(await c.kinds(), ['drag-start', 'drag-cancel']);

  // A press that never moved is not a drag and leaves no marker.
  const click = boot();
  const d = withSessionDrag(click);
  d.calls.length = 0;
  await d.release();
  await d.escape();
  assert.deepEqual(await d.kinds(), []);
});

test('the drag works the same with no TermDiag, an older TermDiag, or a focusMark that throws', async () => {
  const variants = {
    'no TermDiag': (win) => { delete win.TermDiag; },
    'TermDiag without focusMark': (win) => { win.TermDiag = {}; },
    'focusMark throws': (win) => { win.TermDiag = { focusMark() { throw new Error('mark failed'); } }; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const app = boot();
    const drag = withSessionDrag(app);
    change(app.win);
    await drag.start();
    await drag.release();
    assert.deepEqual(drag.calls, ['start', 'end'], name);
    await drag.start();
    await drag.pointerCancel();
    assert.deepEqual(drag.calls, ['start', 'end', 'start', 'cancel'], name);
  }
});

// --- Recorders and capture fields ---

// Sentinels that would be unmistakable anywhere in a capture.
const TYPED_KEY = '\u03a9';
const TYPED_CODE = 'KeyOmegaSentinel';
const TYPED_DATA = 'ZebraSentinelData';

test('keypress and beforeinput are recorded as event type and inputType only', async () => {
  const app = boot();
  app.fire('keypress', { type: 'keypress', isTrusted: true, key: TYPED_KEY, code: TYPED_CODE, keyCode: 937, charCode: 937 });
  app.fire('beforeinput', { type: 'beforeinput', isTrusted: true, inputType: 'insertText', data: TYPED_DATA });
  app.fire('beforeinput', { type: 'beforeinput', isTrusted: true, inputType: 'deleteContentBackward', data: null });
  app.fire('beforeinput', { type: 'beforeinput', isTrusted: true, inputType: 'insert ' + TYPED_KEY + '<b>1', data: TYPED_DATA });
  const report = await app.report();

  const chars = report.keys.filter((k) => k.type === 'keypress' || k.type === 'beforeinput');
  assert.equal(chars.length, 4);
  assert.deepEqual(Object.keys(chars[0]), ['t', 'layer', 'type', 'focus']);
  for (const k of chars.slice(1)) assert.deepEqual(Object.keys(k), ['t', 'layer', 'type', 'inputType', 'focus']);
  assert.deepEqual(chars.map((k) => k.inputType), [undefined, 'insertText', 'deleteContentBackward', 'insertb']);
  assert.ok(chars.every((k) => k.layer === 'document'));
  assert.deepEqual(Object.keys(chars[0].focus), ['docHasFocus', 'activeTag', 'activeClass', 'activeIsXtermTextarea']);

  // Without `t`: a real timestamp can contain any three digits.
  const out = JSON.stringify(chars.map(({ t, ...rest }) => rest));
  for (const secret of [TYPED_KEY, TYPED_CODE, TYPED_DATA, '937']) {
    assert.equal(out.includes(secret), false, `"${secret}" reached a keypress/beforeinput entry`);
  }
});

test('the capture gains a focusWatch field of flags and counts; typed keys reach neither it, the notes nor the log', async () => {
  const app = boot();
  app.focused = false;
  for (let i = 0; i < 5; i++) {
    app.fire('keydown', keydown({ key: TYPED_KEY, code: TYPED_CODE, keyCode: 987654321 }));
    app.fire('beforeinput', { type: 'beforeinput', isTrusted: true, inputType: 'insertText', data: TYPED_DATA });
  }
  app.runTimers(150);
  const report = await app.report();

  assert.deepEqual(Object.keys(report.focusWatch), ['schema', 'hasFocus', 'visible', 'episodes', 'notices', 'candidatePending',
    'sinceWindowFocusMs', 'sinceWindowBlurMs', 'episode', 'lastEpisode', 'lastDialog', 'markers']);
  assert.equal(report.focusWatch.hasFocus, false);
  assert.equal(report.focusWatch.episodes, 1);
  assert.equal(report.focusWatch.episode.keydowns, 5);
  assert.equal(report.focusWatch.episode.insert, 5);
  assert.equal(report.events.filter((n) => n.kind === 'focus-desync').length, 1);

  // report.keys is left out on purpose: its keydown entries have carried the
  // key since before this change (recordKey), and this change does not touch them.
  const events = report.events.map(({ t, ...rest }) => rest);   // `t` is a real timestamp
  const out = JSON.stringify({ focusWatch: report.focusWatch, events, warns: app.warns });
  for (const secret of [TYPED_KEY, TYPED_CODE, TYPED_DATA, '987654321', 'Sentinel']) {
    assert.equal(out.includes(secret), false, `"${secret}" reached the focus fields, the notes or the log`);
  }
});

// --- Degrading: the page must behave as before without the new file ---

test('without focus-watch.js the page loads, dialogs are untouched, and the hotkey and recorders still work', async () => {
  const app = boot({ focusWatch: 'absent' });
  assert.equal(app.win.FocusWatch, undefined);
  assert.equal(app.win.confirm, app.original.confirm, 'confirm must be the very function the page had');
  assert.equal(app.win.alert, app.original.alert);
  assert.deepEqual(app.warns, []);

  app.focused = false;
  app.fire('keydown', keydown());
  app.fire('keypress', { type: 'keypress', isTrusted: true });
  app.fire('focus', {});
  app.fire('blur', {});
  app.runTimers(5000);
  assert.equal(app.toast(), null, 'no detector, no notice');

  const e = await app.hotkey();
  assert.equal(e.prevented, 1);
  assert.equal(app.captureCalls, 1);
  const report = app.reports[0];
  assert.equal(report.focusWatch, null);
  assert.equal(report.keys.filter((k) => k.type === 'keypress').length, 1);
  assert.deepEqual(report.events.map((n) => n.kind), ['started', 'window-focus', 'window-blur']);
  assert.equal(app.toast().title, 'Captured');
});

test('a focus watch that throws from every method cannot break the key listener or the dialogs', async () => {
  const broken = `window.FocusWatch = { createFocusWatch: () => {
    const boom = () => { throw new Error('watch failed'); };
    return { onKeydown: boom, onCharEvent: boom, onWindowFocus: boom, onWindowBlur: boom, snapshot: boom, start: boom, wrapDialog: boom };
  } };`;
  const app = boot({ focusWatch: broken });
  assert.equal(app.win.confirm, app.original.confirm, 'a wrap that failed leaves the original in place');
  assert.equal(app.win.confirm('x'), true);
  app.fire('keydown', keydown());
  app.fire('keypress', { type: 'keypress', isTrusted: true });
  app.fire('focus', {});
  app.fire('blur', {});
  const e = await app.hotkey();
  assert.equal(e.prevented, 1);
  assert.equal(app.captureCalls, 1);
  assert.equal(app.reports[0].focusWatch, null, 'a throwing snapshot reads as null');
  assert.equal(app.toast().title, 'Captured');

  const throwsAtCreate = boot({ focusWatch: 'window.FocusWatch = { createFocusWatch: () => { throw new Error("no"); } };' });
  assert.equal(throwsAtCreate.win.confirm, throwsAtCreate.original.confirm);
  await throwsAtCreate.hotkey();
  assert.equal(throwsAtCreate.captureCalls, 1);
});

// --- Ctrl+Shift+D says what happened ---

test('Ctrl+Shift+D with no session still writes a capture and names the file', async () => {
  const app = boot();
  const e = await app.hotkey();
  assert.equal(e.prevented, 1);
  assert.equal(app.captureCalls, 1);
  assert.equal(app.reports[0].reason, 'user');
  assert.equal(app.reports[0].session.id, null, 'main names such a file "nosession"');
  assert.deepEqual(app.toast(), {
    title: 'Captured',
    body: 'No session is open in this window, so nothing was repainted. Saved to C:/diag/capture-1.json',
    buttons: ['Open folder', 'Dismiss'],
  });
});

test('the capture toast replaces the stuck-keyboard notice, so it repeats the cure while the episode is open', async () => {
  const CURE = ' Keyboard input is stuck in this window: click another program and come back.';
  for (const session of [false, true]) {
    for (const diagCapture of [undefined, () => Promise.resolve(null)]) {
      const app = boot({ session, diagCapture });
      app.focused = false;
      app.fire('keydown', keydown());
      app.runTimers(150);
      assert.equal(app.toast().title, 'Keyboard input is stuck in this window');
      await app.hotkey();
      assert.match(app.toast().title, /^Capture/);
      assert.ok(app.toast().body.endsWith('.' + CURE), app.toast().body);

      // Once the window has focus again the toast is the ordinary one.
      app.focused = true;
      app.fire('focus', {});
      await app.hotkey();
      assert.equal(app.toast().body.includes('stuck'), false, app.toast().body);
    }
  }
});

test('Ctrl+Shift+D with a session reports as before when the capture was written', async () => {
  const app = boot({ session: true });
  await app.hotkey();
  assert.equal(app.reports[0].session.id, 'sess-1234-abcd');
  assert.deepEqual(app.toast(), {
    title: 'Captured',
    body: 'Saved to C:/diag/capture-1.json. If it still looks wrong, Force full redraw makes the CLI repaint everything.',
    buttons: ['Force full redraw', 'Open folder', 'Dismiss'],
  });
});

test('a capture that was not written is never called "Captured"', async () => {
  const failures = {
    'null reply': () => Promise.resolve(null),
    'undefined reply': () => Promise.resolve(undefined),
    'ok:false': () => Promise.resolve({ ok: false, error: 'EACCES: permission denied' }),
    'rejected invoke': () => Promise.reject(new Error('no handler')),
    'throwing invoke': () => { throw new Error('api missing'); },
  };
  for (const [name, diagCapture] of Object.entries(failures)) {
    for (const session of [false, true]) {
      const app = boot({ diagCapture, session });
      await app.hotkey();
      const toast = app.toast();
      assert.equal(toast.title, 'Capture failed', `${name}, session=${session}`);
      assert.match(toast.body, /^Nothing was saved/, name);
      assert.equal(/Captured|Saved to/.test(toast.title + toast.body), false, name);
      assert.deepEqual(toast.buttons, session ? ['Force full redraw', 'Open folder', 'Dismiss'] : ['Open folder', 'Dismiss']);
    }
  }
  const denied = boot({ diagCapture: failures['ok:false'] });
  await denied.hotkey();
  assert.equal(denied.toast().body, 'Nothing was saved (EACCES: permission denied).');
});

test('a capture reply that never comes frees the next capture after 8 s', async () => {
  const app = boot({ diagCapture: () => new Promise(() => {}) });
  await app.hotkey();
  assert.equal(app.captureCalls, 1);
  assert.equal(app.toast(), null, 'still waiting');

  // A second press while the first is out is refused, as before.
  await app.hotkey();
  assert.equal(app.captureCalls, 1);
  assert.deepEqual(app.toast(), {
    title: 'Capture failed',
    body: 'Nothing was saved (the previous capture has not finished).',
    buttons: ['Open folder', 'Dismiss'],
  });

  app.runTimers(7999);
  await app.settle();
  await app.hotkey();
  assert.equal(app.captureCalls, 1, 'not before 8 s');

  app.runTimers(8000);
  await app.settle();
  assert.equal(app.toast().title, 'Capture failed');
  assert.equal(app.toast().body, 'Nothing was saved (no reply after 8 s).');
  await app.hotkey();
  assert.equal(app.captureCalls, 2, 'the hotkey works again');
});
