'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, load } = require('../test-support/source-cut');
const M = require('../public/main-fault-notice.js');

const SID = '11111111-2222-3333-4444-555555555555';
const rec = (over = {}) => ({
  id: 'f1', kind: 'internal', sessionId: null, firstLine: 'TypeError: x is not a function',
  count: 1, firstAt: 1000, lastAt: 1000, previousRun: false, dismissed: false,
  stack: 'TypeError: x is not a function\n    at tick (main.js:10:3)', runErrors: 0, ...over,
});
const T = 'Fix the login';                 // a row title
const B3 = ['Show details', 'Open log folder', 'Dismiss'];

test('main-fault-notice: preload forwards the five notice calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  let exposed = null;
  const calls = [];
  const listeners = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'api'); exposed = api; } },
    ipcRenderer: {
      invoke: (...args) => { calls.push(args); return 'answer'; },
      on: (channel, fn) => { (listeners[channel] = listeners[channel] || []).push(fn); },
      send() {},
    },
    webFrame: {}, webUtils: {},
  };
  load(src, { file: 'preload.js', globals: { require: () => electron, process: { platform: 'win32' } } });
  assert.equal(exposed.getMainFaults(), 'answer');
  exposed.dismissMainFault('f1');
  exposed.clearMainFault('f1');
  exposed.openMainLog();
  assert.deepEqual(calls, [['get-main-faults'], ['dismiss-main-fault', 'f1'], ['clear-main-fault', 'f1'], ['open-main-log']]);
  const got = [];
  exposed.onMainFault((record) => got.push(record));
  assert.equal(listeners['main-fault'].length, 1);
  listeners['main-fault'][0]({ sender: 'the event' }, { id: 'f1' }, 'not passed on');
  assert.deepEqual(got, [{ id: 'f1' }]);
});

test('main-fault-notice: the text builder gives one line and a count only above 1, and never inserts markup from the error text', () => {
  assert.deepEqual(M.noticeText(rec(), ''), { heading: 'Switchboard hit an internal error', lines: ['TypeError: x is not a function'], buttons: B3 });
  assert.deepEqual(M.noticeText(rec({ count: 2 }), '').lines, ['TypeError: x is not a function', 'Happened 2 times']);
  assert.equal(M.noticeText(rec({ count: 1000 }), '').lines[1], 'Happened 1000 times');
  const EVIL = '<img src=x onerror=alert(1)>';
  assert.deepEqual(M.noticeText(rec({ firstLine: EVIL }), '').lines, [EVIL], 'the text is handed on as text, untouched');
});

test('main-fault-notice: the exact headings, lines and buttons of A4, A5, A6 and A14, and the look of a kind it does not know', () => {
  // A4
  assert.deepEqual(M.noticeText(rec({ kind: 'stop-stalled', sessionId: SID, firstLine: '', stack: '' }), T), {
    heading: 'A session did not stop',
    lines: ['Fix the login was still running 8 seconds after Stop. It takes no typing while that lasts. Press Stop on its row or in its header to try once more.'],
    buttons: ['Dismiss'] });
  // A5
  assert.deepEqual(M.noticeText(rec({ kind: 'stop-failed', sessionId: SID, firstLine: 'Error: kill EPERM' }), T), {
    heading: 'A session did not stop',
    lines: ['Fix the login could not be stopped: Error: kill EPERM. It is still open and takes no typing. Press Stop again to try once more.'],
    buttons: B3 });
  // A6
  const last = rec({ kind: 'last-run', firstLine: '', stack: '' });
  assert.deepEqual(M.noticeText(last, ''), {
    heading: 'Switchboard did not close normally last time',
    lines: ['It crashed or was ended from outside (Task Manager, or Windows shutting down).'],
    buttons: ['Open log folder', 'Dismiss'] });
  assert.equal(M.noticeText({ ...last, runErrors: 3 }, '').lines[1], '3 errors were recorded in that run.');
  // Agreed by Jason (CK-S): the singular for exactly one error. Entry A6 gives only the form with N.
  assert.equal(M.noticeText({ ...last, runErrors: 1 }, '').lines[1], '1 error was recorded in that run.');
  // A14
  assert.deepEqual(M.noticeText(rec({ kind: 'pty', sessionId: SID, firstLine: 'Error: read EIO' }), T), {
    heading: 'A terminal reported an error', lines: ['Fix the login: Error: read EIO'], buttons: B3 });
  // A kind this page does not know is drawn as an internal error.
  assert.deepEqual(M.noticeText(rec({ kind: 'something-new' }), T), M.noticeText(rec(), T));
  // "Happened N times" belongs to A2 only.
  for (const kind of ['stop-stalled', 'stop-failed', 'last-run', 'pty']) {
    assert.ok(!M.noticeText(rec({ kind, sessionId: SID, count: 5 }), T).lines.some((l) => l.startsWith('Happened')), kind);
  }
});

test('main-fault-notice: a record with no error text leaves the empty part out', () => {
  assert.deepEqual(M.noticeText(rec({ firstLine: '' }), '').lines, []);
  assert.deepEqual(M.noticeText(rec({ firstLine: '', count: 3 }), '').lines, ['Happened 3 times']);
  assert.deepEqual(M.noticeText(rec({ kind: 'stop-failed', sessionId: SID, firstLine: '' }), T).lines,
    ['Fix the login could not be stopped. It is still open and takes no typing. Press Stop again to try once more.']);
  assert.deepEqual(M.noticeText(rec({ kind: 'pty', sessionId: SID, firstLine: '' }), T).lines, ['Fix the login']);
});

test("main-fault-notice: the row title comes from the session's row, cleaned, else the id's first 8 characters", () => {
  const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = (row) => new Map([[SID, row]]);
  assert.equal(M.rowTitle(SID, rows({ name: null, aiTitle: '<command>Fix</command> the login', summary: 's' }), clean), 'Fix the login');
  assert.equal(M.rowTitle(SID, rows({ name: 'Typed', aiTitle: 'Auto', summary: 'Sum' }), clean), 'Typed');
  assert.equal(M.rowTitle(SID, rows({ name: null, aiTitle: null, summary: 'Sum' }), clean), 'Sum');
  assert.equal(M.rowTitle(SID, rows({ name: 'Raw <b>', aiTitle: null, summary: null }), undefined), 'Raw <b>', 'no cleaner on the page: the text as it is');
  assert.equal(M.rowTitle(SID, new Map(), clean), '11111111', 'no row');
  assert.equal(M.rowTitle(SID, rows({ name: null, aiTitle: null, summary: '' }), clean), '11111111', 'a row with nothing to show');
  assert.equal(M.rowTitle(SID, undefined, undefined), '11111111', 'app.js has not loaded');
  assert.equal(M.rowTitle(SID, { get() { throw new Error('boom'); } }, clean), '11111111');
});

test('main-fault-notice: the chip reads "1 notice", "3 notices" and "2 notices · last run", and nothing when no notice is dismissed', () => {
  const d = (over) => rec({ dismissed: true, ...over });
  assert.equal(M.chipText([]), '');
  assert.equal(M.chipText([rec()]), '', 'an open notice is not in the chip');
  assert.equal(M.chipText([d({ id: 'a' })]), '1 notice');
  assert.equal(M.chipText([d({ id: 'a' }), rec({ id: 'open' }), d({ id: 'b' }), d({ id: 'c' })]), '3 notices');
  assert.equal(M.chipText([d({ id: 'a', previousRun: true }), d({ id: 'b', previousRun: true })]), '2 notices \u00b7 last run');
  assert.equal(M.chipText([d({ id: 'a', previousRun: true })]), '1 notice \u00b7 last run');
  assert.equal(M.chipText([d({ id: 'a', previousRun: true }), d({ id: 'b' })]), '2 notices', 'one is from this run');
  assert.equal(M.chipText([d({ id: 'lr', kind: 'last-run' }), d({ id: 'a', previousRun: true })]), '2 notices \u00b7 last run', "the 'last-run' record is from the previous run whatever its flag says");
  assert.equal(M.CHIP_TITLE, 'Notices you dismissed. Click to show them.');
});

test('main-fault-notice: the model shows the newest open notice with "+N more", and after a chip click the dismissed ones with Next and Clear', () => {
  const ui = { chipOpen: false, chipIndex: 0, detailsFor: null, copyLabel: 'Copy' };
  const titleOf = () => T;
  const a = rec({ id: 'a', firstAt: 1000, firstLine: 'Error: a' });
  const b = rec({ id: 'b', firstAt: 2000, firstLine: 'Error: b' });
  const c = rec({ id: 'c', firstAt: 3000, firstLine: 'Error: c' });
  const off = (r) => ({ ...r, dismissed: true });
  assert.deepEqual(M.noticeModel([], ui, titleOf), { chip: '', panel: null });
  // Three open, in any order: the newest by firstAt shows.
  assert.deepEqual(M.noticeModel([a, c, b], ui, titleOf), { chip: '',
    panel: { id: 'c', heading: 'Switchboard hit an internal error', lines: ['Error: c'], more: '+2 more', details: null, buttons: B3 } });
  assert.equal(M.noticeModel([a], ui, titleOf).panel.more, '');
  // Two records of the same moment: the one whose id sorts first shows, whatever order they came in.
  const twin = rec({ id: 'c0', firstAt: 3000, firstLine: 'Error: twin' });
  assert.equal(M.noticeModel([c, twin], ui, titleOf).panel.id, 'c');
  assert.equal(M.noticeModel([twin, c, a], ui, titleOf).panel.id, 'c');
  // Dismiss shows the next one; the dismissed one goes to the chip.
  let m = M.noticeModel([a, b, off(c)], ui, titleOf);
  assert.deepEqual([m.chip, m.panel.id, m.panel.more], ['1 notice', 'b', '+1 more']);
  // All dismissed: nothing in the corner until the chip is clicked.
  const all = [off(a), off(b), off(c)];
  assert.deepEqual(M.noticeModel(all, ui, titleOf), { chip: '3 notices', panel: null });
  m = M.noticeModel(all, { ...ui, chipOpen: true }, titleOf);
  assert.deepEqual([m.panel.id, m.panel.more], ['c', '']);
  assert.deepEqual(m.panel.buttons, ['Show details', 'Open log folder', 'Next', 'Clear']);
  assert.equal(M.noticeModel(all, { ...ui, chipOpen: true, chipIndex: 1 }, titleOf).panel.id, 'b');
  assert.equal(M.noticeModel(all, { ...ui, chipOpen: true, chipIndex: 3 }, titleOf).panel.id, 'c', 'Next goes round');
  // "Next" only when there is more than one.
  assert.deepEqual(M.noticeModel([off(a)], { ...ui, chipOpen: true }, titleOf).panel.buttons, ['Show details', 'Open log folder', 'Clear']);
  // Each kind keeps its own buttons; Dismiss becomes Next (only with more than one) and Clear. Decided by Jason (CK-R).
  const stalled = off(rec({ id: 's', kind: 'stop-stalled', sessionId: SID, firstLine: '', stack: '', firstAt: 9000 }));
  assert.deepEqual(M.noticeModel([stalled, off(a)], { ...ui, chipOpen: true }, titleOf).panel.buttons, ['Next', 'Clear']);
  const lastRun = off(rec({ id: 'lr', kind: 'last-run', firstLine: '', stack: '' }));
  assert.deepEqual(M.noticeModel([lastRun], { ...ui, chipOpen: true }, titleOf).panel.buttons, ['Open log folder', 'Clear']);
  // While the chip is open the dismissed ones show, newest first, also when an open notice exists; closed, the open one shows. Decided by Jason (CK-T).
  assert.equal(M.noticeModel([a, off(b)], { ...ui, chipOpen: true }, titleOf).panel.id, 'b');
  assert.equal(M.noticeModel([a, off(b)], ui, titleOf).panel.id, 'a');
  // The row title is asked for the record's session.
  const asked = [];
  M.noticeModel([rec({ kind: 'pty', sessionId: SID })], ui, (id) => { asked.push(id); return T; });
  assert.deepEqual(asked, [SID]);
});

test('main-fault-notice: details: the full error text, with Copy and Hide details in place of Show details', () => {
  const ui = { chipOpen: false, chipIndex: 0, detailsFor: 'f1', copyLabel: 'Copy' };
  let p = M.noticeModel([rec()], ui, () => T).panel;
  assert.equal(p.details, rec().stack);
  assert.deepEqual(p.buttons, ['Copy', 'Hide details', 'Open log folder', 'Dismiss']);
  assert.equal(M.noticeModel([rec()], { ...ui, copyLabel: 'Copied' }, () => T).panel.buttons[0], 'Copied');
  assert.equal(M.noticeModel([rec()], { ...ui, copyLabel: 'Not copied' }, () => T).panel.buttons[0], 'Not copied');
  p = M.noticeModel([rec()], { ...ui, detailsFor: 'another' }, () => T).panel;
  assert.deepEqual([p.details, p.buttons[0]], [null, 'Show details']);
  assert.equal(M.noticeModel([rec({ stack: '' })], ui, () => T).panel.details, 'TypeError: x is not a function', 'no stack: the first line');
  // A kind with no "Show details" never shows a details box.
  p = M.noticeModel([rec({ kind: 'stop-stalled', sessionId: SID })], ui, () => T).panel;
  assert.deepEqual([p.details, p.buttons], [null, ['Dismiss']]);
  // From the chip.
  p = M.noticeModel([rec({ dismissed: true }), rec({ id: 'g', dismissed: true, firstAt: 1 })], { ...ui, chipOpen: true }, () => T).panel;
  assert.deepEqual(p.buttons, ['Copy', 'Hide details', 'Open log folder', 'Next', 'Clear']);
});

test('main-fault-notice: the width follows the sidebar: its width minus 24, at most 420, and 320 when it is hidden', () => {
  assert.equal(M.noticeWidth(340, false), 316);
  assert.equal(M.noticeWidth(600, false), 420);
  assert.equal(M.noticeWidth(444, false), 420);
  assert.equal(M.noticeWidth(443, false), 419);
  assert.equal(M.noticeWidth(200, false), 176);
  assert.equal(M.noticeWidth(42, true), 320, 'the sidebar is hidden');
  assert.equal(M.noticeWidth(340, true), 320);
  for (const none of [NaN, 0, -5, undefined, null]) assert.equal(M.noticeWidth(none, false), 320);
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

async function bootNotice({ list = [], api, sidebarWidth = 340, collapsed = false, observer = true, inPage = null } = {}) {
  const page = {};
  const dom = { htmlWrites: 0, focusCalls: [], listened: [] };
  page.dom = dom;
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.className = '';
      this.title = '';
      this.style = {};
      this.attrs = {};
      this.parent = null;
      this.kids = [];
      this.text = '';
      this.heard = [];
      this.width = 0;
      const el = this;
      this.classList = {
        contains: (name) => el.className.split(' ').includes(name),
        add: (name) => { if (!el.classList.contains(name)) el.className = el.className ? `${el.className} ${name}` : name; },
        remove: (name) => { el.className = el.className.split(' ').filter((c) => c && c !== name).join(' '); },
      };
    }
    get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }
    set textContent(value) { this.text = String(value); for (const k of this.kids) k.parent = null; this.kids = []; }
    set innerHTML(value) { dom.htmlWrites++; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    appendChild(kid) { if (kid.parent) kid.remove(); kid.parent = this; this.kids.push(kid); return kid; }
    append(...kids) { for (const kid of kids) this.appendChild(kid); }
    remove() { if (this.parent) this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; }
    replaceChildren(...kids) { for (const k of this.kids) k.parent = null; this.kids = []; this.text = ''; this.append(...kids); }
    after(el) {
      if (el.parent) el.remove();
      this.parent.kids.splice(this.parent.kids.indexOf(this) + 1, 0, el);
      el.parent = this.parent;
    }
    insertAdjacentElement(where, el) {
      if (where === 'afterend') this.after(el);
      else if (where === 'beforeend') this.appendChild(el);
      else throw new Error('the fake page has no insertAdjacentElement ' + where);
      return el;
    }
    addEventListener(type, fn) { dom.listened.push(type); this.heard.push({ type, fn }); }
    fire(type, event) { for (const l of this.heard.slice()) if (l.type === type) l.fn(event); }
    getBoundingClientRect() { return { width: this.width, height: 0, left: 0, top: 0, right: this.width, bottom: 0 }; }
    focus() { dom.focusCalls.push(this); }
  }
  const all = (el) => [el, ...el.kids.flatMap(all)];
  const head = new El('head');
  const body = new El('body');
  const sidebar = new El('div');
  sidebar.id = 'sidebar';
  sidebar.width = sidebarWidth;
  if (collapsed) sidebar.classList.add('collapsed');
  const bar = new El('div');
  bar.id = 'status-bar';
  const info = new El('span');
  info.id = 'status-bar-info';
  info.textContent = '2 running · 5 sessions';
  bar.appendChild(info);
  body.append(sidebar, bar);
  dom.head = head;
  dom.body = body;
  const document = {
    head, body,
    createElement: (tag) => new El(tag),
    getElementById: (id) => [...all(head), ...all(body)].find((el) => el.id === id) || null,
    addEventListener: (type) => { dom.listened.push(type); },
  };

  page.calls = [];
  page.clipboard = () => Promise.resolve();
  const fake = {
    onMainFault: (cb) => { page.emit = cb; page.calls.push(['onMainFault']); },
    getMainFaults: () => { page.calls.push(['getMainFaults']); return Promise.resolve(list); },
    dismissMainFault: (id) => { page.calls.push(['dismissMainFault', id]); return Promise.resolve({ ok: true }); },
    clearMainFault: (id) => { page.calls.push(['clearMainFault', id]); return Promise.resolve({ ok: true }); },
    openMainLog: () => { page.calls.push(['openMainLog']); return Promise.resolve({ ok: true }); },
    writeClipboard: (text) => { page.calls.push(['writeClipboard', text]); return page.clipboard(); },
  };
  const given = api === null ? {} : { ...fake, ...(api || {}) };

  const timers = [];
  page.clock = {
    timers,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  };
  page.fire = (timer) => timer.fn();

  let watched = null;
  class FakeObserver {
    constructor(cb) { this.cb = cb; }
    observe(el) { watched = { cb: this.cb, el }; }
    disconnect() {}
  }
  page.resized = () => { if (watched) watched.cb([{ target: watched.el }]); };

  if (inPage && typeof inPage === 'object') {
    const text = fs.readFileSync(path.join(ROOT, 'public', 'main-fault-notice.js'), 'utf8');
    page.ctx = load(text, { file: 'public/main-fault-notice.js', globals: {
      window: { api: given }, document, setTimeout: page.clock.setTimeout, clearTimeout: page.clock.clearTimeout, ...inPage,
    } });
  } else {
    M.mount({ document, api: given, setTimeout: page.clock.setTimeout, clearTimeout: page.clock.clearTimeout,
      ResizeObserver: observer ? FakeObserver : null, titleOf: () => 'Fix the login' });
  }
  page.notice = document.getElementById('main-fault-notice');
  page.chip = document.getElementById('status-bar-notices');
  page.sidebar = sidebar;
  page.info = info;

  page.shown = () => {
    if (!page.notice || page.notice.style.display === 'none') return null;
    const find = (className) => all(page.notice).filter((el) => el.classList.contains(className));
    const [heading] = find('mfn-heading');
    const [more] = find('mfn-more');
    const [details] = find('mfn-details');
    const [actions] = find('mfn-actions');
    return {
      heading: heading ? heading.textContent : null,
      lines: find('mfn-line').map((el) => el.textContent),
      more: more ? more.textContent : '',
      details: details ? details.textContent : null,
      buttons: actions ? all(actions).filter((el) => el.tagName === 'BUTTON').map((el) => el.textContent) : [],
    };
  };
  const press = (target, alsoDown) => {
    const down = { prevented: 0, preventDefault() { this.prevented++; } };
    target.fire('mousedown', down);
    if (alsoDown) alsoDown.fire('mousedown', down);
    target.fire('click', { type: 'click', target, preventDefault() {} });
    return target;
  };
  page.click = (label) => {
    const hits = all(page.notice).filter((el) => el.tagName === 'BUTTON' && el.textContent === label);
    assert.equal(hits.length, 1, `one button "${label}" in the notice`);
    return press(hits[0], page.notice);
  };
  page.clickChip = () => press(page.chip, null);

  await settled();
  return page;
}

test('main-fault-notice: on the page: the list is asked at load and drawn as text; an older main process or preload draws nothing and throws nothing', async () => {
  const EVIL = '<img src=x onerror=alert(1)>';
  const page = await bootNotice({ list: [rec({ firstLine: EVIL })] });
  assert.deepEqual(page.calls, [['onMainFault'], ['getMainFaults']], 'it listens before it asks');
  assert.deepEqual(page.shown(), { heading: 'Switchboard hit an internal error', lines: [EVIL], more: '', details: null, buttons: B3 });
  assert.equal(page.dom.htmlWrites, 0);
  assert.equal(page.notice.id, 'main-fault-notice');
  assert.equal(page.notice.parent, page.dom.body);
  assert.equal(page.notice.style.width, '316px');
  assert.equal(page.chip.id, 'status-bar-notices');
  assert.equal(page.info.parent.kids[page.info.parent.kids.indexOf(page.info) + 1], page.chip, 'directly after the info text');
  assert.equal(page.chip.style.display, 'none');
  assert.equal(page.info.textContent, '2 running \u00b7 5 sessions', 'the info text is not touched');
  assert.equal(page.dom.head.kids.length, 1);
  assert.equal(page.dom.head.kids[0].textContent, M.NOTICE_STYLES);

  const old = await bootNotice({ api: { getMainFaults: () => Promise.reject(new Error("No handler registered for 'get-main-faults'")) } });
  assert.equal(old.shown(), null);
  assert.equal(old.chip.style.display, 'none');
  const thrower = await bootNotice({ api: { getMainFaults: () => { throw new Error('boom'); } } });
  assert.equal(thrower.shown(), null);
  const bare = await bootNotice({ api: null });
  assert.equal(bare.shown(), null);
  // A list answer that is no list, a list with entries that are no records, and events that are no records.
  for (const answer of [undefined, null, {}, 'text', 5, [null, {}, { id: '' }, { id: 7 }, 'text']]) {
    const odd = await bootNotice({ api: { getMainFaults: async () => answer } });
    assert.equal(odd.shown(), null, JSON.stringify(answer));
    assert.equal(odd.chip.style.display, 'none');
    assert.doesNotThrow(() => { for (const event of [null, undefined, {}, 'text', 5, { id: '' }, { cleared: true }]) odd.emit(event); });
    assert.equal(odd.shown(), null);
    // The page still works afterwards.
    odd.emit(rec({ id: 'real' }));
    assert.equal(odd.shown().heading, 'Switchboard hit an internal error');
  }

  // The start after a run that did not close normally and recorded two errors.
  const start = await bootNotice({ list: [
    rec({ id: 'lr', kind: 'last-run', firstLine: '', stack: '', runErrors: 2, firstAt: 5000 }),
    rec({ id: 'p1', previousRun: true, dismissed: true, firstAt: 900 }),
    rec({ id: 'p2', previousRun: true, dismissed: true, firstAt: 800 }) ] });
  assert.deepEqual(start.shown(), { heading: 'Switchboard did not close normally last time',
    lines: ['It crashed or was ended from outside (Task Manager, or Windows shutting down).', '2 errors were recorded in that run.'],
    more: '', details: null, buttons: ['Open log folder', 'Dismiss'] });
  assert.equal(start.chip.textContent, '2 notices \u00b7 last run');
  assert.equal(start.chip.title, 'Notices you dismissed. Click to show them.');
  assert.equal(start.chip.style.display, '');
});

test('main-fault-notice: on the page: no click takes the keyboard: the panel and the chip prevent mousedown, every button has tabindex -1, nothing is focused and no key listener is added', async () => {
  const page = await bootNotice({ list: [rec({ id: 'a' }), rec({ id: 'b', firstAt: 2000, dismissed: true }), rec({ id: 'c', firstAt: 500, dismissed: true })] });
  const down = { prevented: 0, preventDefault() { this.prevented++; } };
  page.notice.fire('mousedown', down);
  assert.equal(down.prevented, 1, 'a press anywhere on the panel, text included');
  page.chip.fire('mousedown', down);
  assert.equal(down.prevented, 2, 'and on the chip');
  const seen = new Set();
  const look = () => { for (const b of page.notice.kids.flatMap(function walk(el) { return [el, ...el.kids.flatMap(walk)]; }).filter((el) => el.tagName === 'BUTTON')) { seen.add(b.textContent); assert.equal(b.attrs.tabindex, '-1', b.textContent); } };
  look(); page.click('Show details'); look();
  // The details box scrolls and holds nothing that takes the keyboard: Tab must not stop on it either.
  const box = page.notice.kids.flatMap(function walk(el) { return [el, ...el.kids.flatMap(walk)]; }).filter((el) => el.className === 'mfn-details');
  assert.deepEqual(box.map((el) => el.attrs.tabindex), ['-1']);
  page.click('Copy'); await settled(); look(); page.click('Hide details'); look();
  page.clickChip(); look(); page.click('Next'); look(); page.click('Clear'); look(); page.clickChip(); page.click('Dismiss'); look();
  assert.deepEqual([...seen].sort(), ['Clear', 'Copied', 'Copy', 'Dismiss', 'Hide details', 'Next', 'Open log folder', 'Show details']);
  assert.deepEqual(page.dom.focusCalls, []);
  assert.deepEqual([...new Set(page.dom.listened)].sort(), ['click', 'mousedown']);
  const classNames = [page.notice, page.chip, ...page.notice.kids].map((el) => el.className).join(' ');
  assert.ok(!classNames.includes('app-dialog-overlay'));
});

test("main-fault-notice: on the page: Dismiss and Open log folder call main, and the notice follows main's list", async () => {
  const a = rec({ id: 'a', firstAt: 1000, firstLine: 'Error: a' });
  const b = rec({ id: 'b', firstAt: 2000, firstLine: 'Error: b' });
  const page = await bootNotice({ list: [a, b] });
  assert.deepEqual([page.shown().lines[0], page.shown().more], ['Error: b', '+1 more']);
  page.calls.length = 0;
  page.click('Dismiss');
  assert.deepEqual(page.calls, [['dismissMainFault', 'b']]);
  assert.equal(page.shown().lines[0], 'Error: b', 'nothing changes until main says so');
  page.emit({ ...b, dismissed: true });
  assert.deepEqual([page.shown().lines[0], page.shown().more], ['Error: a', '']);
  assert.deepEqual([page.chip.textContent, page.chip.style.display], ['1 notice', '']);
  page.click('Open log folder');
  assert.deepEqual(page.calls.at(-1), ['openMainLog']);
  // Main opens b again (its once-a-minute rule), with its count.
  page.emit({ ...b, dismissed: false, count: 7 });
  assert.deepEqual(page.shown().lines, ['Error: b', 'Happened 7 times']);
  assert.equal(page.chip.style.display, 'none');
  // A dismiss in another window.
  page.emit({ ...b, dismissed: true, count: 7 });
  page.emit({ ...a, dismissed: true });
  assert.equal(page.shown(), null);
  assert.equal(page.chip.textContent, '2 notices');
  // Calls that reject or do not exist are swallowed.
  const broken = await bootNotice({ list: [a], api: { dismissMainFault: () => Promise.reject(new Error('gone')), openMainLog: undefined } });
  assert.doesNotThrow(() => { broken.click('Dismiss'); broken.click('Open log folder'); });
  await settled();
  assert.equal(broken.shown().lines[0], 'Error: a');
});

test('main-fault-notice: on the page: the chip opens the newest dismissed notice, Next goes on, Clear takes one off in every window, and a second click closes it', async () => {
  const a = rec({ id: 'a', firstAt: 1000, firstLine: 'Error: a', dismissed: true });
  const b = rec({ id: 'b', firstAt: 2000, firstLine: 'Error: b', dismissed: true });
  const page = await bootNotice({ list: [a, b] });
  assert.equal(page.shown(), null);
  assert.equal(page.chip.textContent, '2 notices');
  page.clickChip();
  assert.deepEqual([page.shown().lines[0], page.shown().buttons], ['Error: b', ['Show details', 'Open log folder', 'Next', 'Clear']]);
  page.click('Next');
  assert.equal(page.shown().lines[0], 'Error: a');
  page.click('Next');
  assert.equal(page.shown().lines[0], 'Error: b');
  page.calls.length = 0;
  page.click('Clear');
  assert.deepEqual(page.calls, [['clearMainFault', 'b']]);
  assert.equal(page.shown().lines[0], 'Error: b', 'until main says so');
  page.emit({ ...b, cleared: true });
  assert.deepEqual([page.shown().lines[0], page.shown().buttons], ['Error: a', ['Show details', 'Open log folder', 'Clear']]);
  assert.equal(page.chip.textContent, '1 notice');
  page.clickChip();
  assert.equal(page.shown(), null, 'a second click closes it');
  assert.equal(page.chip.textContent, '1 notice');
  page.clickChip();
  page.emit({ ...a, cleared: true });           // cleared from another window
  assert.equal(page.shown(), null);
  assert.deepEqual([page.chip.textContent, page.chip.style.display], ['', 'none']);
  // The chip closed itself when it emptied: a notice dismissed later does not pop open.
  page.emit(rec({ id: 'z', firstAt: 9000, dismissed: true }));
  assert.equal(page.shown(), null);
  // News closes the chip: a new open notice shows, not the old ones.
  page.clickChip();
  assert.equal(page.shown().buttons.at(-1), 'Clear');
  page.emit(rec({ id: 'news', firstAt: 9500, firstLine: 'Error: news' }));
  assert.deepEqual([page.shown().lines[0], page.shown().buttons], ['Error: news', B3]);
  // A rising count of a notice that is already open does not close the chip.
  page.clickChip();
  page.emit(rec({ id: 'news', firstAt: 9500, firstLine: 'Error: news', count: 2 }));
  assert.equal(page.shown().buttons.at(-1), 'Clear');
});

test('main-fault-notice: on the page: "Copied" shows only after the clipboard call answered, "Not copied" when it failed, each for 2 seconds', async () => {
  const page = await bootNotice({ list: [rec()] });
  page.click('Show details');
  assert.equal(page.shown().details, rec().stack);
  assert.deepEqual(page.shown().buttons, ['Copy', 'Hide details', 'Open log folder', 'Dismiss']);
  let gate;
  page.clipboard = () => new Promise((resolve, reject) => { gate = { resolve, reject }; });
  page.click('Copy');
  assert.deepEqual(page.calls.at(-1), ['writeClipboard', rec().stack]);
  assert.equal(page.shown().buttons[0], 'Copy', 'not before the clipboard call answered');
  assert.equal(page.clock.timers.length, 0);
  gate.resolve();
  await settled();
  assert.equal(page.shown().buttons[0], 'Copied');
  assert.deepEqual(page.clock.timers.map((t) => t.ms), [2000]);
  page.fire(page.clock.timers[0]);
  assert.equal(page.shown().buttons[0], 'Copy');
  page.click('Copy');
  gate.reject(new Error('no clipboard'));
  await settled();
  assert.equal(page.shown().buttons[0], 'Not copied');
  assert.equal(page.clock.timers.at(-1).ms, 2000);
  page.fire(page.clock.timers.at(-1));
  assert.equal(page.shown().buttons[0], 'Copy');
  // Hide details takes the label back at once.
  page.clipboard = () => Promise.resolve();
  page.click('Copy');
  await settled();
  page.click('Hide details');
  assert.deepEqual([page.shown().details, page.shown().buttons[0]], [null, 'Show details']);
  page.click('Show details');
  assert.equal(page.shown().buttons[0], 'Copy');
  // An answer that comes after Hide details is dropped: the details that are opened again were not copied by it.
  const armedBefore = page.clock.timers.filter((t) => !t.cleared).length;
  page.clipboard = () => new Promise((resolve, reject) => { gate = { resolve, reject }; });
  page.click('Copy');
  page.click('Hide details');
  page.click('Show details');
  gate.resolve();
  await settled();
  assert.equal(page.shown().buttons[0], 'Copy');
  assert.equal(page.clock.timers.filter((t) => !t.cleared).length, armedBefore, 'a dropped answer arms no timer');
  // An answer that comes after another notice took the corner is dropped too.
  const a = rec({ id: 'a', firstAt: 2000 });
  const b = rec({ id: 'b', firstAt: 1000, firstLine: 'Error: b', stack: 'Error: b\n    at y' });
  const two = await bootNotice({ list: [a, b] });
  let hold;
  two.clipboard = () => new Promise((resolve) => { hold = resolve; });
  two.click('Show details');
  two.click('Copy');
  two.emit({ ...a, dismissed: true });            // dismissed in another window: b shows
  hold();
  await settled();
  two.click('Show details');
  assert.deepEqual([two.shown().details, two.shown().buttons[0]], ['Error: b\n    at y', 'Copy']);
  // Two clicks on the copy button leave one timer armed, and only the later click's answer counts.
  const twice = await bootNotice({ list: [rec()] });
  const answers = [];
  twice.clipboard = () => new Promise((resolve, reject) => { answers.push({ resolve, reject }); });
  twice.click('Show details');
  twice.click('Copy');
  twice.click('Copy');
  answers[0].resolve();
  await settled();
  assert.equal(twice.shown().buttons[0], 'Copy', 'the first click was overtaken by the second: its answer is dropped');
  answers[1].reject(new Error('no clipboard'));
  await settled();
  assert.equal(twice.shown().buttons[0], 'Not copied');
  twice.clipboard = () => Promise.resolve();
  twice.click('Not copied');                      // the same button, whatever it reads
  await settled();
  assert.equal(twice.shown().buttons[0], 'Copied');
  assert.deepEqual(twice.clock.timers.filter((t) => !t.cleared).map((t) => t.ms), [2000], 'the timer of the click before was cleared');
  // An older preload has no clipboard call.
  const bare = await bootNotice({ list: [rec()], api: { writeClipboard: undefined } });
  bare.click('Show details');
  bare.click('Copy');
  await settled();
  assert.equal(bare.shown().buttons[0], 'Not copied');
});

test('main-fault-notice: on the page: a fault that arrives before the list was answered is kept, and a cleared one does not come back', async () => {
  let answer;
  const page = await bootNotice({ api: { getMainFaults: () => new Promise((resolve) => { answer = resolve; }) } });
  page.emit(rec({ id: 'new', firstAt: 5000, firstLine: 'Error: new', count: 4 }));
  assert.deepEqual(page.shown().lines, ['Error: new', 'Happened 4 times']);
  page.emit(rec({ id: 'gone', dismissed: true, cleared: true }));
  answer([rec({ id: 'new', firstAt: 5000, firstLine: 'Error: new', count: 1 }), rec({ id: 'old', firstAt: 100, firstLine: 'Error: old' }), rec({ id: 'gone', dismissed: true })]);
  await settled();
  assert.deepEqual(page.shown().lines, ['Error: new', 'Happened 4 times'], "the event's copy is the newer one");
  assert.equal(page.shown().more, '+1 more', 'the list added the one the page had not heard of');
  assert.equal(page.chip.style.display, 'none', 'the cleared one did not come back');
  // Nor does an event bring it back that carries no cleared mark (a count that was on its way when it was cleared).
  page.emit(rec({ id: 'gone', dismissed: true, count: 9 }));
  page.emit(rec({ id: 'gone', count: 10 }));
  assert.equal(page.chip.style.display, 'none');
  assert.equal(page.shown().more, '+1 more', 'still the two the page knew');
});

test('main-fault-notice: on the page: a count that rises while the details are open keeps them open', async () => {
  const page = await bootNotice({ list: [rec()] });
  page.click('Show details');
  page.emit(rec({ count: 2, lastAt: 2000 }));
  assert.equal(page.shown().details, rec().stack);
  assert.deepEqual(page.shown().lines, ['TypeError: x is not a function', 'Happened 2 times']);
  assert.equal(page.shown().buttons[0], 'Copy');
});

test("main-fault-notice: in a page the script starts by itself and takes the row title from the page's own names, each behind typeof", async () => {
  const pty = rec({ kind: 'pty', sessionId: SID, firstLine: 'Error: read EIO' });
  const withRows = await bootNotice({ list: [pty], inPage: { sessionMap: new Map([[SID, { name: null, aiTitle: 'Fix the login', summary: 's' }]]), cleanDisplayName: (s) => s.trim() } });
  assert.equal(typeof withRows.ctx.window.MainFaultNotice.mount, 'function');
  assert.deepEqual(withRows.shown().lines, ['Fix the login: Error: read EIO']);
  assert.equal(withRows.notice.style.width, '316px', 'no ResizeObserver in this page: sized at the draw');
  // Before app.js has run there is no session map and no cleaner: the id's first 8 characters.
  const early = await bootNotice({ list: [pty], inPage: {} });
  assert.deepEqual(early.shown().lines, ['11111111: Error: read EIO']);
  // The rows are read at each draw, not once at load.
  early.ctx.sessionMap = new Map([[SID, { name: 'Typed name' }]]);
  early.emit({ ...pty, count: 2 });
  assert.deepEqual(early.shown().lines, ['Typed name: Error: read EIO']);
});

test("main-fault-notice: in a page: a session notice drawn before the rows have loaded shows the row's title after redraw(), with its details still open; redraw() before any mount does nothing", async () => {
  const failed = rec({ kind: 'stop-failed', sessionId: SID, firstLine: 'Error: kill EPERM' });
  const page = await bootNotice({ list: [failed], inPage: {} });
  assert.equal(typeof page.ctx.window.MainFaultNotice.redraw, 'function');
  const early = '11111111 could not be stopped: Error: kill EPERM. It is still open and takes no typing. Press Stop again to try once more.';
  assert.deepEqual(page.shown().lines, [early], 'the list was answered before app.js had loaded any row');
  page.click('Show details');
  // app.js loads the rows. Nothing draws by itself: no event came and nothing was clicked.
  page.ctx.sessionMap = new Map([[SID, { name: null, aiTitle: 'Fix the login', summary: 's' }]]);
  page.ctx.cleanDisplayName = (s) => s.trim();
  assert.deepEqual(page.shown().lines, [early]);
  const asked = page.calls.length;
  assert.equal(page.ctx.window.MainFaultNotice.redraw(), undefined);
  assert.deepEqual(page.shown().lines, ['Fix the login could not be stopped: Error: kill EPERM. It is still open and takes no typing. Press Stop again to try once more.']);
  assert.equal(page.shown().details, failed.stack, 'the same notice, drawn once more: what was open stays open');
  assert.equal(page.calls.length, asked, 'a redraw asks main nothing');
  // A row that is gone again by the next redraw: the id's first 8 characters again, and nothing thrown.
  page.ctx.sessionMap = { get() { throw new Error('boom'); } };
  assert.doesNotThrow(() => page.ctx.window.MainFaultNotice.redraw());
  assert.deepEqual(page.shown().lines, [early]);
  // Before any mount (a page with no document, or plain Node) redraw does nothing and throws nothing.
  const text = fs.readFileSync(path.join(ROOT, 'public', 'main-fault-notice.js'), 'utf8');
  const bare = load(text, { file: 'public/main-fault-notice.js', globals: { window: {} } });
  assert.equal(bare.window.MainFaultNotice.redraw(), undefined);
});

test('main-fault-notice: on the page: the width follows the sidebar when it is dragged or hidden', async () => {
  const page = await bootNotice({ list: [rec()] });
  assert.equal(page.notice.style.width, '316px');
  page.sidebar.width = 600; page.resized();
  assert.equal(page.notice.style.width, '420px');
  page.sidebar.classList.add('collapsed'); page.sidebar.width = 42; page.resized();
  assert.equal(page.notice.style.width, '320px');
  // A page without the observer still sizes at every draw.
  const plain = await bootNotice({ list: [rec()], observer: false, sidebarWidth: 200 });
  assert.equal(plain.notice.style.width, '176px');
  plain.sidebar.width = 300;
  plain.emit(rec({ count: 2 }));
  assert.equal(plain.notice.style.width, '276px');
});

test('main-fault-notice: source scan: no .focus(, no keydown or keypress listener, every button tabindex -1 with a mousedown preventDefault', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'main-fault-notice.js'), 'utf8');
  assert.ok(!src.includes('.focus('));
  assert.ok(!/key(down|press|up)/i.test(src));
  assert.ok(!src.includes('app-dialog-overlay'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.equal(src.split("createElement('button')").length - 1, 1, 'one helper makes every button');
  assert.equal(src.split("setAttribute('tabindex', '-1')").length - 1, 1, 'and gives it tabindex -1');
  assert.equal(src.split("addEventListener('mousedown'").length - 1, 2, 'the panel and the chip');
  assert.ok(src.split('preventDefault()').length - 1 >= 1);
  assert.deepEqual([...new Set([...src.matchAll(/addEventListener\('([a-z]+)'/g)].map((m) => m[1]))].sort(), ['click', 'mousedown']);
});

test("main-fault-notice: the notice's layer is below the in-page box layer, and its look is the diagnostics toast's with an amber left edge", () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const box = /\.add-project-overlay\.app-dialog-overlay\s*\{\s*z-index:\s*(\d+);\s*\}/.exec(css);
  assert.ok(box, 'style.css no longer has the in-page box layer');
  assert.equal(M.NOTICE_LAYER, 98000);
  assert.ok(M.NOTICE_LAYER < Number(box[1]), 'the notice must stay under the in-page box');
  const rule = (selector) => {
    const at = M.NOTICE_STYLES.indexOf(selector + ' {');
    assert.notEqual(at, -1, 'no rule ' + selector);
    return M.NOTICE_STYLES.slice(at, M.NOTICE_STYLES.indexOf('}', at));
  };
  const panel = rule('#main-fault-notice');
  for (const part of ['position: fixed', 'left: 12px', 'bottom: 32px', 'z-index: 98000', 'box-sizing: border-box',
    'color: #e8e8ea', 'background: #22232a', 'border: 1px solid rgba(255,255,255,0.14)', 'border-left: 3px solid #ffd166',
    'border-radius: 8px']) assert.ok(panel.includes(part), part);
  const button = rule('#main-fault-notice button');
  for (const part of ['color: #e8e8ea', 'background: #32343d', 'border: 1px solid rgba(255,255,255,0.14)', 'border-radius: 5px']) assert.ok(button.includes(part), part);
  const details = rule('#main-fault-notice .mfn-details');
  for (const part of ['max-height: 40vh', 'overflow: auto', 'font-family: monospace', 'white-space: pre-wrap']) assert.ok(details.includes(part), part);
  // A first line with no space to break at (a Windows path, up to 300 characters) or a long row title must wrap inside
  // the notice, which is never wider than the sidebar: the toast's own break rule (public/terminal-diagnostics.js:477).
  assert.ok(rule('#main-fault-notice .mfn-line').includes('word-break: break-all'), 'a long line must not run out over the terminal');
  const chip = rule('#status-bar-notices');
  for (const part of ['color: #ffd166', 'border: 1px solid rgba(255,209,102,0.6)', 'background: rgba(255,209,102,0.14)']) assert.ok(chip.includes(part), part);
  assert.ok(!M.NOTICE_STYLES.includes('text-transform'), 'the chip is in normal case');
  assert.ok(!M.NOTICE_STYLES.includes('right:'), 'bottom-left only: the diagnostics toast keeps bottom-right');
});

test('main-fault-notice: index.html loads main-fault-notice.js once, directly below terminal-diagnostics.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal(html.split('<script src="main-fault-notice.js"></script>').length - 1, 1);
  assert.match(html, /<script src="terminal-diagnostics\.js"><\/script>\r?\n\s*<script src="main-fault-notice\.js"><\/script>\r?\n\s*<script src="terminal-manager\.js"><\/script>/);
});
