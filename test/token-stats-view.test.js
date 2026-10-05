const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

// The Tokens sub-tab of the Stats view. Two halves, as test/ctx-handoff.test.js
// does it: the pure helpers are required under plain Node (the module must load
// with no window and no document), and the real public/stats-view.js and
// public/token-stats-view.js are then run together in a vm context with a fake
// DOM and a stubbed window.api, to pin the dispatcher, every state of design
// 6.3 and the render-generation guard. No database, no transcripts, no app.

const VIEW_PATH = path.join(__dirname, '..', 'public', 'token-stats-view.js');
const STATS_PATH = path.join(__dirname, '..', 'public', 'stats-view.js');
const VIEW_SOURCE = fs.readFileSync(VIEW_PATH, 'utf8');
const STATS_SOURCE = fs.readFileSync(STATS_PATH, 'utf8');

const view = require(VIEW_PATH);
const { formatTokens, tokOutcome, tokRangeFor, tokDayKey, tokParseDay, tokDayLabel,
  tokNearestIndex, tokStepPath, tokBucketDays, tokYTicks, TOK_NEEDS_RESTART, TOK_ALL_FROM } = view;

const ARROW = '\u2192';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

// ── pure helpers ────────────────────────────────────────────────────────────

test('the module loads under plain Node with no window or document', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof formatTokens, 'function');
});

test('formatTokens: integer below 1,000, then one decimal with K / M / B, ".0" dropped', () => {
  const cases = [
    [0, '0'], [1, '1'], [999, '999'], [1000, '1K'], [1049, '1K'], [1050, '1.1K'], [1500, '1.5K'],
    [412345, '412.3K'], [999949, '999.9K'], [999950, '1M'], [1000000, '1M'], [2500000, '2.5M'],
    [999950000, '1B'], [1234567890, '1.2B'], [5e12, '5000B'],
  ];
  for (const [n, want] of cases) assert.equal(formatTokens(n), want, String(n));
  for (const bad of [null, undefined, NaN, -5, 'x', Infinity]) assert.equal(formatTokens(bad), '0', String(bad));
});

test('tokOutcome: rejected, { error }, disabled and ok are four different things', () => {
  assert.deepEqual(tokOutcome({ status: 'rejected', reason: new Error("No handler registered for 'token-stats-summary'") }),
    { kind: 'restart', text: 'Token analytics needs a Switchboard restart to start working.' });
  assert.equal(TOK_NEEDS_RESTART, 'Token analytics needs a Switchboard restart to start working.');

  const err = tokOutcome({ status: 'fulfilled', value: { error: 'bad request: from' } });
  assert.equal(err.kind, 'error');
  assert.equal(err.text, 'Token analytics unavailable: bad request: from.');
  // The store's own prefix and a trailing full stop are not repeated.
  assert.equal(tokOutcome({ status: 'fulfilled', value: { error: 'Token store unavailable: disk is full.' } }).text,
    'Token analytics unavailable: disk is full.');
  assert.equal(tokOutcome({ status: 'fulfilled', value: null }).kind, 'error');

  const off = tokOutcome({ status: 'fulfilled', value: { scan: { state: 'disabled', reason: 'disabled by token-usage.off' } } });
  assert.equal(off.kind, 'disabled');
  assert.equal(off.killSwitch, true);
  assert.equal(off.text, 'Token analytics is off: disabled by token-usage.off.');
  // The same state when only the error string came back.
  const off2 = tokOutcome({ status: 'fulfilled', value: { error: 'Token store unavailable: disabled by token-usage.off' } });
  assert.equal(off2.kind, 'disabled');
  assert.equal(off2.killSwitch, true);
  const broken = tokOutcome({ status: 'fulfilled', value: { error: 'x', scan: { state: 'disabled', reason: 'database is corrupt' } } });
  assert.equal(broken.kind, 'disabled');
  assert.equal(broken.killSwitch, false);

  const ok = tokOutcome({ status: 'fulfilled', value: { totals: {}, scan: { state: 'ok' } } });
  assert.equal(ok.kind, 'ok');
});

test('day strings are local days and are built without toISOString', () => {
  // No call in the code at all (comments may mention it).
  const code = VIEW_SOURCE.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.equal(/toISOString/.test(code), false, 'token-stats-view.js must not call toISOString');
  assert.equal(/toLocale/.test(code), false, 'no locale-dependent formatting either');

  // And none reached at run time: poison it and run every day helper.
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = () => { throw new Error('toISOString was called'); };
  try {
    const lateEvening = new Date(2026, 9, 3, 23, 30);   // local Oct 3, 23:30
    const earlyMorning = new Date(2026, 9, 3, 0, 15);   // local Oct 3, 00:15
    for (const now of [lateEvening, earlyMorning]) {
      assert.equal(tokDayKey(now), '2026-10-03');
      assert.deepEqual(tokRangeFor('30d', now), { from: '2026-09-04', to: '2026-10-03' });
      assert.deepEqual(tokRangeFor('7d', now), { from: '2026-09-27', to: '2026-10-03' });
      assert.deepEqual(tokRangeFor('90d', now), { from: '2026-07-06', to: '2026-10-03' });
      assert.deepEqual(tokRangeFor('all', now), { from: TOK_ALL_FROM, to: '2026-10-03' });
      // An unknown key is the default range.
      assert.deepEqual(tokRangeFor('nonsense', now), tokRangeFor('30d', now));
    }
    assert.equal(tokDayLabel('2026-10-03'), 'Oct 3');
    assert.equal(tokDayLabel('2026-01-31'), 'Jan 31');
    assert.equal(tokDayLabel('not a day'), '');
    const parsed = tokParseDay('2026-03-01');
    assert.deepEqual([parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours()], [2026, 2, 1, 0]);
    assert.equal(tokParseDay('2026-02-31'), null);
    assert.equal(tokParseDay('2026-2-3'), null);
  } finally {
    Date.prototype.toISOString = real;
  }
});

test('custom range: both days must be real; a reversed pair is swapped', () => {
  const now = new Date(2026, 9, 3, 12, 0);
  assert.equal(tokRangeFor('custom', now, '', '2026-10-01'), null);
  assert.equal(tokRangeFor('custom', now, '2026-02-30', '2026-10-01'), null);
  assert.deepEqual(tokRangeFor('custom', now, '2026-09-01', '2026-09-15'), { from: '2026-09-01', to: '2026-09-15' });
  assert.deepEqual(tokRangeFor('custom', now, '2026-09-15', '2026-09-01'), { from: '2026-09-01', to: '2026-09-15' });
});

test('the local day is right in zones on both sides of UTC (child processes, TZ in env)', () => {
  // 2026-10-03T06:30Z is still Oct 2 in Los Angeles; 2026-10-03T12:30Z is
  // already Oct 4 in Auckland. toISOString would say Oct 3 in both.
  const script = `
    const v = require(${JSON.stringify(VIEW_PATH)});
    const now = new Date(process.argv[1]);
    process.stdout.write(JSON.stringify({ key: v.tokDayKey(now), range: v.tokRangeFor('7d', now), offset: now.getTimezoneOffset() }));
  `;
  const run = (TZ, iso) => {
    const res = spawnSync(process.execPath, ['-e', script, iso], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const la = run('America/Los_Angeles', '2026-10-03T06:30:00Z');
  const nz = run('Pacific/Auckland', '2026-10-03T12:30:00Z');
  // Only meaningful when the child really took the zone; say so if it did not.
  if (la.offset !== 420 || nz.offset !== -780) {
    assert.fail(`TZ was not applied to the child (offsets ${la.offset}, ${nz.offset})`);
  }
  assert.equal(la.key, '2026-10-02');
  assert.deepEqual(la.range, { from: '2026-09-26', to: '2026-10-02' });
  assert.equal(nz.key, '2026-10-04');
  assert.deepEqual(nz.range, { from: '2026-09-28', to: '2026-10-04' });
});

test('chart helpers: nearest point, step path, buckets, y ticks', () => {
  const pts = [{ t: 10, ctx: 1 }, { t: 20, ctx: 2 }, { t: 40, ctx: 3 }];
  assert.equal(tokNearestIndex([], 5), -1);
  assert.equal(tokNearestIndex(pts, -100), 0);
  assert.equal(tokNearestIndex(pts, 14), 0);
  assert.equal(tokNearestIndex(pts, 16), 1);
  assert.equal(tokNearestIndex(pts, 31), 2);
  assert.equal(tokNearestIndex(pts, 999), 2);
  // Horizontal to the next time, then vertical: a step, never a diagonal.
  assert.equal(tokStepPath(pts, t => t, v => v * 10), 'M10.0 10.0H20.0V20.0H40.0V30.0');

  const day = (d, w, slugs) => ({ day: d, total: { input: 1, output: 1, cache_write: 1, cache_read: 1, weighted: w }, bySlug: slugs });
  const days = [day('2026-10-01', 0, {}), day('2026-10-02', 5, { a: { weighted: 5 } }), day('2026-10-03', 7, { a: { weighted: 3 }, b: { weighted: 4 } })];
  assert.equal(tokBucketDays(days, 'weighted', 120, false).length, 3);
  assert.equal(tokBucketDays(days, 'weighted', 120, true).length, 2);       // the empty leading day is dropped
  assert.equal(tokBucketDays(days, 'raw', 120, true).length, 3);            // raw has tokens on day one
  const merged = tokBucketDays(days, 'weighted', 1, false);
  assert.deepEqual(merged, [{ from: '2026-10-01', to: '2026-10-03', total: 12, bySlug: { a: 8, b: 4 } }]);

  assert.deepEqual(tokYTicks(1000000), [0, 200000, 400000, 600000, 800000, 1000000]);
  assert.ok(tokYTicks(5000000).length <= 7);
});

// ── fake DOM ────────────────────────────────────────────────────────────────

// Objects made inside the vm context have that realm's Object.prototype, which
// deepStrictEqual treats as a different type; compare their plain copies.
const plain = (o) => JSON.parse(JSON.stringify(o));

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

function makeDom() {
  const byId = {};
  const htmlWrites = [];
  class El {
    constructor(tag) {
      this.tagName = String(tag).toLowerCase();
      this.children = [];
      this.parent = null;
      this.own = '';
      this.attrs = {};
      this.style = {};
      this.dataset = {};
      this.listeners = {};
      this.className = '';
      this.mutations = 0;     // every change in this element's subtree
      const self = this;
      this.classList = {
        contains: (c) => self.className.split(/\s+/).includes(c),
        add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
        remove: (c) => { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
        toggle: (c, force) => {
          const want = force === undefined ? !self.classList.contains(c) : !!force;
          if (want) self.classList.add(c); else self.classList.remove(c);
        },
      };
    }
    bump() { for (let n = this; n; n = n.parent) n.mutations++; }
    set id(v) { this.attrs.id = v; byId[v] = this; }
    get id() { return this.attrs.id || ''; }
    appendChild(child) {
      if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
      child.parent = this;
      this.children.push(child);
      this.bump();
      return child;
    }
    insertBefore(child, ref) {
      child.parent = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, child);
      this.bump();
      return child;
    }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent.bump(); this.parent = null; } }
    get firstChild() { return this.children[0] || null; }
    set textContent(v) { this.children = []; this.own = String(v); this.bump(); }
    get textContent() { return this.own + this.children.map(c => c.textContent).join(''); }
    set innerHTML(v) { this.children = []; this.own = String(v); htmlWrites.push(this); this.bump(); }
    get innerHTML() { return this.own; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); this.bump(); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, ev) { for (const fn of this.listeners[type] || []) fn(ev || {}); }
    querySelector(sel) { return findAll(this, n => n !== this && n.classList.contains(sel.replace(/^\./, '')))[0] || null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 260 }; }
    scrollIntoView() {}
  }
  const make = (tag, id) => { const el = new El(tag); if (id) el.id = id; return el; };
  const document = {
    body: make('body'),
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    querySelectorAll: (sel) => (sel.includes('.stats-subtab') ? subtabs : []),
  };
  const viewer = make('div', 'stats-viewer');
  const header = make('div', 'stats-viewer-header');
  const subtabs = ['activity', 'tokens'].map((name) => {
    const b = new El('button');
    b.className = 'stats-subtab' + (name === 'activity' ? ' active' : '');
    b.dataset.subtab = name;
    header.appendChild(b);
    return b;
  });
  const activityBody = make('div', 'stats-viewer-body');
  const tokensBody = make('div', 'stats-tokens-body');
  tokensBody.style.display = 'none';
  viewer.appendChild(header);
  viewer.appendChild(activityBody);
  viewer.appendChild(tokensBody);
  return { document, viewer, subtabs, activityBody, tokensBody, htmlWrites };
}

function findAll(root, pred, out = []) {
  if (pred(root)) out.push(root);
  for (const c of root.children) findAll(c, pred, out);
  return out;
}
const byClass = (root, cls) => findAll(root, n => n.classList.contains(cls));
const byTag = (root, tag) => findAll(root, n => n.tagName === tag);
const button = (root, label) => byTag(root, 'button').find(b => b.textContent.startsWith(label));

// ── fixtures (the response shapes of design section 4) ──────────────────────

const counters = (o = {}) => ({ input: 100, output: 200, cache_write: 300, cache_write_5m: 100, cache_write_1h: 200, cache_read: 9400, ...o });
const SCAN = { state: 'ok', reason: null, phase: 'idle', done: 3017, total: 3017, backfillDone: '2026-10-03T12:00:00Z',
  lastScanMs: new Date(2026, 9, 3, 14, 2).getTime(), lastCatchupMs: 0, filesWithErrors: 0, filesMissing: 0,
  linesSkipped: 0, parseVersion: 1, pricesVersion: '2026-09-25' };

function okData(over = {}) {
  const range = { from: '2026-10-02', to: '2026-10-03' };
  const scan = { ...SCAN, ...(over.scan || {}) };
  const title = over.title || 'Fix the <img src=x onerror=alert(1)> bug';
  return {
    summary: { range, scan, totals: counters({ responses: 1234, unfinalized: 2 }),
      byKind: { main: counters(), subagent: counters(), workflow: counters() },
      weighted: { tokens: over.weighted || 2500000, usd: 12.5, unpricedModels: [], pricesVersion: '2026-09-25' } },
    models: { range, scan, models: [
      { model: 'claude-opus-5-5', label: 'Opus 5.5', ...counters(), thinking: 0, responses: 1000, unfinalized: 2, weighted: 1500, usd: 1, share: 0.75 },
      { model: 'claude-haiku-4-5', label: 'Haiku 4.5', ...counters(), thinking: 0, responses: 234, unfinalized: 0, weighted: 500, usd: 1, share: 0.25 },
    ], byType: { input: 100, output: 200, cache_write: 300, cache_read: 9400 } },
    daily: { range, scan, days: [
      { day: '2026-10-02', total: { ...counters(), weighted: 400 }, bySlug: { 'C--proj-a': { ...counters(), weighted: 400 } } },
      { day: '2026-10-03', total: { ...counters(), weighted: 800 }, bySlug: { 'C--proj-a': { ...counters(), weighted: 600 }, __other__: { ...counters(), weighted: 200 } } },
    ], projects: [{ slug: 'C--proj-a', projectPath: 'C:\\proj\\a', label: 'proj <b>a</b>', weighted: 1000, colorIndex: 0 }], other: { weighted: 200 } },
    sessions: { range, scan, total: 450, rows: [
      { sessionId: SESSION_A, slug: 'C--proj-a', projectPath: 'C:\\proj\\a', title, firstTs: 1, lastTs: Date.now() - 60000, models: ['claude-opus-5-5'],
        main: { ...counters(), weighted: 900, responses: 10 }, subagents: { ...counters(), weighted: 50, responses: 3, agents: 2 },
        workflow: { ...counters(), weighted: 50, responses: 4, agents: 3, workflows: 1 },
        weighted: 1000, peakContext: 468000, compactions: 1, unfinalized: 0, isRunning: true },
      { sessionId: SESSION_B, slug: 'C--proj-a', projectPath: '', title: '', firstTs: 1, lastTs: Date.now() - 86400000, models: [],
        main: { ...counters(), weighted: 10, responses: 1 }, subagents: { weighted: 0, agents: 0 }, workflow: { weighted: 0, agents: 0, workflows: 0 },
        weighted: 10, peakContext: 0, compactions: 0, unfinalized: 0, isRunning: false },
    ] },
    context: { scan, sessionId: SESSION_A, slug: 'C--proj-a', title, model: 'claude-opus-5-5', contextWindow: 1000000,
      points: [
        { t: Date.UTC(2026, 9, 3, 10, 0), ctx: 100000, out: 500, mid: 'm1', fin: 1 },
        { t: Date.UTC(2026, 9, 3, 11, 0), ctx: 468000, out: 900, mid: 'm2', fin: 1 },
        { t: Date.UTC(2026, 9, 3, 12, 0), ctx: 34000, out: 100, mid: 'm3', fin: 0 },
      ],
      compactions: [{ t: Date.UTC(2026, 9, 3, 11, 30), trigger: 'auto', pre: 468000, post: 34000 }],
      handoffs: [{ t: Date.UTC(2026, 9, 3, 11, 20), tokens: 410000, path: 'C:\\h\\a.md', consumedBy: SESSION_B }],
      downsampled: true },
  };
}

const METHODS = { getTokenStatsSummary: 'summary', getTokenStatsModels: 'models', getTokenStatsDaily: 'daily',
  getTokenStatsSessions: 'sessions', getTokenStatsContext: 'context' };

// A context holding the real stats-view.js and (unless opts.noTokenView) the
// real token-stats-view.js. `respond(name, arg)` decides what each call returns.
function boot(opts = {}) {
  const dom = makeDom();
  const calls = [];
  const confirms = [];
  const confirmOptions = [];
  const errors = [];
  const listeners = [];
  const knobs = { confirm: true, respond: opts.respond || ((name) => okData()[METHODS[name]]) };
  const api = {
    refreshStats: () => { calls.push(['refreshStats']); return opts.refreshStats ? opts.refreshStats() : Promise.resolve({ stats: null, usage: {} }); },
    getStats: () => Promise.resolve(null),
    getUsage: () => Promise.resolve({}),
    onTokenStatsChanged: (cb) => { listeners.push(cb); },
  };
  for (const name of [...Object.keys(METHODS), 'rescanTokenStats', 'disableTokenStats', 'enableTokenStats']) {
    api[name] = (arg) => { calls.push([name, arg]); return knobs.respond(name, arg); };
  }
  for (const name of opts.missing || []) delete api[name];
  // A fake clock for the view's timers and for its Date.now(): no real timer is
  // left pending when a test ends (a 5 s one would hold the process open and
  // then fire into a discarded DOM), and a test moves time with app.tick(ms).
  // `new Date()` in the view stays real, so the day ranges are today's.
  const clock = { now: Date.now(), timers: [], seq: 0 };
  const context = vm.createContext({
    window: { api, innerWidth: 1200 },
    // dialogs.js's in-page confirm: it answers through a Promise, where the
    // native box this stood for returned a boolean.
    confirmDialog: async (m, options) => { confirms.push(m); confirmOptions.push(options); return knobs.confirm; },
    document: dom.document,
    console: { error: (...a) => errors.push(a.map(String).join(' ')), log() {} },
    statsViewerBody: dom.activityBody,
    escapeHtml: (s) => String(s),
    formatDate: () => '1m ago',
    setTimeout: (fn, ms) => { const id = ++clock.seq; clock.timers.push({ id, at: clock.now + (Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { clock.timers = clock.timers.filter(t => t.id !== id); },
    __now: () => clock.now,
  });
  const run = (js) => vm.runInContext(js, context);
  run('Date.now = __now;');
  run(STATS_SOURCE);
  if (!opts.noTokenView) run(VIEW_SOURCE);
  const count = (name) => calls.filter(c => c[0] === name).length;
  // Moves the fake clock forward, running every timer that falls due, in order.
  const tick = async (ms) => {
    const target = clock.now + ms;
    for (;;) {
      const due = clock.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.now = due.at;
      clock.timers = clock.timers.filter(t => t !== due);
      due.fn();
      await flush();
    }
    clock.now = target;
    await flush();
  };
  const args = (name) => calls.filter(c => c[0] === name).map(c => plain(c[1] === undefined ? null : c[1]));
  return { ...dom, run, calls, count, args, confirms, confirmOptions, errors, listeners, knobs, api, clock, tick };
}

async function openTokens(app) {
  app.run("setStatsSubtab('tokens')");
  await flush();
}

// ── dispatcher ──────────────────────────────────────────────────────────────

test('default sub-tab is Activity: it refreshes stats and never touches #stats-tokens-body', async () => {
  const app = boot();
  app.run('loadStats()');
  await flush();
  assert.equal(app.count('refreshStats'), 1);
  assert.equal(app.tokensBody.mutations, 0);
  assert.equal(app.tokensBody.style.display, 'none');
  assert.equal(app.activityBody.style.display, '');
  assert.match(app.activityBody.textContent, /No stats data found/);
  assert.equal(app.count('getTokenStatsSummary'), 0);
  assert.equal(app.subtabs[0].classList.contains('active'), true);
  assert.equal(app.subtabs[1].classList.contains('active'), false);
  assert.equal(app.subtabs[0].attrs['aria-selected'], 'true');
});

test('Tokens: one container shown, the other hidden, refreshStats not started, Activity body not written', async () => {
  const app = boot();
  app.run('loadStats()');
  await flush();
  const activityWrites = app.activityBody.mutations;
  const htmlWrites = app.htmlWrites.length;

  app.subtabs[1].fire('click');            // the strip's own listener
  await flush();
  assert.equal(app.count('refreshStats'), 1, 'no second /stats run for the Tokens tab');
  assert.equal(app.activityBody.mutations, activityWrites, 'the Tokens render wrote into #stats-viewer-body');
  assert.equal(app.htmlWrites.length, htmlWrites, 'the Tokens render used innerHTML');
  assert.equal(app.activityBody.style.display, 'none');
  assert.equal(app.tokensBody.style.display, '');
  assert.ok(app.tokensBody.mutations > 0);
  assert.equal(app.subtabs[1].classList.contains('active'), true);
  assert.equal(app.subtabs[0].attrs['aria-selected'], 'false');
  for (const name of Object.keys(METHODS).slice(0, 4)) assert.equal(app.count(name), 1, name);

  // The sub-tab is remembered: the Stats tab clicked again reloads Tokens.
  app.run('loadStats()');
  await flush();
  assert.equal(app.count('refreshStats'), 1);
  assert.equal(app.count('getTokenStatsSummary'), 2);

  // Back to Activity: refresh runs, and the Tokens body is left alone.
  const tokenWrites = app.tokensBody.mutations;
  app.subtabs[0].fire('click');
  await flush();
  assert.equal(app.count('refreshStats'), 2);
  assert.equal(app.tokensBody.mutations, tokenWrites, 'the Activity render wrote into #stats-tokens-body');
  assert.equal(app.tokensBody.style.display, 'none');
  // A click on the tab already showing starts nothing.
  app.subtabs[0].fire('click');
  await flush();
  assert.equal(app.count('refreshStats'), 2);
});

test('an Activity refresh still pending when Tokens is clicked lands in its own container only', async () => {
  let release;
  const app = boot({ refreshStats: () => new Promise(resolve => { release = resolve; }) });
  app.run('loadStats()');
  await flush();
  await openTokens(app);
  const tokenWrites = app.tokensBody.mutations;
  const tokenText = app.tokensBody.textContent;
  release({ stats: null, usage: {}, statsError: 'late failure' });
  await flush();
  assert.match(app.activityBody.textContent, /Stats refresh failed\. late failure/);
  assert.equal(app.tokensBody.mutations, tokenWrites);
  assert.equal(app.tokensBody.textContent, tokenText);
  assert.equal(app.activityBody.style.display, 'none');
});

test('without token-stats-view.js the Tokens click falls back to Activity (typeof guard)', async () => {
  const app = boot({ noTokenView: true });
  app.run("setStatsSubtab('tokens')");
  await flush();
  assert.equal(app.count('refreshStats'), 1);
  assert.equal(app.activityBody.style.display, '');
  assert.equal(app.tokensBody.style.display, 'none');
  assert.equal(app.tokensBody.mutations, 0);
  assert.equal(app.subtabs[0].classList.contains('active'), true);
});

// ── states (design 6.3) ─────────────────────────────────────────────────────

test('loading: every section shows its own spinner until the calls settle', async () => {
  const pending = [];
  const app = boot({ respond: () => new Promise(resolve => pending.push(resolve)) });
  app.run("setStatsSubtab('tokens')");
  await flush(1);
  assert.equal(byClass(app.tokensBody, 'stats-spinner').length, 4);
  assert.match(app.tokensBody.textContent, /Loading token totals/);
  assert.equal(pending.length, 4);
});

test('ok: toolbar, cards, chart, tables and footer; transcript text stays text', async () => {
  const app = boot();
  await openTokens(app);
  const text = app.tokensBody.textContent;
  assert.deepEqual(app.errors, []);
  assert.equal(byClass(app.tokensBody, 'stats-spinner').length, 0);
  assert.equal(app.htmlWrites.length, 0, 'innerHTML was used');

  // Default range is the last 30 local days, sent explicitly. The summary
  // request of an opening load also says so (opened: true); the others do not.
  const q = app.calls.find(c => c[0] === 'getTokenStatsSummary')[1];
  assert.deepEqual(plain(q), { ...tokRangeFor('30d', new Date()), opened: true });
  assert.deepEqual(plain(app.calls.find(c => c[0] === 'getTokenStatsModels')[1]), tokRangeFor('30d', new Date()));
  const sq = app.calls.find(c => c[0] === 'getTokenStatsSessions')[1];
  assert.equal(sq.sort, 'weighted');
  assert.equal(sq.limit, 200);
  assert.equal(button(app.tokensBody, '30d').classList.contains('active'), true);

  assert.match(text, /Scanned 3,017 files \u00b7 updated 14:02/);
  const cards = byClass(app.tokensBody, 'token-headline')[0].children;
  assert.deepEqual(cards.map(c => c.children[1].textContent),
    ['Input', 'Output', 'Cache write', 'Cache read', 'Weighted (est.)', 'Responses counted']);
  assert.equal(cards[4].children[0].textContent, '2.5M');
  assert.match(cards[4].title, /Not a bill\.\nAbout \$12\.50 at list prices\./);
  assert.equal(cards[4].textContent.includes('$'), false, 'dollars belong in the tooltip only');
  assert.match(cards[5].textContent, /1,234.*2 not finalised/);

  // Stacked columns on one common scale: 400 of 800 is half height.
  const stacks = byClass(app.tokensBody, 'token-stack');
  assert.deepEqual(stacks.map(s => s.style.height), ['50%', '100%']);
  assert.deepEqual(stacks[1].children.map(s => [s.className, s.style.flexGrow]), [['token-seg token-s0', '600'], ['token-seg token-s-other', '200']]);
  assert.match(byClass(app.tokensBody, 'token-col')[1].title, /^Oct 3\nTotal 800 weighted\nproj <b>a<\/b>: 600\nOther: 200$/);
  assert.match(byClass(app.tokensBody, 'token-legend')[0].textContent, /proj <b>a<\/b>Other/);

  assert.match(text, /Opus 5\.5/);
  assert.match(text, /All models/);
  assert.match(byClass(app.tokensBody, 'token-share-pct')[0].textContent, /^75\.0%$/);
  assert.match(byClass(app.tokensBody, 'token-types')[0].textContent, /94\.0%Cache read/);

  // Untrusted title: present as the literal string, never parsed.
  assert.ok(text.includes('Fix the <img src=x onerror=alert(1)> bug'));
  assert.equal(byTag(app.tokensBody, 'img').length, 0);
  assert.match(text, /Per session \u00b7 2 of 450/);
  assert.ok(button(app.tokensBody, 'Show more'));
  assert.equal(byClass(app.tokensBody, 'token-running').length, 1);
  const sorted = findAll(app.tokensBody, n => n.attrs['aria-sort'] === 'descending');
  assert.equal(sorted.length, 1);
  assert.match(sorted[0].textContent, /^Weighted/);

  assert.match(text, /Select a session to see its context over time\./);
  assert.match(text, /Each API response is counted once/);
  assert.match(text, /as of 2026-09-25 \u2014 not a bill\. Output is a lower bound: 2 responses never recorded a final count\./);
  assert.match(text, /Scanned 3,017 files, last update Oct 3 14:02\./);
  assert.equal(/no longer on disk/.test(text), false);
});

test('empty: each section says so in its own words', async () => {
  const app = boot({ respond: (name) => {
    const d = okData();
    d.summary.totals = counters({ input: 0, output: 0, cache_write: 0, cache_read: 0, responses: 0, unfinalized: 0 });
    d.models.models = [];
    d.daily.days = d.daily.days.map(x => ({ day: x.day, total: { input: 0, output: 0, cache_write: 0, cache_read: 0, weighted: 0 }, bySlug: {} }));
    d.sessions.rows = [];
    d.sessions.total = 0;
    return d[METHODS[name]];
  } });
  await openTokens(app);
  const empties = byClass(app.tokensBody, 'plans-empty').map(e => e.textContent);
  assert.deepEqual(empties, ['No token usage in this range.', 'No token usage in this range.', 'No token usage in this range.',
    'No sessions in this range.', 'Select a session to see its context over time.']);
  assert.deepEqual(app.errors, []);
});

test('{ error }: "Token analytics unavailable: <reason>." in the section that failed, the others still render', async () => {
  const app = boot({ respond: (name) => (name === 'getTokenStatsModels' ? { error: 'bad request: from' } : okData()[METHODS[name]]) });
  await openTokens(app);
  const notices = byClass(app.tokensBody, 'stats-refresh-error');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].textContent, 'Token analytics unavailable: bad request: from.');
  assert.equal(notices[0].attrs.role, 'status');
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);
  assert.equal(byClass(app.tokensBody, 'token-sessions').length, 1);

  const all = boot({ respond: () => ({ error: 'boom' }) });
  await openTokens(all);
  assert.deepEqual(byClass(all.tokensBody, 'stats-refresh-error').map(n => n.textContent),
    Array(4).fill('Token analytics unavailable: boom.'));
});

test('a REJECTED invoke says a restart is needed; so does a preload without the method', async () => {
  const app = boot({ respond: () => Promise.reject(new Error("Error invoking remote method 'token-stats-summary': No handler registered")) });
  await openTokens(app);
  assert.deepEqual(byClass(app.tokensBody, 'stats-refresh-error').map(n => n.textContent), Array(4).fill(TOK_NEEDS_RESTART));
  assert.deepEqual(app.errors, [], 'the tab must not throw into loadStats');

  const sync = boot({ respond: () => { throw new Error('sync throw'); } });
  await openTokens(sync);
  assert.equal(byClass(sync.tokensBody, 'stats-refresh-error').length, 4);

  const old = boot({ missing: ['getTokenStatsSummary', 'getTokenStatsDaily'] });
  await openTokens(old);
  assert.deepEqual(byClass(old.tokensBody, 'stats-refresh-error').map(n => n.textContent), [TOK_NEEDS_RESTART, TOK_NEEDS_RESTART]);
  assert.equal(byClass(old.tokensBody, 'token-sessions').length, 1);
});

test('disabled: the whole tab is one notice; Enable only for the kill switch, with a confirm', async () => {
  let off = true;
  const app = boot({ respond: (name) => {
    if (name === 'enableTokenStats') { off = false; return { ok: true, state: 'ok' }; }
    if (off) return { error: 'Token store unavailable: disabled by token-usage.off', scan: { state: 'disabled', reason: 'disabled by token-usage.off' } };
    return okData()[METHODS[name]];
  } });
  await openTokens(app);
  assert.equal(app.tokensBody.children.length, 1);
  assert.equal(app.tokensBody.children[0].attrs.role, 'status');
  assert.match(app.tokensBody.textContent, /^Token analytics is off: disabled by token-usage\.off\.Enable$/);

  app.knobs.confirm = false;
  button(app.tokensBody, 'Enable').fire('click');
  await flush();
  assert.equal(app.confirms.length, 1);
  assert.deepEqual({ ...app.confirmOptions[0] }, { confirm: 'Turn on' });
  assert.equal(app.count('enableTokenStats'), 0, 'a declined confirm must not enable');

  app.knobs.confirm = true;
  button(app.tokensBody, 'Enable').fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 1);
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1, 'the tab comes back without a restart');

  // Any other reason, from a main process that sends no reasonCode: never
  // Enable (stage 2: it gets Try again instead of no button at all).
  const broken = boot({ respond: () => ({ error: 'Token store unavailable: database is corrupt', scan: { state: 'disabled', reason: 'database is corrupt' } }) });
  await openTokens(broken);
  assert.equal(broken.tokensBody.children.length, 1);
  assert.equal(broken.tokensBody.textContent, 'Token analytics is off: database is corrupt.Try again');
  assert.equal(button(broken.tokensBody, 'Enable'), undefined);
});

// ── the way back from a failed store (stage 2) ──────────────────────────────

const offAnswer = (reason, reasonCode) => {
  const scan = { state: 'disabled', reason };
  if (reasonCode !== undefined) scan.reasonCode = reasonCode;
  return { error: 'Token store unavailable: ' + reason, scan };
};

test('tokOffAction: reasonCode decides; without one the reason text does, and everything else is Try again', () => {
  const { tokOffAction } = view;
  assert.equal(tokOffAction('kill-switch', 'anything'), 'enable');
  assert.equal(tokOffAction('failure', 'disabled by token-usage.off'), 'retry', 'the code wins over the text');
  assert.equal(tokOffAction(undefined, 'disabled by token-usage.off'), 'enable');
  assert.equal(tokOffAction(null, 'disabled by token-usage.off'), 'enable');
  assert.equal(tokOffAction(undefined, 'database is corrupt'), 'retry');
  assert.equal(tokOffAction(null, ''), 'retry');
  assert.equal(tokOffAction('something new', 'closed'), 'retry');

  const of = (value) => tokOutcome({ status: 'fulfilled', value });
  const fail = of(offAnswer('SQLITE_CANTOPEN: unable to open database file', 'failure'));
  assert.deepEqual([fail.kind, fail.action, fail.killSwitch], ['disabled', 'retry', false]);
  const flag = of(offAnswer('switched off', 'kill-switch'));
  assert.deepEqual([flag.kind, flag.action, flag.killSwitch], ['disabled', 'enable', true]);
});

test('reasonCode "failure": Try again, no confirm, one enableTokenStats call, and the tab reloads from the answer', async () => {
  let off = true;
  let release;
  const app = boot({ respond: (name) => {
    if (name === 'enableTokenStats') return new Promise(resolve => { release = () => { off = false; resolve({ ok: true, state: 'ok' }); }; });
    if (off) return offAnswer('SQLITE_CANTOPEN: unable to open database file', 'failure');
    return okData()[METHODS[name]];
  } });
  await openTokens(app);
  assert.equal(app.tokensBody.children.length, 1);
  assert.equal(app.tokensBody.children[0].attrs.role, 'status');
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: SQLITE_CANTOPEN: unable to open database file.Try again');
  assert.equal(button(app.tokensBody, 'Enable'), undefined);

  app.knobs.confirm = false;               // a confirm, if one were asked, would say no
  const btn = button(app.tokensBody, 'Try again');
  btn.fire('click');
  await flush();
  assert.equal(app.confirms.length, 0, 'Try again must not ask');
  assert.equal(app.count('enableTokenStats'), 1);
  // Working: the button says so and cannot be pressed twice.
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Trying again\u2026');
  btn.fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 1, 'a second click while working must not call again');
  assert.equal(app.count('getTokenStatsSummary'), 1);

  release();
  await flush();
  assert.equal(app.count('enableTokenStats'), 1);
  assert.equal(app.count('getTokenStatsSummary'), 2, 'the tab reloads after the answer');
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1, 'the tab comes back without a restart');
  assert.equal(byClass(app.tokensBody, 'token-off').length, 0);
  assert.deepEqual(app.errors, []);
});

test('reasonCode "failure" and the store still will not open: the reload shows the notice and the button again', async () => {
  // enable() answers { ok: true, state: 'disabled' } when init ran and left the
  // store off (token-usage.js enableImpl); the queries then say why.
  const app = boot({ respond: (name) => (name === 'enableTokenStats' ? { ok: true, state: 'disabled' } : offAnswer('disk is full', 'failure')) });
  await openTokens(app);
  button(app.tokensBody, 'Try again').fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 1);
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.equal(app.tokensBody.children.length, 1);
  assert.match(app.tokensBody.textContent, /^Token analytics is off: disk is full\.Try again$/);
  assert.equal(button(app.tokensBody, 'Try again').disabled, undefined);
});

test('reasonCode "kill-switch": Enable only, whatever the reason text says', async () => {
  const app = boot({ respond: () => offAnswer('switched off by the user', 'kill-switch') });
  await openTokens(app);
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: switched off by the user.Enable');
  assert.equal(button(app.tokensBody, 'Try again'), undefined);
  assert.equal(byTag(app.tokensBody, 'button').length, 1);

  // And the other way round: the code says failure, so the kill-switch text
  // does not bring Enable back.
  const failed = boot({ respond: () => offAnswer('disabled by token-usage.off', 'failure') });
  await openTokens(failed);
  assert.equal(button(failed.tokensBody, 'Enable'), undefined);
  assert.ok(button(failed.tokensBody, 'Try again'));
});

test('no reasonCode (an older main process): the kill-switch text gives Enable, every other reason Try again', async () => {
  const flag = boot({ respond: () => offAnswer('disabled by token-usage.off') });
  await openTokens(flag);
  assert.deepEqual(byTag(flag.tokensBody, 'button').map(b => b.textContent), ['Enable']);

  for (const reason of ['database is corrupt', 'closed', 'failed']) {
    const app = boot({ respond: () => offAnswer(reason) });
    await openTokens(app);
    assert.deepEqual(byTag(app.tokensBody, 'button').map(b => b.textContent), ['Try again'], reason);
  }
  // reasonCode null is "no code" too.
  const nul = boot({ respond: () => offAnswer('database is corrupt', null) });
  await openTokens(nul);
  assert.deepEqual(byTag(nul.tokensBody, 'button').map(b => b.textContent), ['Try again']);
});

test('Try again that fails: the notice keeps its reason, says what came back, and the button works again', async () => {
  const reason = 'unable to open <b>C:\\Users\\x\\.switchboard</b>';
  let answer = () => ({ error: 'Token store unavailable: permission <i>denied</i>.' });
  const app = boot({ respond: (name) => (name === 'enableTokenStats' ? answer() : offAnswer(reason, 'failure')) });
  await openTokens(app);

  // { error }
  button(app.tokensBody, 'Try again').fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 1);
  assert.equal(app.count('getTokenStatsSummary'), 1, 'a failed try does not reload the tab');
  assert.equal(app.tokensBody.children.length, 1);
  assert.equal(app.tokensBody.children[0].attrs.role, 'status');
  assert.equal(app.tokensBody.textContent,
    'Token analytics is off: ' + reason + '.Try againTry again failed: permission <i>denied</i>.');
  assert.equal(button(app.tokensBody, 'Try again').disabled, undefined, 'the button is usable again');

  // a rejected invoke (no handler in this main process)
  answer = () => Promise.reject(new Error("Error invoking remote method 'token-stats-enable': No handler registered"));
  button(app.tokensBody, 'Try again').fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 2);
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: ' + reason + '.Try again' + TOK_NEEDS_RESTART);
  assert.equal(byClass(app.tokensBody, 'token-off-note').length, 1, 'one note, replaced, not stacked');

  // a preload without the method is the same thing
  delete app.api.enableTokenStats;
  button(app.tokensBody, 'Try again').fire('click');
  await flush();
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: ' + reason + '.Try again' + TOK_NEEDS_RESTART);

  // { error } that carries the store's new state: that reason is shown.
  app.api.enableTokenStats = () => offAnswer('database disk image is malformed', 'failure');
  button(app.tokensBody, 'Try again').fire('click');
  await flush();
  assert.equal(app.tokensBody.textContent,
    'Token analytics is off: database disk image is malformed.Try againTry again did not work.');
  assert.ok(button(app.tokensBody, 'Try again'));

  // Untrusted reason strings: text, never markup; nothing thrown.
  assert.equal(app.htmlWrites.length, 0, 'innerHTML was used');
  assert.equal(byTag(app.tokensBody, 'b').length + byTag(app.tokensBody, 'i').length, 0);
  assert.deepEqual(app.errors, []);
  assert.equal(app.confirms.length, 0);
});

test('a Try again answer that arrives after the tab was redrawn does not draw over it', async () => {
  let off = true;
  let release;
  const app = boot({ respond: (name) => {
    if (name === 'enableTokenStats') return new Promise(resolve => { release = resolve; });
    return off ? offAnswer('disk is full', 'failure') : okData()[METHODS[name]];
  } });
  await openTokens(app);
  button(app.tokensBody, 'Try again').fire('click');
  await flush();
  off = false;                       // the store came back by itself
  app.run('loadStats()');            // and the tab was opened again
  await flush();
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);
  const writes = app.tokensBody.mutations;
  release({ error: 'late failure' });
  await flush();
  assert.equal(app.tokensBody.mutations, writes);
  assert.equal(/late failure/.test(app.tokensBody.textContent), false);
});

test('"Scanned N files" uses scan.files when it is a number, else scan.total', async () => {
  const { tokFileCount } = view;
  assert.equal(tokFileCount({ files: 3017, total: 0 }), 3017);
  assert.equal(tokFileCount({ files: 0, total: 12 }), 0, 'a store with no files says 0, not the walk size');
  assert.equal(tokFileCount({ files: null, total: 12 }), 12);
  assert.equal(tokFileCount({ total: 12 }), 12);
  assert.equal(tokFileCount({ files: '9', total: 12 }), 12);
  assert.equal(tokFileCount({ files: NaN }), 0);
  assert.equal(tokFileCount(null), 0);

  // After a launch: the last walk found nothing, the store holds 3,017 files.
  const app = boot({ respond: (name) => okData({ scan: { done: 0, total: 0, files: 3017 } })[METHODS[name]] });
  await openTokens(app);
  assert.match(app.tokensBody.textContent, /Scanned 3,017 files \u00b7 updated 14:02/);
  assert.match(app.tokensBody.textContent, /Scanned 3,017 files, last update Oct 3 14:02\./);

  // A change event carries no files field: the count from the last answer stays.
  app.listeners[0]({ phase: 'idle', done: 4, total: 4 });
  assert.match(byClass(app.tokensBody, 'token-status')[0].textContent, /^Scanned 3,017 files/);

  // An older main process (no scan.files, or null while the store is closed).
  const old = boot({ respond: (name) => okData({ scan: { total: 42, files: null } })[METHODS[name]] });
  await openTokens(old);
  assert.match(old.tokensBody.textContent, /Scanned 42 files \u00b7 updated/);
  assert.match(old.tokensBody.textContent, /Scanned 42 files, last update/);
});

test('Disable and Rebuild ask first; Rebuild is disabled while a scan runs', async () => {
  const app = boot({ respond: (name) => (METHODS[name] ? okData()[METHODS[name]] : { ok: true }) });
  await openTokens(app);
  app.knobs.confirm = false;
  button(app.tokensBody, 'Rebuild').fire('click');
  button(app.tokensBody, 'Disable').fire('click');
  await flush();
  assert.equal(app.confirms.length, 2);
  // Each button of the question is the action's own verb.
  assert.deepEqual(app.confirmOptions.map((o) => ({ ...o })), [{ confirm: 'Rebuild' }, { confirm: 'Turn off' }]);
  assert.equal(app.count('rescanTokenStats') + app.count('disableTokenStats'), 0);
  // The in-page confirm answers through a Promise, and a Promise is truthy:
  // only an awaited `true` may go ahead.
  for (const notYes of [undefined, 'yes', 1, {}]) {
    app.knobs.confirm = notYes;
    button(app.tokensBody, 'Rebuild').fire('click');
    button(app.tokensBody, 'Disable').fire('click');
    await flush();
  }
  app.run('__saved = confirmDialog; confirmDialog = () => Promise.reject(new Error("dialog failed"))');
  button(app.tokensBody, 'Rebuild').fire('click');
  await flush();
  app.run('confirmDialog = undefined');
  button(app.tokensBody, 'Disable').fire('click');
  await flush();
  assert.equal(app.count('rescanTokenStats') + app.count('disableTokenStats'), 0, 'anything but true is a no; so is a failing or missing dialog');
  app.run('confirmDialog = __saved');
  app.knobs.confirm = true;
  button(app.tokensBody, 'Rebuild').fire('click');
  await flush();
  assert.equal(app.count('rescanTokenStats'), 1);
  assert.equal(app.count('getTokenStatsSummary'), 2, 'the tab reloads after a rebuild is accepted');

  const scanning = boot({ respond: (name) => okData({ scan: { phase: 'backfill', done: 412, total: 3017 } })[METHODS[name]] });
  await openTokens(scanning);
  assert.equal(button(scanning.tokensBody, 'Rebuild').disabled, true);
  const text = scanning.tokensBody.textContent;
  assert.match(text, /Scanning transcripts\u2026 412 \/ 3,017/);
  assert.match(text, /Scanning transcripts \(412 \/ 3,017 files\)\. Totals are partial until the scan finishes\./);
  assert.equal(byClass(scanning.tokensBody, 'token-progress')[0].style.display, '');

  // A rejected action is reported, not thrown.
  const dead = boot({ respond: (name) => (METHODS[name] ? okData()[METHODS[name]] : Promise.reject(new Error('No handler registered'))) });
  await openTokens(dead);
  button(dead.tokensBody, 'Rebuild').fire('click');
  await flush();
  assert.equal(byClass(dead.tokensBody, 'token-status')[0].textContent, TOK_NEEDS_RESTART);
  assert.deepEqual(dead.errors, []);
});

test('files missing: the footer says their history is kept', async () => {
  const app = boot({ respond: (name) => okData({ scan: { filesMissing: 7 } })[METHODS[name]] });
  await openTokens(app);
  assert.match(app.tokensBody.textContent, /7 transcript files are no longer on disk; their history is kept\./);
});

// ── render generation, listener, re-query ───────────────────────────────────

test('render generation: a late response from an older range cannot overwrite a newer one', async () => {
  const pending = [];
  let slow = true;
  const app = boot({ respond: (name) => {
    if (slow) return new Promise(resolve => pending.push(() => resolve(okData({ weighted: 111000000, title: 'OLD RANGE' })[METHODS[name]])));
    return okData({ weighted: 2500000, title: 'NEW RANGE' })[METHODS[name]];
  } });
  app.run("setStatsSubtab('tokens')");
  await flush(1);
  assert.equal(pending.length, 4);

  slow = false;
  button(app.tokensBody, '7d').fire('click');
  await flush();
  const last = app.calls.filter(c => c[0] === 'getTokenStatsSummary').pop()[1];
  assert.deepEqual(plain(last), { ...tokRangeFor('7d', new Date()), opened: true });
  assert.match(app.tokensBody.textContent, /NEW RANGE/);

  for (const release of pending) release();   // the 30d answers arrive now
  await flush();
  const text = app.tokensBody.textContent;
  assert.match(text, /NEW RANGE/);
  assert.equal(/OLD RANGE/.test(text), false);
  assert.equal(/111M/.test(text), false);
  assert.match(text, /2\.5M/);
});

test('onTokenStatsChanged is registered once, at script load, however often the tab renders', async () => {
  const app = boot();
  assert.equal(app.listeners.length, 1, 'registered at load, before any render');
  await openTokens(app);
  app.run('loadStats()');
  await flush();
  button(app.tokensBody, '90d').fire('click');
  await flush();
  assert.equal(app.listeners.length, 1);
});

test('change events: one 5 s floor for every phase, one trailing timer, never while hidden', async () => {
  const app = boot();
  const fire = app.listeners[0];
  const idle = () => fire({ phase: 'idle', done: 9, total: 9 });
  fire({ phase: 'idle', done: 1, total: 1 });          // tab never opened
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 0);
  assert.equal(app.clock.timers.length, 0);

  await openTokens(app);
  assert.equal(app.count('getTokenStatsSummary'), 1);
  fire({ phase: 'catchup', done: 3, total: 9, changedSessions: [] });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 1, 'a scan tick inside 5 s must not re-query');
  assert.match(byClass(app.tokensBody, 'token-status')[0].textContent, /Scanning transcripts\u2026 3 \/ 9/);
  assert.equal(byClass(app.tokensBody, 'stats-spinner').length, 0);

  // Idle events are held to the same floor (the store sends one after every
  // applied chunk while sessions run): five of them inside 5 s re-query nothing
  // now and arm ONE timer between them.
  const firstRow = byClass(app.tokensBody, 'token-session-row')[0];
  for (let i = 0; i < 5; i++) idle();
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 1, 'an idle event inside 5 s must not re-query');
  assert.equal(byClass(app.tokensBody, 'token-session-row')[0], firstRow, 'the rows were rebuilt inside the floor');
  assert.equal(app.clock.timers.length, 1, 'one trailing timer for all of them');
  assert.match(byClass(app.tokensBody, 'token-status')[0].textContent, /^Scanned /, 'the status line still follows every event');

  await app.tick(4999);
  assert.equal(app.count('getTokenStatsSummary'), 1);
  await app.tick(1);
  assert.equal(app.count('getTokenStatsSummary'), 2, 'the last change is picked up when the floor has passed');
  assert.equal(app.clock.timers.length, 0);
  assert.equal(byClass(app.tokensBody, 'stats-spinner').length, 0, 'a live refresh does not flash spinners');

  // Past the floor a change re-queries at once, with no timer.
  await app.tick(5000);
  idle();
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 3);
  assert.equal(app.clock.timers.length, 0);

  // Any load answers a waiting change: the trailing timer is dropped with it.
  idle();
  await flush();
  assert.equal(app.clock.timers.length, 1);
  button(app.tokensBody, '7d').fire('click');
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 4);
  assert.equal(app.clock.timers.length, 0, 'a load must clear the trailing timer');
  await app.tick(6000);
  assert.equal(app.count('getTokenStatsSummary'), 4);

  // A timer still waiting when the tab is left does not query a hidden tab.
  idle();
  await flush();
  assert.equal(app.clock.timers.length, 0, 'past the floor: queried at once');
  assert.equal(app.count('getTokenStatsSummary'), 5);
  idle();
  await flush();
  assert.equal(app.clock.timers.length, 1);
  app.subtabs[0].fire('click');                        // Activity showing now
  await flush();
  await app.tick(6000);
  assert.equal(app.count('getTokenStatsSummary'), 5, 'the trailing timer fired into a hidden tab');
  idle();
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 5);
  assert.equal(app.clock.timers.length, 0);
  for (const bad of [null, undefined, 'x']) fire(bad);
  assert.deepEqual(app.errors, []);
});

test('a change event while a slow load is in flight: one reload after it, not one per event', async () => {
  const pending = [];
  let slow = false;
  const app = boot({ respond: (name) => (slow
    ? new Promise(resolve => pending.push(() => resolve(okData()[METHODS[name]])))
    : okData()[METHODS[name]]) });
  await openTokens(app);
  await app.tick(5000);
  slow = true;
  app.listeners[0]({ phase: 'idle', done: 1, total: 1 });      // past the floor: a quiet load starts and hangs
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 2);
  for (let i = 0; i < 3; i++) app.listeners[0]({ phase: 'idle', done: 1, total: 1 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.equal(app.clock.timers.length, 1);
  slow = false;
  for (const release of pending) release();
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 2, 'the answer of the slow load must not start another inside the floor');
  await app.tick(5000);
  assert.equal(app.count('getTokenStatsSummary'), 3);
  assert.equal(app.clock.timers.length, 0);
  assert.deepEqual(app.errors, []);
});

// ── sessions table and the context chart ────────────────────────────────────

test('sort and Show more re-query sessions only', async () => {
  const app = boot();
  await openTokens(app);
  button(app.tokensBody, 'Peak ctx').fire('click');
  await flush();
  assert.equal(app.count('getTokenStatsSessions'), 2);
  assert.equal(app.count('getTokenStatsSummary'), 1);
  assert.equal(app.calls.filter(c => c[0] === 'getTokenStatsSessions').pop()[1].sort, 'peak_ctx');
  const sorted = findAll(app.tokensBody, n => n.attrs['aria-sort'] === 'descending');
  assert.equal(sorted.length, 1);
  assert.match(sorted[0].textContent, /^Peak ctx/);

  button(app.tokensBody, 'Show more').fire('click');
  await flush();
  const q = app.calls.filter(c => c[0] === 'getTokenStatsSessions').pop()[1];
  assert.equal(q.limit, 400);
  assert.equal(q.sort, 'peak_ctx', 'sort state survives a rebuild of the table');
});

test('context over time: step line, reference lines, compaction and handoff marks, one tooltip', async () => {
  const app = boot();
  await openTokens(app);
  assert.equal(app.count('getTokenStatsContext'), 0);
  byClass(app.tokensBody, 'token-session-row')[0].fire('click');
  await flush();
  assert.deepEqual(plain(app.calls.find(c => c[0] === 'getTokenStatsContext')[1]), { sessionId: SESSION_A });
  assert.deepEqual(app.errors, []);

  const svg = byTag(app.tokensBody, 'svg')[0];
  assert.equal(svg.attrs.viewBox, '0 0 900 260');
  const line = byClass(svg, 'token-ctx-line')[0];
  assert.match(line.attrs.d, /^M[\d.]+ [\d.]+(H[\d.]+V[\d.]+){2}$/);
  assert.equal(byClass(svg, 'token-ctx-point').length, 3);
  assert.deepEqual(byClass(svg, 'token-ctx-ref-label').map(n => n.textContent), ['handoff trigger 400K', 'context window 1M']);
  assert.equal(byClass(svg, 'token-ctx-mark-label')[0].textContent, `468K ${ARROW} 34K`);
  assert.equal(byClass(svg, 'token-ctx-compaction-drop').length, 1);
  const handoff = byClass(svg, 'token-ctx-handoff')[0];
  assert.equal(handoff.classList.contains('consumed'), true);
  assert.match(handoff.textContent, new RegExp('consumed by ' + SESSION_B));
  assert.match(app.tokensBody.textContent, /3 responses \u00b7 1 compactions \u00b7 1 handoffs \u00b7 down-sampled/);
  assert.ok(app.tokensBody.textContent.includes('Context over time \u00b7 Fix the <img src=x onerror=alert(1)> bug'));

  // Hover: the nearest point's numbers, in the one reusable tooltip.
  svg.fire('mousemove', { clientX: 470, clientY: 100 });
  svg.fire('mousemove', { clientX: 480, clientY: 100 });
  const tips = byClass(app.document.body, 'token-tooltip');
  assert.equal(tips.length, 1);
  assert.match(tips[0].textContent, /Context 468K \(468,000\)Output 900claude-opus-5-5$/);
  assert.equal(tips[0].style.display, '');
  svg.fire('mouseleave');
  assert.equal(tips[0].style.display, 'none');

  // The selected session is re-queried with the rest on the next full load.
  app.run('loadStats()');
  await flush();
  assert.equal(app.count('getTokenStatsContext'), 2);
  assert.equal(byTag(app.tokensBody, 'svg').length, 1);
  assert.equal(byClass(app.document.body, 'token-tooltip').length, 1);
});

// ── review fixes (fix-list R-1 to R-13) ─────────────────────────────────────

const withContext = (over) => (name) => {
  const d = okData();
  if (name === 'getTokenStatsContext') return { ...d.context, ...over };
  return d[METHODS[name]];
};

async function openContext(app) {
  await openTokens(app);
  byClass(app.tokensBody, 'token-session-row')[0].fire('click');
  await flush();
  return byTag(app.tokensBody, 'svg')[0];
}

test('R-1: the context tooltip names the hovered point\'s own model; the reply\'s model is only the fallback', async () => {
  const base = okData().context.points;
  // The session switched models: the reply's `model` is the LAST response's.
  const app = boot({ respond: withContext({ model: 'claude-fable-5-1', points: [
    { ...base[0], model: 'claude-opus-5-5' },
    { ...base[1], model: 'claude-opus-<b>5</b>' },
    { ...base[2] },                                    // an older main process: no model on the point
  ] }) });
  const svg = await openContext(app);
  const tip = () => byClass(app.document.body, 'token-tooltip')[0].textContent;

  svg.fire('mousemove', { clientX: 60, clientY: 100 });        // the first point
  assert.match(tip(), /Context 100K \(100,000\)Output 500claude-opus-5-5$/);
  svg.fire('mousemove', { clientX: 470, clientY: 100 });       // the second: a model id is text, never markup
  assert.match(tip(), /Output 900claude-opus-<b>5<\/b>$/);
  assert.equal(byTag(app.document.body, 'b').length, 0);
  svg.fire('mousemove', { clientX: 880, clientY: 100 });       // the third has none of its own
  assert.match(tip(), /Output 100 \(not finalised\)claude-fable-5-1$/);
  assert.equal(app.htmlWrites.length, 0);
  assert.deepEqual(app.errors, []);
});

test('R-2: tokUsd rounds to cents first, so .995 and up carries into the dollars', async () => {
  const { tokUsd } = view;
  const cases = [
    [0, '$0.00'], [0.004, '$0.00'], [0.005, '$0.01'], [0.994, '$0.99'], [0.995, '$1.00'], [0.999, '$1.00'],
    [12.5, '$12.50'], [12.994, '$12.99'], [12.995, '$13.00'], [12.999, '$13.00'],
    [999.999, '$1,000.00'], [1234.5, '$1,234.50'], [1234.9963, '$1,235.00'], [1999.9999, '$2,000.00'],
    [1234567.891, '$1,234,567.89'],
  ];
  for (const [n, want] of cases) assert.equal(tokUsd(n), want, String(n));
  for (const bad of [null, undefined, NaN, 'x', -3, Infinity]) assert.equal(tokUsd(bad), '$0.00', String(bad));

  // Through the card: the tooltip is where the dollars are read.
  const app = boot({ respond: (name) => {
    const d = okData();
    d.summary.weighted.usd = 1234.9963;
    return d[METHODS[name]];
  } });
  await openTokens(app);
  assert.match(byClass(app.tokensBody, 'token-card-weighted')[0].title, /About \$1,235\.00 at list prices\./);
});

test('R-3: a compaction with no recorded size is a mark only: no drop to 0 and no numbers', async () => {
  const at = (min) => Date.UTC(2026, 9, 3, 10, min);
  const app = boot({ respond: withContext({ compactions: [
    { t: at(20), trigger: 'auto', pre: 450000, post: 30000 },
    { t: at(60), trigger: 'auto', pre: 450000, post: null },
    { t: at(100), trigger: 'manual', pre: null, post: null },
  ] }) });
  const svg = await openContext(app);
  const marks = byClass(svg, 'token-ctx-compaction');
  assert.equal(marks.length, 3);
  assert.equal(byClass(svg, 'token-ctx-compaction-line').length, 3, 'every compaction keeps its mark');
  assert.equal(byClass(svg, 'token-ctx-compaction-drop').length, 1, 'a drop is drawn only between two recorded sizes');
  assert.deepEqual(byClass(svg, 'token-ctx-mark-label').map(n => n.textContent), [`450K ${ARROW} 30K`]);
  const titles = marks.map(g => byTag(g, 'title')[0].textContent);
  assert.match(titles[0], new RegExp(`^Compaction \\(auto\\) at .*: 450K ${ARROW} 30K$`));
  assert.match(titles[1], /^Compaction \(auto\) at .*: size not recorded$/);
  assert.match(titles[2], /^Compaction \(manual\) at .*: size not recorded$/);
  for (const t of titles.slice(1)) assert.equal(t.includes(ARROW), false, t);
  assert.match(app.tokensBody.textContent, /3 compactions/);
  assert.deepEqual(app.errors, []);
});

test('R-4: a down-sampled chart counts the responses of the session, not the points drawn', async () => {
  const app = boot({ respond: withContext({ totalPoints: 2500, downsampled: true }) });
  const svg = await openContext(app);
  assert.equal(byClass(app.tokensBody, 'token-caption')[0].textContent,
    '2,500 responses · 1 compactions · 1 handoffs · down-sampled to 3 points');
  assert.match(svg.attrs['aria-label'], /^Context tokens over time: 2500 responses, peak 468K$/);

  // Not down-sampled: the two numbers are the same and nothing more is said.
  const whole = boot({ respond: withContext({ totalPoints: 3, downsampled: false }) });
  await openContext(whole);
  assert.equal(byClass(whole.tokensBody, 'token-caption')[0].textContent, '3 responses · 1 compactions · 1 handoffs');

  // A main process that sends no totalPoints: the drawn points are all there is to count.
  const old = boot({ respond: withContext({ downsampled: true }) });
  await openContext(old);
  assert.equal(byClass(old.tokensBody, 'token-caption')[0].textContent, '3 responses · 1 compactions · 1 handoffs · down-sampled');
  // A total smaller than what is drawn is not believed.
  const odd = boot({ respond: withContext({ totalPoints: 1, downsampled: false }) });
  await openContext(odd);
  assert.match(byClass(odd.tokensBody, 'token-caption')[0].textContent, /^3 responses/);
});

test('R-5: clicking a session row moves the highlight at once', async () => {
  const app = boot({ respond: (name, arg) => {
    const d = okData();
    if (name === 'getTokenStatsContext') return { ...d.context, sessionId: arg.sessionId };
    return d[METHODS[name]];
  } });
  await openTokens(app);
  const rows = byClass(app.tokensBody, 'token-session-row');
  const flags = () => rows.map(r => r.classList.contains('selected'));
  assert.deepEqual(flags(), [false, false]);
  rows[0].fire('click');
  assert.deepEqual(flags(), [true, false], 'the highlight must not wait for the answer');
  await flush();
  assert.deepEqual(flags(), [true, false]);
  rows[1].fire('click');
  await flush();
  assert.deepEqual(flags(), [false, true]);
  assert.equal(app.count('getTokenStatsSessions'), 1, 'the table was not re-queried to move it');
  assert.equal(byClass(app.tokensBody, 'token-session-row')[0], rows[0], 'the rows were not rebuilt to move it');
  // And the next render of the table agrees with it.
  app.run('loadStats()');
  await flush();
  assert.deepEqual(byClass(app.tokensBody, 'token-session-row').map(r => r.classList.contains('selected')), [false, true]);
});

test('R-6: an Enable that fails leaves a notice with a usable button and says what came back', async () => {
  // enable() answers { error } with no scan when init throws; the store is then
  // off because of a failure, which is what the queries say next.
  let state = 'flag';
  let enableAnswer = () => { state = 'failed'; return { error: 'unable to open <b>database</b> file' }; };
  const app = boot({ respond: (name) => {
    if (name === 'enableTokenStats') return enableAnswer();
    if (state === 'flag') return offAnswer('disabled by token-usage.off', 'kill-switch');
    if (state === 'failed') return offAnswer('unable to open <b>database</b> file', 'failure');
    return okData()[METHODS[name]];
  } });
  await openTokens(app);
  assert.deepEqual(byTag(app.tokensBody, 'button').map(b => b.textContent), ['Enable']);

  button(app.tokensBody, 'Enable').fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 1);
  assert.equal(app.count('getTokenStatsSummary'), 2, 'the tab asks the store what state it is in now');
  assert.equal(app.tokensBody.children.length, 1);
  assert.equal(app.tokensBody.children[0].attrs.role, 'status');
  assert.equal(app.tokensBody.textContent,
    'Token analytics is off: unable to open <b>database</b> file.Try againEnable failed: unable to open <b>database</b> file.');
  assert.equal(byClass(app.tokensBody, 'token-off-note').length, 1);
  assert.equal(byTag(app.tokensBody, 'b').length, 0, 'the reason is text');
  assert.equal(app.htmlWrites.length, 0);

  // The button is usable: this time the store opens.
  enableAnswer = () => { state = 'ok'; return { ok: true, state: 'ok' }; };
  const again = button(app.tokensBody, 'Try again');
  assert.equal(again.disabled, undefined);
  again.fire('click');
  await flush();
  assert.equal(app.count('enableTokenStats'), 2);
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);

  // No handler for the action (an older main process): the notice and its
  // button stay, with the restart sentence under them.
  const old = boot({ respond: (name) => (name === 'enableTokenStats'
    ? Promise.reject(new Error('No handler registered'))
    : offAnswer('disabled by token-usage.off', 'kill-switch')) });
  await openTokens(old);
  button(old.tokensBody, 'Enable').fire('click');
  await flush();
  assert.equal(old.tokensBody.textContent, 'Token analytics is off: disabled by token-usage.off.Enable' + TOK_NEEDS_RESTART);
  button(old.tokensBody, 'Enable').fire('click');
  await flush();
  assert.equal(old.count('enableTokenStats'), 2, 'the button still works');
  assert.equal(byClass(old.tokensBody, 'token-off-note').length, 1, 'one note, not one per try');
  assert.deepEqual(old.errors, []);
  assert.deepEqual(app.errors, []);
});

test('R-8: opened: true goes with the opening and with what the user asked for, never with a quiet refresh', async () => {
  const app = boot({ respond: (name) => (METHODS[name] ? okData()[METHODS[name]] : { ok: true }) });
  await openTokens(app);
  const last = () => app.args('getTokenStatsSummary').pop();
  assert.equal(last().opened, true, 'opening the tab');

  await app.tick(5000);
  app.listeners[0]({ phase: 'idle', done: 1, total: 1 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.deepEqual(last(), tokRangeFor('30d', new Date()), 'a quiet refresh carries no opened key at all');

  app.listeners[0]({ phase: 'idle', done: 1, total: 1 });      // inside the floor: the trailing timer
  await app.tick(5000);
  assert.equal(app.count('getTokenStatsSummary'), 3);
  assert.equal('opened' in last(), false, 'the trailing refresh is quiet too');

  button(app.tokensBody, '90d').fire('click');
  await flush();
  assert.equal(last().opened, true, 'a range change');
  button(app.tokensBody, 'Rebuild').fire('click');
  await flush();
  assert.equal(app.count('rescanTokenStats'), 1);
  assert.equal(last().opened, true, 'Rebuild');
  app.run('loadStats()');
  await flush();
  assert.equal(last().opened, true, 'the Stats tab clicked again');
  // Only the summary request carries it.
  for (const name of ['getTokenStatsModels', 'getTokenStatsDaily', 'getTokenStatsSessions']) {
    for (const q of app.args(name)) assert.equal('opened' in q, false, name);
  }
});

const startingAnswer = (reason = 'not initialised') => offAnswer(reason, null);

test('R-9: tokOutcome marks a store that has not started; every other off state is unchanged', () => {
  const of = (value) => tokOutcome({ status: 'fulfilled', value });
  assert.equal(of(startingAnswer()).starting, true);
  assert.equal(of(startingAnswer('starting')).starting, true);
  assert.equal(of(startingAnswer()).kind, 'disabled');
  assert.equal(of(offAnswer('not initialised')).starting, true, 'no reasonCode at all is "no code" too');
  for (const v of [offAnswer('not initialised', 'failure'), offAnswer('starting', 'kill-switch'), offAnswer('closed', null),
    offAnswer('database is corrupt', null), offAnswer('disabled by token-usage.off'), { error: 'Token store unavailable: not initialised' }]) {
    assert.equal(!!of(v).starting, false, JSON.stringify(v));
  }
});

test('R-9: a store that has not started shows a starting line and asks again each second until it answers', async () => {
  let started = false;
  const app = boot({ respond: (name) => (started ? okData()[METHODS[name]] : startingAnswer()) });
  await openTokens(app);
  assert.equal(app.tokensBody.children.length, 1);
  assert.equal(app.tokensBody.textContent, 'Token analytics is starting…');
  assert.equal(app.tokensBody.children[0].attrs.role, 'status');
  assert.equal(byTag(app.tokensBody, 'button').length, 0, 'no Try again for a store that is only starting');
  assert.equal(app.count('getTokenStatsSummary'), 1);
  assert.equal(app.clock.timers.length, 1);

  const line = app.tokensBody.children[0];
  await app.tick(999);
  assert.equal(app.count('getTokenStatsSummary'), 1);
  await app.tick(1);
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.equal(app.count('getTokenStatsModels'), 1, 'asking again is one small question, not the whole tab');
  assert.equal(app.tokensBody.children[0], line, 'the line stays put between tries (no flicker)');
  assert.equal(app.clock.timers.length, 1);

  // A change event while the line shows starts nothing extra: the timer is a second away.
  app.listeners[0]({ phase: 'backfill', done: 0, total: 10 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.equal(app.clock.timers.length, 1);

  started = true;
  await app.tick(1000);
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1, 'the tab draws itself once the store answers');
  assert.equal(app.clock.timers.length, 0);
  const sent = app.args('getTokenStatsSummary');
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map(q => q.opened === true), [true, false, false, true],
    'the tries are quiet; the load that draws the tab is the opening the user asked for');
  await app.tick(60000);
  assert.equal(app.count('getTokenStatsSummary'), 4, 'nothing keeps polling afterwards');
  assert.deepEqual(app.errors, []);
});

test('R-9: the tries are bounded, then the off notice with Try again; a change event brings that notice back to life', async () => {
  let started = false;
  const app = boot({ respond: (name) => (started ? okData()[METHODS[name]] : startingAnswer('starting')) });
  await openTokens(app);
  await app.tick(60000);
  assert.equal(app.count('getTokenStatsSummary'), 11, 'one load and ten tries');
  assert.equal(app.clock.timers.length, 0, 'no timer left after the last try');
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: starting.Try again');

  // Events for a hidden tab reload nothing.
  started = true;
  app.subtabs[0].fire('click');
  await flush();
  app.listeners[0]({ phase: 'backfill', done: 0, total: 10 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 11);
  assert.equal(app.clock.timers.length, 0);

  // Showing again with the off notice up: the store's first event reloads the tab.
  started = false;
  app.subtabs[1].fire('click');
  await flush();
  await app.tick(60000);
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: starting.Try again');
  const before = app.count('getTokenStatsSummary');
  started = true;
  app.listeners[0]({ phase: 'backfill', done: 0, total: 10 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), before + 1);
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);
  assert.equal('opened' in app.args('getTokenStatsSummary').pop(), false, 'a reload nobody asked for is not an opening');
  assert.deepEqual(app.errors, []);
});

test('R-9: the starting timer does not fire into a tab that was left or redrawn', async () => {
  const app = boot({ respond: () => startingAnswer() });
  await openTokens(app);
  assert.equal(app.clock.timers.length, 1);
  app.subtabs[0].fire('click');                        // Activity
  await flush();
  await app.tick(30000);
  assert.equal(app.count('getTokenStatsSummary'), 1, 'a hidden tab was queried');
  assert.equal(app.clock.timers.length, 0);

  // Coming back starts over, with one timer, not two.
  app.subtabs[1].fire('click');
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.equal(app.clock.timers.length, 1);
  app.run('loadStats()');                              // redrawn while the timer waits
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 3);
  assert.equal(app.clock.timers.length, 1, 'the redraw must replace the timer, not add one');

  // A try that is answered after the tab was redrawn draws nothing.
  let release;
  app.knobs.respond = (name) => (name === 'getTokenStatsSummary' && !release
    ? new Promise(resolve => { release = resolve; }) : okData()[METHODS[name]]);
  await app.tick(1000);                                // the try is in flight
  assert.equal(typeof release, 'function');
  app.run('loadStats()');
  await flush();
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);
  const writes = app.tokensBody.mutations;
  const asked = app.count('getTokenStatsSummary');
  release(startingAnswer());
  await flush();
  assert.equal(app.tokensBody.mutations, writes);
  assert.equal(app.count('getTokenStatsSummary'), asked);
  assert.deepEqual(app.errors, []);
});

test('R-9 / V2: with the off notice showing, a change event reloads a visible tab (Enable in another window)', async () => {
  let off = true;
  const app = boot({ respond: (name) => (off ? offAnswer('disabled by token-usage.off', 'kill-switch') : okData()[METHODS[name]]) });
  await openTokens(app);
  assert.deepEqual(byTag(app.tokensBody, 'button').map(b => b.textContent), ['Enable']);

  // Inside the floor the reload waits for the trailing timer, like any other.
  off = false;
  app.listeners[0]({ phase: 'idle', done: 0, total: 0 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), 1);
  assert.equal(app.clock.timers.length, 1);
  await app.tick(5000);
  assert.equal(app.count('getTokenStatsSummary'), 2);
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);

  // And the other way: Disable in another window turns this tab into the notice.
  off = true;
  await app.tick(5000);
  app.listeners[0]({ phase: 'idle', done: 0, total: 0 });
  await flush();
  assert.equal(app.tokensBody.textContent, 'Token analytics is off: disabled by token-usage.off.Enable');
  assert.equal(app.clock.timers.length, 0);

  // While this window's own Enable is in flight its answer decides, not the event.
  let release;
  app.api.enableTokenStats = () => { app.calls.push(['enableTokenStats']); return new Promise(resolve => { release = resolve; }); };
  await app.tick(5000);
  button(app.tokensBody, 'Enable').fire('click');
  await flush();
  const asked = app.count('getTokenStatsSummary');
  app.listeners[0]({ phase: 'idle', done: 0, total: 0 });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), asked, 'the event reloaded under an action in flight');
  assert.equal(app.clock.timers.length, 0);
  off = false;
  release({ ok: true, state: 'ok' });
  await flush();
  assert.equal(app.count('getTokenStatsSummary'), asked + 1);
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1);
  assert.deepEqual(app.errors, []);
});

test('R-10: the weighted tooltip takes its ratios from the reply, and keeps the old sentence without them', async () => {
  const { tokRatioSentence } = view;
  const FIXED = 'Weighted by API price ratios (input 1, output 5, cache write 1.25 / 2 for 5 m / 1 h, cache read 0.1; ' +
    '0.05 Opus 5.5, 0.025 Fable 5.1) as of 2026-09-25. Not a bill.';
  const ratios = { input: 1, output: 5, write5m: 1.25, write1h: 2, readDefault: 0.1 };
  assert.equal(tokRatioSentence({}, '2026-09-25'), FIXED);
  assert.equal(tokRatioSentence(null, '2026-09-25'), FIXED);
  assert.equal(tokRatioSentence({ ratios: { ...ratios, output: 'x' }, readRatios: [] }, '2026-09-25'), FIXED, 'a broken ratio is not printed');
  assert.equal(tokRatioSentence({ ratios: { input: 1 } }, '2026-09-25'), FIXED);

  assert.equal(tokRatioSentence({ ratios, readRatios: [] }, '2026-10-01'),
    'Weighted by API price ratios (input 1, output 5, cache write 1.25 / 2 for 5 m / 1 h, cache read 0.1) as of 2026-10-01. Not a bill.');
  assert.equal(tokRatioSentence({ ratios }, 'v'),
    'Weighted by API price ratios (input 1, output 5, cache write 1.25 / 2 for 5 m / 1 h, cache read 0.1) as of v. Not a bill.');
  const readRatios = [{ model: 'claude-opus-5-5', read: 0.05 }, { model: 'claude-fable-5-1', read: 0.025 },
    { model: 'claude-mythos-5-1', read: 0.025 }, { model: '', read: 0.5 }, { model: 'x', read: 'y' }, null];
  assert.equal(tokRatioSentence({ ratios: { ...ratios, write1h: 2.0000000001, output: 4 }, readRatios }, 'v'),
    'Weighted by API price ratios (input 1, output 4, cache write 1.25 / 2 for 5 m / 1 h, cache read 0.1; ' +
    '0.05 claude-opus-5-5, 0.025 claude-fable-5-1, 0.025 claude-mythos-5-1) as of v. Not a bill.');

  // On the card. A model id comes from a transcript: it is a title attribute, never markup.
  const app = boot({ respond: (name) => {
    const d = okData();
    d.summary.weighted.ratios = ratios;
    d.summary.weighted.readRatios = [{ model: 'claude-<i>mythos</i>-5-1', read: 0.025 }];
    return d[METHODS[name]];
  } });
  await openTokens(app);
  const card = byClass(app.tokensBody, 'token-card-weighted')[0];
  assert.match(card.title, /^Weighted by API price ratios \(input 1, output 5, cache write 1\.25 \/ 2 for 5 m \/ 1 h, cache read 0\.1; 0\.025 claude-<i>mythos<\/i>-5-1\) as of 2026-09-25\. Not a bill\.\nAbout \$12\.50 at list prices\.$/);
  assert.equal(byTag(app.tokensBody, 'i').length, 0);
  assert.equal(app.htmlWrites.length, 0);

  // A main process that sends neither field: the sentence the design gives.
  const old = boot();
  await openTokens(old);
  assert.ok(byClass(old.tokensBody, 'token-card-weighted')[0].title.startsWith(FIXED));
});

test('R-11: an open store whose scanner is not running says so above the headline', async () => {
  let reason = 'scanner stopped: the worker exited more than 3 times in an <b>hour</b>.';
  const app = boot({ respond: (name) => okData({ scan: { reason } })[METHODS[name]] });
  await openTokens(app);
  const box = byClass(app.tokensBody, 'token-scan-notice')[0];
  assert.equal(box.children.length, 1);
  assert.equal(box.children[0].attrs.role, 'status');
  assert.equal(box.textContent,
    'Scanning is not running: scanner stopped: the worker exited more than 3 times in an <b>hour</b>. Totals may be out of date.');
  assert.equal(byTag(app.tokensBody, 'b').length, 0, 'the reason is text');
  assert.equal(app.htmlWrites.length, 0);
  const order = app.tokensBody.children;
  assert.ok(order.indexOf(box) < order.indexOf(byClass(app.tokensBody, 'token-section-headline')[0]), 'above the headline');
  assert.equal(byClass(app.tokensBody, 'token-headline').length, 1, 'the totals are still shown');

  // A change event carries no reason: the notice stays, and is not doubled.
  app.listeners[0]({ phase: 'idle', done: 1, total: 1 });
  await flush();
  assert.equal(box.children.length, 1);

  // The scanner is back (the store clears the reason at the next hello).
  reason = null;
  app.run('loadStats()');
  await flush();
  assert.equal(byClass(app.tokensBody, 'token-scan-notice')[0].textContent, '');

  // Healthy stores say nothing, whatever shape "no reason" takes.
  for (const healthy of [null, '', '   ', undefined, 7]) {
    const fine = boot({ respond: (name) => okData({ scan: { reason: healthy } })[METHODS[name]] });
    await openTokens(fine);
    assert.equal(byClass(fine.tokensBody, 'token-scan-notice')[0].textContent, '', String(healthy));
  }

  // A first scan that stopped half way: both facts, the scanner first.
  const half = boot({ respond: (name) => okData({ scan: { reason: 'scanner failed to start: no worker', phase: 'backfill', done: 412, total: 3017 } })[METHODS[name]] });
  await openTokens(half);
  assert.deepEqual(byClass(half.tokensBody, 'token-scan-notice')[0].children.map(n => n.textContent), [
    'Scanning is not running: scanner failed to start: no worker. Totals may be out of date.',
    'Scanning transcripts (412 / 3,017 files). Totals are partial until the scan finishes.',
  ]);
  half.listeners[0]({ phase: 'backfill', done: 500, total: 3017 });
  await flush();
  assert.deepEqual(byClass(half.tokensBody, 'token-scan-notice')[0].children.map(n => n.textContent), [
    'Scanning is not running: scanner failed to start: no worker. Totals may be out of date.',
    'Scanning transcripts (500 / 3,017 files). Totals are partial until the scan finishes.',
  ]);
  assert.deepEqual(app.errors.concat(half.errors), []);
});

test('R-12: queries running in the main process are named in the status line', async () => {
  const NOTE = ' · queries are running in the main process (slower)';
  const app = boot({ respond: (name) => okData({ scan: { queryMode: 'inline' } })[METHODS[name]] });
  await openTokens(app);
  const status = () => byClass(app.tokensBody, 'token-status')[0].textContent;
  assert.equal(status(), 'Scanned 3,017 files · updated 14:02' + NOTE);
  // A change event carries no queryMode: the note stays while a scan runs too.
  app.listeners[0]({ phase: 'catchup', done: 3, total: 9 });
  assert.equal(status(), 'Scanning transcripts… 3 / 9' + NOTE);

  for (const mode of ['worker', undefined, null, 'INLINE']) {
    const fine = boot({ respond: (name) => okData({ scan: { queryMode: mode } })[METHODS[name]] });
    await openTokens(fine);
    assert.equal(byClass(fine.tokensBody, 'token-status')[0].textContent, 'Scanned 3,017 files · updated 14:02', String(mode));
  }
});

test('R-13: the Rebuild confirm says the old store is kept aside, and what leaves the views when files are gone', async () => {
  const app = boot({ respond: (name) => (METHODS[name] ? okData()[METHODS[name]] : { ok: true }) });
  await openTokens(app);
  app.knobs.confirm = false;
  button(app.tokensBody, 'Rebuild').fire('click');
  await flush();
  assert.equal(app.confirms.length, 1);
  assert.match(app.confirms[0], /^Rebuild token analytics\?/);
  assert.match(app.confirms[0], /The old store is kept beside the new one as token-usage\.db\.before-rebuild-<time>/);
  assert.match(app.confirms[0], /Transcripts are only read\./);
  assert.equal(/no longer on disk/.test(app.confirms[0]), false, 'nothing is missing, so nothing is said about it');
  assert.equal(app.count('rescanTokenStats'), 0);
  assert.equal(/throw away/i.test(button(app.tokensBody, 'Rebuild').title), false, 'the button no longer says the store is thrown away');

  for (const [n, want] of [[7, /The history of 7 transcript files that are no longer on disk will leave the views\b/],
    [1, /The history of 1 transcript file that is no longer on disk will leave the views\b/],
    [1234, /The history of 1,234 transcript files that are no longer on disk will leave the views\b/]]) {
    const gone = boot({ respond: (name) => (METHODS[name] ? okData({ scan: { filesMissing: n } })[METHODS[name]] : { ok: true }) });
    await openTokens(gone);
    gone.knobs.confirm = false;
    button(gone.tokensBody, 'Rebuild').fire('click');
    await flush();
    assert.match(gone.confirms[0], want);
    assert.match(gone.confirms[0], /token-usage\.db\.before-rebuild-<time>/);
  }
});
