// --- Tokens sub-tab of the Stats view ---
// Loaded after stats-view.js and before app.js. stats-view.js's loadStats() is
// the dispatcher: it shows #stats-tokens-body and calls loadTokenStats() behind
// a typeof guard, so this file can be absent without breaking Activity.
//
// Depends on: window.api.getTokenStats{Summary,Models,Daily,Sessions,Context},
// rescanTokenStats, disableTokenStats, enableTokenStats, onTokenStatsChanged
// (preload.js); optionally formatDate (utils.js). Every one of them is looked
// up at call time and may be missing: preload.js reloads with the window while
// main.js only changes at a relaunch, so a window can run this file against a
// main process that has no token handlers yet.
//
// Rules this file keeps:
//  - It writes only inside #stats-tokens-body (plus one tooltip div on body).
//  - No innerHTML anywhere. Titles, slugs, paths and model ids come from
//    transcripts and folder names, so they are untrusted text: textContent and
//    setAttribute only.
//  - Day strings ('YYYY-MM-DD') are LOCAL days. They are built from
//    getFullYear/getMonth/getDate and parsed with new Date(y, m, d), never with
//    toISOString or new Date('YYYY-MM-DD'), both of which are UTC and move the
//    day for anyone west or east of Greenwich.
//  - The pure helpers at the top touch no DOM, so the module loads under plain
//    Node for the test (module.exports at the bottom).

const TOK_NEEDS_RESTART = 'Token analytics needs a Switchboard restart to start working.';
const TOK_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "All" needs an explicit start: a request with neither bound means "last 30
// local days" to the handlers. Inferred, not measured: no Claude Code
// transcript is older than this.
const TOK_ALL_FROM = '2024-01-01';
const TOK_HANDOFF_TRIGGER = 400000;
const TOK_PAGE = 200;
const TOK_MAX_LIMIT = 2000;        // the handlers' own ceiling for `limit`
const TOK_MAX_COLUMNS = 120;       // more days than this are summed into wider buckets
const TOK_REQUERY_MS = 5000;       // at most one re-query per 5 s while a scan runs
const TOK_SVG_NS = 'http://www.w3.org/2000/svg';
const TOK_OTHER = '__other__';

// Categorical slots in fixed order (dataviz skill, dark steps), validated
// against this view's surface #111118: validate_palette.js --mode dark passes
// all five checks, worst adjacent CVD delta E 8.4. A project keeps the slot
// main gives it (colorIndex), so a range change does not repaint it. Anything
// past eight is drawn as Other, never as a generated ninth hue.
const TOK_SERIES_SLOTS = 8;

// ── pure helpers ────────────────────────────────────────────────────────────

// < 1,000 integer; then one decimal with K / M / B, trailing ".0" dropped.
// A value that rounds up to 1000 of its unit moves to the next unit, so
// 999,950 reads "1M" and not "1000K".
function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1000) return String(Math.round(v) >= 1000 ? '1K' : Math.round(v));
  const units = [[1e3, 'K'], [1e6, 'M'], [1e9, 'B']];
  for (let i = 0; i < units.length; i++) {
    const s = (v / units[i][0]).toFixed(1);
    if (parseFloat(s) < 1000 || i === units.length - 1) {
      return (s.endsWith('.0') ? s.slice(0, -2) : s) + units[i][1];
    }
  }
  return String(v);
}

// Integer with thousands separators, without toLocaleString so the text does
// not depend on the machine's locale.
function tokNum(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function tokPad2(n) { return n < 10 ? '0' + n : String(n); }

// Local-day key of a Date.
function tokDayKey(date) {
  return date.getFullYear() + '-' + tokPad2(date.getMonth() + 1) + '-' + tokPad2(date.getDate());
}

// 'YYYY-MM-DD' → local midnight of that day, or null.
function tokParseDay(day) {
  if (typeof day !== 'string' || !TOK_DAY_RE.test(day)) return null;
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), d = Number(day.slice(8, 10));
  const date = new Date(y, m - 1, d);
  // new Date(2026, 1, 31) silently becomes March 3; refuse such input.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

// 'YYYY-MM-DD' → 'Oct 3'. Pure string work on the key itself, so no time zone
// can be involved at all.
function tokDayLabel(day) {
  if (typeof day !== 'string' || !TOK_DAY_RE.test(day)) return '';
  const m = Number(day.slice(5, 7));
  return (TOK_MONTHS[m - 1] || '?') + ' ' + Number(day.slice(8, 10));
}

// The request range for a chip. `now` is a Date (injected for the test).
function tokRangeFor(key, now, customFrom, customTo) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = tokDayKey(today);
  const back = (days) => tokDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)));
  if (key === '7d') return { from: back(7), to };
  if (key === '90d') return { from: back(90), to };
  if (key === 'all') return { from: TOK_ALL_FROM, to };
  if (key === 'custom') {
    if (!tokParseDay(customFrom) || !tokParseDay(customTo)) return null;
    return customFrom <= customTo ? { from: customFrom, to: customTo } : { from: customTo, to: customFrom };
  }
  return { from: back(30), to };
}

// One allSettled entry → what the section should show. The three failure
// kinds are different facts and get different words:
//   restart  - the invoke REJECTED (or the preload method is missing): there is
//              no handler in this main process, which only a relaunch fixes.
//   disabled - the store is off (kill switch or a failed open).
//   error    - the handler answered { error }.
function tokOutcome(settled) {
  if (!settled || settled.status !== 'fulfilled') return { kind: 'restart', text: TOK_NEEDS_RESTART };
  const v = settled.value;
  if (!v || typeof v !== 'object') return { kind: 'error', text: 'Token analytics unavailable: no response.' };
  const clean = (s) => String(s).replace(/^Token store unavailable:\s*/i, '').replace(/[.\s]+$/, '');
  const scanOff = v.scan && v.scan.state === 'disabled';
  const errText = typeof v.error === 'string' && v.error ? v.error : '';
  // The kill switch reports itself as "disabled by token-usage.off"; an error
  // carrying that text is the same state even when no scan object came with it.
  if (scanOff || /token-usage\.off/.test(errText)) {
    const reason = clean((v.scan && v.scan.reason) || errText || 'unknown reason');
    const action = tokOffAction(v.scan && v.scan.reasonCode, reason);
    return { kind: 'disabled', reason, action, killSwitch: action === 'enable', text: 'Token analytics is off: ' + reason + '.' };
  }
  if (errText) return { kind: 'error', reason: clean(errText), text: 'Token analytics unavailable: ' + clean(errText) + '.' };
  return { kind: 'ok', data: v };
}

// Which way back a switched-off store offers: 'enable' (the kill switch: the
// user turned it off, so turning it on asks first) or 'retry' (the store failed
// to open or broke while running: opening it again is all there is to do).
// scan.reasonCode says which; a main process from before that field existed
// sends none, and then the reason text is the only evidence there is. Every
// reason that is not the kill switch gets Try again: a notice with no button
// is a dead end until the next restart.
function tokOffAction(reasonCode, reason) {
  if (reasonCode === 'kill-switch') return 'enable';
  if (reasonCode === 'failure') return 'retry';
  return /token-usage\.off/.test(String(reason || '')) ? 'enable' : 'retry';
}

// "Scanned N files": the number of files the store holds. scan.total is only
// the size of the last walk, which is 0 after a launch that found nothing new,
// so it is used only when the main process does not send scan.files.
function tokFileCount(scan) {
  if (!scan) return 0;
  return typeof scan.files === 'number' && isFinite(scan.files) ? scan.files : (Number(scan.total) || 0);
}

// Index of the point whose t is nearest to `t` (points sorted by t).
function tokNearestIndex(points, t) {
  if (!points || !points.length) return -1;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) <= Math.abs(points[lo].t - t)) return lo - 1;
  return lo;
}

// Step line: the context size holds until the next response replaces it, so
// the line runs horizontally to the next time and then vertically.
function tokStepPath(points, sx, sy) {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const x = sx(points[i].t).toFixed(1), y = sy(points[i].ctx).toFixed(1);
    d += i === 0 ? 'M' + x + ' ' + y : 'H' + x + 'V' + y;
  }
  return d;
}

function tokCounterValue(c, measure) {
  if (!c) return 0;
  if (measure === 'raw') return (c.input || 0) + (c.output || 0) + (c.cache_write || 0) + (c.cache_read || 0);
  return c.weighted || 0;
}

// Days → columns. Leading days with nothing in them are dropped when
// `trimLeading` (the All range starts long before the first transcript), and a
// range longer than maxCols is summed into equal buckets of whole days so the
// columns stay wide enough to read.
function tokBucketDays(days, measure, maxCols, trimLeading) {
  let list = Array.isArray(days) ? days : [];
  if (trimLeading) {
    let first = 0;
    while (first < list.length - 1 && tokCounterValue(list[first].total, measure) <= 0) first++;
    list = list.slice(first);
  }
  const size = Math.max(1, Math.ceil(list.length / maxCols));
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const col = { from: chunk[0].day, to: chunk[chunk.length - 1].day, total: 0, bySlug: {} };
    for (const day of chunk) {
      col.total += tokCounterValue(day.total, measure);
      for (const slug of Object.keys(day.bySlug || {})) {
        col.bySlug[slug] = (col.bySlug[slug] || 0) + tokCounterValue(day.bySlug[slug], measure);
      }
    }
    out.push(col);
  }
  return out;
}

// Y ticks every 200K, doubled until there are at most six.
function tokYTicks(max) {
  let step = 200000;
  while (max / step > 6) step *= 2;
  const ticks = [];
  for (let v = 0; v <= max + 1; v += step) ticks.push(v);
  return ticks;
}

// X ticks on LOCAL hour or day boundaries, depending on the span.
function tokXTicks(t0, t1) {
  const span = t1 - t0;
  const ticks = [];
  if (span <= 48 * 3600000) {
    const hours = span / 3600000;
    let step = 1;
    for (const s of [1, 2, 3, 6, 12]) { step = s; if (hours / s <= 8) break; }
    const d = new Date(t0);
    d.setMinutes(0, 0, 0);
    while (d.getTime() < t0 || d.getHours() % step !== 0) d.setHours(d.getHours() + 1);
    for (let guard = 0; d.getTime() <= t1 && guard < 60; guard++) {
      ticks.push({ t: d.getTime(), label: tokPad2(d.getHours()) + ':00' });
      d.setHours(d.getHours() + step);
    }
  } else {
    const days = span / 86400000;
    const step = Math.max(1, Math.ceil(days / 8));
    const d = new Date(t0);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < t0) d.setDate(d.getDate() + 1);
    for (let guard = 0; d.getTime() <= t1 && guard < 60; guard++) {
      ticks.push({ t: d.getTime(), label: TOK_MONTHS[d.getMonth()] + ' ' + d.getDate() });
      d.setDate(d.getDate() + step);   // setDate keeps local midnight across DST
    }
  }
  return ticks;
}

function tokClock(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return tokPad2(d.getHours()) + ':' + tokPad2(d.getMinutes());
}

function tokDateTime(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return TOK_MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + tokClock(ms);
}

function tokUsd(n) {
  const v = Number(n) || 0;
  const whole = Math.floor(v);
  return '$' + tokNum(whole) + '.' + tokPad2(Math.round((v - whole) * 100) % 100);
}

// ── state ───────────────────────────────────────────────────────────────────

let tokRange = '30d';            // default range: last 30 local days
let tokCustomFrom = '';
let tokCustomTo = '';
let tokMeasure = 'weighted';     // the chart's measure; the tables stay weighted
let tokSort = 'weighted';
let tokLimit = TOK_PAGE;
let tokSelected = null;          // session id shown in "Context over time"
// Render generations. A full load bumps all three; a header sort or Show more
// bumps only the sessions one and a row click only the context one, so the
// newest request for a section is the only one allowed to draw it.
let tokGen = 0;
let tokSessGen = 0;
let tokCtxGen = 0;
let tokUi = null;                // the skeleton's element refs, null when not built
let tokScan = null;              // last scan object seen
let tokDaily = null;             // last daily response, for the measure toggle
let tokLastQueryMs = 0;
let tokInFlight = false;
let tokStale = false;
let tokTooltipEl = null;
let tokOffNotice = null;         // the "Token analytics is off" notice now showing, if any

// ── DOM helpers ─────────────────────────────────────────────────────────────

function tokEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function tokSvg(tag, attrs, text) {
  const node = document.createElementNS(TOK_SVG_NS, tag);
  for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function tokClear(node) { node.textContent = ''; }

function tokBody() { return document.getElementById('stats-tokens-body'); }

function tokVisible() {
  const body = tokBody();
  if (!body || body.style.display === 'none') return false;
  const viewer = document.getElementById('stats-viewer');
  return !viewer || viewer.style.display !== 'none';
}

function tokSpinner(container, text) {
  tokClear(container);
  const row = tokEl('div', 'stats-spinner');
  row.appendChild(tokEl('div', 'stats-spinner-icon'));
  row.appendChild(tokEl('span', '', text));
  container.appendChild(row);
}

function tokNotice(container, text) {
  tokClear(container);
  const notice = tokEl('div', 'stats-refresh-error', text);
  notice.setAttribute('role', 'status');
  container.appendChild(notice);
  return notice;
}

function tokEmpty(container, text) {
  tokClear(container);
  container.appendChild(tokEl('div', 'plans-empty token-empty', text));
}

function tokTitle(container, text) {
  const title = tokEl('div', 'daily-chart-title', text);
  container.appendChild(title);
  return title;
}

// Draws the non-ok states. Returns the data when the section may render.
function tokGuard(container, outcome) {
  if (outcome.kind === 'ok') return outcome.data;
  tokNotice(container, outcome.text);
  return null;
}

// A preload method that is missing is the same situation as an invoke with no
// handler: both end as a rejection, and both read "needs a restart".
function tokCall(name, arg) {
  try {
    const fn = typeof window !== 'undefined' && window.api ? window.api[name] : null;
    if (typeof fn !== 'function') return Promise.reject(new Error('window.api.' + name + ' is not available'));
    return Promise.resolve(fn(arg));
  } catch (err) {
    return Promise.reject(err);
  }
}

function tokConfirm(message) {
  try { return typeof window.confirm === 'function' ? !!window.confirm(message) : false; } catch { return false; }
}

// ── skeleton ────────────────────────────────────────────────────────────────

function tokBuildSkeleton(body) {
  tokClear(body);
  tokOffNotice = null;   // a Try again still in flight must not draw over this
  const ui = {};

  const bar = tokEl('div', 'token-toolbar');
  ui.chips = {};
  const chips = tokEl('div', 'token-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Date range');
  for (const [key, label] of [['7d', '7d'], ['30d', '30d'], ['90d', '90d'], ['all', 'All'], ['custom', 'Custom']]) {
    const chip = tokEl('button', 'token-chip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => tokPickRange(key));
    ui.chips[key] = chip;
    chips.appendChild(chip);
  }
  bar.appendChild(chips);

  ui.custom = tokEl('span', 'token-custom');
  ui.from = tokEl('input', 'token-date');
  ui.from.type = 'date';
  ui.from.setAttribute('aria-label', 'From day');
  ui.to = tokEl('input', 'token-date');
  ui.to.type = 'date';
  ui.to.setAttribute('aria-label', 'To day');
  const onDate = () => {
    tokCustomFrom = ui.from.value;
    tokCustomTo = ui.to.value;
    // Nothing is queried until both days are complete and real.
    if (tokRangeFor('custom', new Date(), tokCustomFrom, tokCustomTo)) { tokLimit = TOK_PAGE; loadTokenStats(); }
  };
  ui.from.addEventListener('change', onDate);
  ui.to.addEventListener('change', onDate);
  ui.custom.appendChild(ui.from);
  ui.custom.appendChild(tokEl('span', 'token-custom-sep', 'to'));
  ui.custom.appendChild(ui.to);
  bar.appendChild(ui.custom);

  ui.measure = {};
  const measure = tokEl('div', 'token-chips');
  measure.setAttribute('role', 'group');
  measure.setAttribute('aria-label', 'Chart measure');
  for (const [key, label] of [['weighted', 'Weighted'], ['raw', 'Raw']]) {
    const chip = tokEl('button', 'token-chip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      if (tokMeasure === key) return;
      tokMeasure = key;
      tokSyncToolbar();
      // The response holds both measures; no new query is needed.
      if (tokDaily && tokUi) tokRenderDaily(tokUi.daily, tokDaily);
    });
    ui.measure[key] = chip;
    measure.appendChild(chip);
  }
  bar.appendChild(measure);

  bar.appendChild(tokEl('span', 'token-toolbar-gap'));

  ui.status = tokEl('span', 'token-status');
  ui.status.setAttribute('role', 'status');
  bar.appendChild(ui.status);

  ui.rebuild = tokEl('button', 'token-btn', 'Rebuild');
  ui.rebuild.type = 'button';
  ui.rebuild.title = 'Throw away the token store and rescan every transcript';
  ui.rebuild.addEventListener('click', tokRebuild);
  bar.appendChild(ui.rebuild);

  ui.disable = tokEl('button', 'token-btn token-btn-quiet', 'Disable');
  ui.disable.type = 'button';
  ui.disable.title = 'Turn token analytics off (no restart needed)';
  ui.disable.addEventListener('click', tokDisable);
  bar.appendChild(ui.disable);
  body.appendChild(bar);

  ui.progress = tokEl('div', 'token-progress');
  ui.progressFill = tokEl('div', 'token-progress-fill');
  ui.progress.appendChild(ui.progressFill);
  ui.progress.style.display = 'none';
  body.appendChild(ui.progress);

  ui.scanNotice = tokEl('div', 'token-scan-notice');
  body.appendChild(ui.scanNotice);

  for (const key of ['headline', 'daily', 'models', 'sessions', 'context']) {
    ui[key] = tokEl('div', 'token-section token-section-' + key);
    body.appendChild(ui[key]);
  }
  ui.footer = tokEl('div', 'token-footer');
  body.appendChild(ui.footer);
  return ui;
}

function tokSyncToolbar() {
  if (!tokUi) return;
  for (const key of Object.keys(tokUi.chips)) {
    const on = key === tokRange;
    tokUi.chips[key].classList.toggle('active', on);
    tokUi.chips[key].setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  for (const key of Object.keys(tokUi.measure)) {
    const on = key === tokMeasure;
    tokUi.measure[key].classList.toggle('active', on);
    tokUi.measure[key].setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  tokUi.custom.style.display = tokRange === 'custom' ? '' : 'none';
  if (tokUi.from.value !== tokCustomFrom) tokUi.from.value = tokCustomFrom;
  if (tokUi.to.value !== tokCustomTo) tokUi.to.value = tokCustomTo;
}

function tokPickRange(key) {
  if (key === 'custom' && (!tokCustomFrom || !tokCustomTo)) {
    // Custom opens on the range already showing, so the first edit refines it.
    // (All starts years back, so from there Custom opens on the last 30 days.)
    const base = tokRangeFor(tokRange === 'all' || tokRange === 'custom' ? '30d' : tokRange, new Date());
    tokCustomFrom = base.from;
    tokCustomTo = base.to;
  }
  if (key === tokRange && key !== 'custom') return;
  tokRange = key;
  tokLimit = TOK_PAGE;
  loadTokenStats();
}

// ── scan status ─────────────────────────────────────────────────────────────

function tokRenderScan(scan) {
  if (!tokUi) return;
  if (scan && typeof scan === 'object') tokScan = Object.assign({}, tokScan || {}, scan);
  const s = tokScan;
  if (!s) {
    tokUi.status.textContent = '';
    tokUi.progress.style.display = 'none';
    tokClear(tokUi.scanNotice);
    tokUi.rebuild.disabled = false;
    return;
  }
  const scanning = s.phase === 'backfill' || s.phase === 'catchup';
  const done = Number(s.done) || 0, total = Number(s.total) || 0;
  tokUi.rebuild.disabled = scanning;
  if (scanning) {
    tokUi.status.textContent = 'Scanning transcripts… ' + tokNum(done) + ' / ' + tokNum(total);
  } else {
    const at = s.lastScanMs ? ' · updated ' + tokClock(s.lastScanMs) : '';
    tokUi.status.textContent = 'Scanned ' + tokNum(tokFileCount(s)) + ' files' + at;
  }
  // The bar and the "totals are partial" notice are for the first full scan
  // only: a catch-up touches a handful of files and the totals are already whole.
  if (s.phase === 'backfill') {
    tokUi.progress.style.display = '';
    tokUi.progressFill.style.width = (total > 0 ? Math.min(100, Math.max(1, (done / total) * 100)) : 1) + '%';
    const want = 'Scanning transcripts (' + tokNum(done) + ' / ' + tokNum(total) + ' files). Totals are partial until the scan finishes.';
    const have = tokUi.scanNotice.firstChild;
    if (have) have.textContent = want; else tokNotice(tokUi.scanNotice, want);
  } else {
    tokUi.progress.style.display = 'none';
    tokClear(tokUi.scanNotice);
  }
}

// ── the load ────────────────────────────────────────────────────────────────

// Never throws and never rejects: loadStats() returns this promise to app.js,
// which does not catch.
async function loadTokenStats(opts) {
  try {
    await tokLoad(opts || {});
  } catch (err) {
    try { console.error('[token-stats] render failed', err); } catch {}
  }
}

async function tokLoad(opts) {
  const body = tokBody();
  if (!body) return;
  const quiet = !!opts.quiet && !!tokUi;
  if (quiet && tokInFlight) { tokStale = true; return; }

  const range = tokRangeFor(tokRange, new Date(), tokCustomFrom, tokCustomTo);
  if (!tokUi) tokUi = tokBuildSkeleton(body);
  tokSyncToolbar();
  if (!range) return;   // Custom with an incomplete day: keep what is showing

  const gen = ++tokGen, sessGen = ++tokSessGen, ctxGen = ++tokCtxGen;
  tokLastQueryMs = Date.now();
  tokInFlight = true;
  const ui = tokUi;
  if (!quiet) {
    // Each section gets its own spinner and replaces it on its own.
    tokSpinner(ui.headline, 'Loading token totals…');
    tokSpinner(ui.daily, 'Loading per-day usage…');
    tokSpinner(ui.models, 'Loading models…');
    tokSpinner(ui.sessions, 'Loading sessions…');
    if (tokSelected) tokSpinner(ui.context, 'Loading context history…');
    tokClear(ui.footer);
  }

  const q = { from: range.from, to: range.to };
  const settled = await Promise.allSettled([
    tokCall('getTokenStatsSummary', q),
    tokCall('getTokenStatsModels', q),
    tokCall('getTokenStatsDaily', q),
    tokCall('getTokenStatsSessions', { from: q.from, to: q.to, sort: tokSort, limit: tokLimit }),
    tokSelected ? tokCall('getTokenStatsContext', { sessionId: tokSelected }) : Promise.resolve(null),
  ]);
  if (gen === tokGen) tokInFlight = false;
  // A newer load owns the tab now; this response is history.
  if (gen !== tokGen || tokUi !== ui) return;

  const out = settled.map(tokOutcome);
  const off = out.slice(0, 4).find(o => o.kind === 'disabled');
  if (off) { tokRenderOff(body, off); return; }

  const firstOk = out.slice(0, 4).find(o => o.kind === 'ok' && o.data.scan);
  tokRenderScan(firstOk ? firstOk.data.scan : null);

  // One section failing to draw must not take the others with it.
  const draw = (fn) => { try { fn(); } catch (err) { try { console.error('[token-stats] section failed', err); } catch {} } };
  draw(() => tokRenderHeadline(ui.headline, out[0]));
  draw(() => tokRenderDailyOutcome(ui.daily, out[2]));
  draw(() => tokRenderModels(ui.models, out[1]));
  if (sessGen === tokSessGen) draw(() => tokRenderSessions(ui.sessions, out[3]));
  if (ctxGen === tokCtxGen) draw(() => tokRenderContext(ui.context, tokSelected ? out[4] : null));
  draw(() => tokRenderFooter(ui.footer, out[0]));

  if (tokStale) { tokStale = false; loadTokenStats({ quiet: true }); }
}

// The whole tab becomes one notice with one way back: Enable for the kill
// switch, Try again for a store that failed. `note` is what the last Try again
// came back with, shown on its own line under the reason.
function tokRenderOff(body, outcome, note) {
  tokUi = null;
  tokScan = null;
  tokDaily = null;
  tokHideTooltip();
  tokClear(body);
  const notice = tokEl('div', 'stats-refresh-error token-off');
  notice.setAttribute('role', 'status');
  // Untrusted text: the reason can carry a path or a driver message.
  notice.appendChild(tokEl('span', '', outcome.text));
  const action = outcome.action || (outcome.killSwitch ? 'enable' : 'retry');
  const btn = tokEl('button', 'token-btn', action === 'enable' ? 'Enable' : 'Try again');
  btn.type = 'button';
  if (action === 'enable') btn.addEventListener('click', tokEnable);
  else btn.addEventListener('click', () => tokRetry(body, notice, btn, outcome));
  notice.appendChild(btn);
  if (note) notice.appendChild(tokEl('div', 'token-off-note', note));
  body.appendChild(notice);
  tokOffNotice = notice;
}

// Try again: ask main to open the store again (enableTokenStats re-runs its
// init when no flag file is there). No confirm: nothing is deleted and nothing
// is switched on that the user switched off. Never throws; a failure is said
// in the notice and the button comes back, so it can be pressed again.
async function tokRetry(body, notice, btn, outcome) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Trying again…';
  const settled = (await Promise.allSettled([tokCall('enableTokenStats')]))[0];
  // The tab was redrawn while main was working (a sub-tab click, a change
  // event): that render is newer than this answer and owns the body now.
  if (tokOffNotice !== notice) return;
  const answer = tokOutcome(settled);
  if (answer.kind === 'ok') { await loadTokenStats(); return; }
  // Still off with a reason of its own: show that reason, and whichever
  // button it calls for.
  if (answer.kind === 'disabled') { tokRenderOff(body, answer, 'Try again did not work.'); return; }
  tokRenderOff(body, outcome, answer.kind === 'error' ? 'Try again failed: ' + answer.reason + '.' : answer.text);
}

// A toolbar action's own failure is said in the status text, in the same
// words the sections use.
async function tokAction(name, after) {
  const settled = (await Promise.allSettled([tokCall(name)]))[0];
  const outcome = tokOutcome(settled);
  if (outcome.kind === 'restart' || outcome.kind === 'error') {
    if (tokUi) tokUi.status.textContent = outcome.text;
    else { const body = tokBody(); if (body) tokNotice(body, outcome.text); }
    return;
  }
  if (after) after();
  await loadTokenStats();
}

function tokRebuild() {
  if (!tokConfirm('Rebuild token analytics?\n\nThe token store is emptied and every transcript is scanned again. Transcripts are only read. Totals are partial until the scan finishes.')) return;
  return tokAction('rescanTokenStats', () => { tokLimit = TOK_PAGE; });
}

function tokDisable() {
  if (!tokConfirm('Turn token analytics off?\n\nScanning stops and the Tokens tab shows nothing until it is enabled again. What has been counted is kept. No restart is needed.')) return;
  return tokAction('disableTokenStats');
}

function tokEnable() {
  if (!tokConfirm('Turn token analytics on?\n\nSwitchboard starts reading transcripts again and catches up in the background.')) return;
  return tokAction('enableTokenStats');
}

// Registered ONCE, at script load: a preload listener cannot be removed, so
// registering per render would stack one more listener on every tab click.
function tokOnChanged(info) {
  try {
    if (!info || typeof info !== 'object') return;
    if (!tokVisible() || !tokUi) return;
    tokRenderScan({ phase: info.phase, done: info.done, total: info.total });
    const idle = info.phase === 'idle';
    if (idle || Date.now() - tokLastQueryMs >= TOK_REQUERY_MS) loadTokenStats({ quiet: true });
  } catch (err) {
    try { console.error('[token-stats] change event failed', err); } catch {}
  }
}

// ── headline ────────────────────────────────────────────────────────────────

function tokCard(parent, value, label, title, extra) {
  const card = tokEl('div', 'stat-card');
  card.appendChild(tokEl('span', 'stat-card-value', value));
  card.appendChild(tokEl('span', 'stat-card-label', label));
  if (extra) card.appendChild(tokEl('span', 'token-card-note', extra));
  if (title) card.title = title;
  parent.appendChild(card);
  return card;
}

function tokRenderHeadline(container, outcome) {
  const data = tokGuard(container, outcome);
  if (!data) return;
  const t = data.totals || {};
  if (!(t.responses > 0)) { tokEmpty(container, 'No token usage in this range.'); return; }
  tokClear(container);
  const grid = tokEl('div', 'stats-summary token-headline');
  const k = data.byKind || {};
  const split = (field) => 'Main ' + tokNum((k.main || {})[field]) + ' · Subagents ' + tokNum((k.subagent || {})[field]) +
    ' · Workflow ' + tokNum((k.workflow || {})[field]);
  tokCard(grid, formatTokens(t.input), 'Input', tokNum(t.input) + ' tokens\n' + split('input'));
  tokCard(grid, formatTokens(t.output), 'Output', tokNum(t.output) + ' tokens\n' + split('output'));
  tokCard(grid, formatTokens(t.cache_write), 'Cache write', tokNum(t.cache_write) + ' tokens (5 m ' + tokNum(t.cache_write_5m) +
    ' · 1 h ' + tokNum(t.cache_write_1h) + ')\n' + split('cache_write'));
  tokCard(grid, formatTokens(t.cache_read), 'Cache read', tokNum(t.cache_read) + ' tokens\n' + split('cache_read'));

  const w = data.weighted || {};
  const version = w.pricesVersion || (data.scan && data.scan.pricesVersion) || 'unknown date';
  let tip = 'Weighted by API price ratios (input 1, output 5, cache write 1.25 / 2 for 5 m / 1 h, cache read 0.1; ' +
    '0.05 Opus 5.5, 0.025 Fable 5.1) as of ' + version + '. Not a bill.';
  const unpriced = Array.isArray(w.unpricedModels) ? w.unpricedModels : [];
  // Dollars live in the tooltip only. With an unpriced model in range the sum
  // is a floor, and it says so.
  if (typeof w.usd === 'number' && isFinite(w.usd)) {
    tip += unpriced.length
      ? '\nAt least ' + tokUsd(w.usd) + ' at list prices; no price for: ' + unpriced.join(', ') + '.'
      : '\nAbout ' + tokUsd(w.usd) + ' at list prices.';
  } else if (unpriced.length) {
    tip += '\nNo dollar estimate: no price for ' + unpriced.join(', ') + '.';
  }
  tokCard(grid, formatTokens(w.tokens), 'Weighted (est.)', tip).classList.add('token-card-weighted');
  tokCard(grid, tokNum(t.responses), 'Responses counted', tokNum(t.responses) + ' API responses, each counted once',
    t.unfinalized > 0 ? tokNum(t.unfinalized) + ' not finalised' : '').classList.add('token-card-narrow');
  container.appendChild(grid);
}

// ── per project and per day ─────────────────────────────────────────────────

function tokRenderDailyOutcome(container, outcome) {
  const data = tokGuard(container, outcome);
  tokDaily = data;
  if (data) tokRenderDaily(container, data);
}

function tokSeriesClass(colorIndex) {
  const i = Number(colorIndex);
  return Number.isInteger(i) && i >= 0 && i < TOK_SERIES_SLOTS ? 'token-s' + i : 'token-s-other';
}

function tokRenderDaily(container, data) {
  const cols = tokBucketDays(data.days, tokMeasure, TOK_MAX_COLUMNS, tokRange === 'all');
  // ONE common maximum for every column and every project.
  let max = 0;
  for (const col of cols) if (col.total > max) max = col.total;
  if (!cols.length || max <= 0) { tokEmpty(container, 'No token usage in this range.'); return; }

  tokClear(container);
  const wrap = tokEl('div', 'daily-chart-container token-daily');
  const unit = tokMeasure === 'raw' ? 'raw tokens' : 'weighted tokens (est.)';
  const perCol = cols[0].from === cols[0].to ? 'day' : 'column';
  tokTitle(wrap, 'Per project and per day · ' + unit + ' · peak ' + formatTokens(max) + ' / ' + perCol);

  const projects = Array.isArray(data.projects) ? data.projects : [];
  const series = projects.map(p => ({ slug: p.slug, label: p.label || p.projectPath || p.slug, cls: tokSeriesClass(p.colorIndex) }));
  const known = new Set(series.map(s => s.slug));
  const hasOther = cols.some(c => Object.keys(c.bySlug).some(slug => !known.has(slug) && c.bySlug[slug] > 0));
  if (hasOther) series.push({ slug: TOK_OTHER, label: 'Other', cls: 'token-s-other' });

  const chart = tokEl('div', 'daily-chart token-chart');
  const every = Math.max(1, Math.ceil(cols.length / 15));
  cols.forEach((col, i) => {
    const colEl = tokEl('div', 'daily-chart-col token-col');
    const values = series.map(s => {
      if (s.slug !== TOK_OTHER) return col.bySlug[s.slug] || 0;
      // Other is everything main folded plus any slug the legend does not know.
      let sum = 0;
      for (const slug of Object.keys(col.bySlug)) if (!known.has(slug)) sum += col.bySlug[slug];
      return sum;
    });
    // The stack's height is the column total on the common scale; segments
    // share it by flex-grow, so the 2px gaps come out of the stack and the
    // column still ends exactly at its total.
    const stack = tokEl('div', 'token-stack');
    stack.style.height = col.total > 0 ? Math.max((col.total / max) * 100, 2) + '%' : '0';
    series.forEach((s, si) => {
      if (!(values[si] > 0)) return;
      const seg = tokEl('div', 'token-seg ' + s.cls);
      seg.style.flexGrow = String(values[si]);
      stack.appendChild(seg);
    });
    colEl.appendChild(stack);

    const when = col.from === col.to ? tokDayLabel(col.from) : tokDayLabel(col.from) + ' – ' + tokDayLabel(col.to);
    const top = series.map((s, si) => ({ label: s.label, v: values[si] })).filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v).slice(0, 4).map(x => x.label + ': ' + formatTokens(x.v));
    colEl.title = [when, 'Total ' + formatTokens(col.total) + (tokMeasure === 'raw' ? ' raw' : ' weighted')].concat(top).join('\n');

    if (i % every === 0) {
      const day = Number(col.from.slice(8, 10));
      // The month is named on the first label and wherever it changes.
      const prev = i >= every ? cols[i - every].from.slice(0, 7) : '';
      colEl.appendChild(tokEl('div', 'daily-chart-label token-day-label',
        prev !== col.from.slice(0, 7) ? tokDayLabel(col.from) : String(day)));
    }
    chart.appendChild(colEl);
  });
  wrap.appendChild(chart);

  const legend = tokEl('div', 'daily-chart-legend token-legend');
  for (const s of series) {
    const item = tokEl('span', 'token-legend-item');
    item.appendChild(tokEl('span', 'daily-chart-legend-dot ' + s.cls));
    item.appendChild(tokEl('span', '', s.label));
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  container.appendChild(wrap);
}

// ── by token type and model ─────────────────────────────────────────────────

function tokCell(row, text, className, title) {
  const cell = tokEl('td', className || '', text);
  if (title) cell.title = title;
  row.appendChild(cell);
  return cell;
}

function tokRenderModels(container, outcome) {
  const data = tokGuard(container, outcome);
  if (!data) return;
  const models = Array.isArray(data.models) ? data.models : [];
  if (!models.length) { tokEmpty(container, 'No token usage in this range.'); return; }
  tokClear(container);
  const wrap = tokEl('div', 'token-block');
  tokTitle(wrap, 'By token type and model');

  const table = tokEl('table', 'token-table');
  const head = tokEl('tr');
  for (const [label, cls] of [['Model', ''], ['Input', 'num'], ['Output', 'num'], ['Cache write', 'num'], ['Cache read', 'num'],
    ['Responses', 'num'], ['Weighted', 'num'], ['Share of weighted', '']]) {
    const th = tokEl('th', cls, label);
    th.setAttribute('scope', 'col');
    head.appendChild(th);
  }
  const thead = tokEl('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const sum = { input: 0, output: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, responses: 0, weighted: 0 };
  for (const m of models) for (const key of Object.keys(sum)) sum[key] += Number(m[key]) || 0;

  const tbody = tokEl('tbody');
  const addRow = (label, m, share, isTotal) => {
    const tr = tokEl('tr', isTotal ? 'token-row-total' : '');
    tokCell(tr, label, 'token-model', isTotal ? '' : String(m.model || ''));
    tokCell(tr, formatTokens(m.input), 'num', tokNum(m.input));
    tokCell(tr, formatTokens(m.output), 'num', tokNum(m.output));
    tokCell(tr, formatTokens(m.cache_write), 'num', tokNum(m.cache_write) + ' (5 m ' + tokNum(m.cache_write_5m) + ' · 1 h ' + tokNum(m.cache_write_1h) + ')');
    tokCell(tr, formatTokens(m.cache_read), 'num', tokNum(m.cache_read));
    tokCell(tr, tokNum(m.responses), 'num', m.unfinalized > 0 ? tokNum(m.unfinalized) + ' not finalised' : '');
    tokCell(tr, formatTokens(m.weighted), 'num', tokNum(m.weighted) + ' weighted');
    const cell = tokEl('td', 'token-share');
    if (!isTotal) {
      const track = tokEl('div', 'usage-track');
      const fill = tokEl('div', 'usage-fill');
      fill.style.width = Math.min(100, Math.max(share * 100, share > 0 ? 1 : 0)) + '%';
      track.appendChild(fill);
      cell.appendChild(track);
      cell.appendChild(tokEl('span', 'token-share-pct', (share * 100).toFixed(1) + '%'));
    }
    tr.appendChild(cell);
    tbody.appendChild(tr);
  };
  // The share is recomputed here from the weighted column, so the bar cannot
  // disagree with the number beside it.
  for (const m of models) addRow(m.label || m.model || 'unknown', m, sum.weighted > 0 ? (Number(m.weighted) || 0) / sum.weighted : 0, false);
  addRow('All models', sum, 1, true);
  table.appendChild(tbody);
  wrap.appendChild(table);

  const byType = data.byType || sum;
  const types = [['Input', byType.input], ['Output', byType.output], ['Cache write', byType.cache_write], ['Cache read', byType.cache_read]];
  const rawTotal = types.reduce((a, t) => a + (Number(t[1]) || 0), 0);
  if (rawTotal > 0) {
    const grid = tokEl('div', 'stats-summary token-types');
    for (const [label, value] of types) {
      const pct = ((Number(value) || 0) / rawTotal) * 100;
      tokCard(grid, pct.toFixed(1) + '%', label, formatTokens(value) + ' of ' + formatTokens(rawTotal) + ' raw tokens');
    }
    wrap.appendChild(tokEl('div', 'token-subtitle', 'Share of raw tokens by type'));
    wrap.appendChild(grid);
  }
  container.appendChild(wrap);
}

// ── per session ─────────────────────────────────────────────────────────────

// Sort keys are the handlers' allowlist; only columns that have one are
// clickable. The handlers sort descending, so there is one glyph.
const TOK_SESSION_COLUMNS = [
  { label: 'Session', cls: '' },
  { label: 'Last active', cls: 'num', sort: 'last_ts' },
  { label: 'Main', cls: 'num' },
  { label: 'Subagents', cls: 'num' },
  { label: 'Workflow', cls: 'num' },
  { label: 'Weighted', cls: 'num', sort: 'weighted' },
  { label: 'Peak ctx', cls: 'num', sort: 'peak_ctx' },
  { label: 'Compactions', cls: 'num' },
];

function tokWhen(ts) {
  const d = new Date(ts);
  if (ts === null || ts === undefined || isNaN(d.getTime())) return '';
  try { if (typeof formatDate === 'function') return formatDate(d); } catch {}
  return tokDateTime(d.getTime());
}

function tokGroupTitle(g, extra) {
  if (!g) return '';
  return 'in ' + tokNum(g.input) + ' · out ' + tokNum(g.output) + ' · cache write ' + tokNum(g.cache_write) +
    ' · cache read ' + tokNum(g.cache_read) + (g.responses !== undefined ? '\n' + tokNum(g.responses) + ' responses' : '') + (extra || '');
}

function tokGroupText(g) {
  return g && g.weighted > 0 ? formatTokens(g.weighted) : '–';
}

async function tokReloadSessions() {
  if (!tokUi) return;
  const ui = tokUi;
  const range = tokRangeFor(tokRange, new Date(), tokCustomFrom, tokCustomTo);
  if (!range) return;
  const sessGen = ++tokSessGen;
  const settled = (await Promise.allSettled([
    tokCall('getTokenStatsSessions', { from: range.from, to: range.to, sort: tokSort, limit: tokLimit }),
  ]))[0];
  if (sessGen !== tokSessGen || tokUi !== ui) return;
  const outcome = tokOutcome(settled);
  if (outcome.kind === 'disabled') { const body = tokBody(); if (body) tokRenderOff(body, outcome); return; }
  try { tokRenderSessions(ui.sessions, outcome); } catch (err) { try { console.error('[token-stats] sessions failed', err); } catch {} }
}

function tokRenderSessions(container, outcome) {
  const data = tokGuard(container, outcome);
  if (!data) return;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) { tokEmpty(container, 'No sessions in this range.'); return; }
  tokClear(container);
  const wrap = tokEl('div', 'token-block');
  const total = Number(data.total) || rows.length;
  tokTitle(wrap, 'Per session · ' + tokNum(rows.length) + ' of ' + tokNum(total));

  const table = tokEl('table', 'token-table token-sessions');
  const head = tokEl('tr');
  for (const col of TOK_SESSION_COLUMNS) {
    const th = tokEl('th', col.cls);
    th.setAttribute('scope', 'col');
    if (col.sort) {
      const active = tokSort === col.sort;
      const btn = tokEl('button', 'token-sort' + (active ? ' active' : ''), col.label + (active ? ' ▾' : ''));
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (tokSort === col.sort) return;
        tokSort = col.sort;
        tokLimit = TOK_PAGE;
        tokReloadSessions();
      });
      th.appendChild(btn);
      th.setAttribute('aria-sort', active ? 'descending' : 'none');
    } else {
      th.textContent = col.label;
    }
    head.appendChild(th);
  }
  const thead = tokEl('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = tokEl('tbody');
  for (const r of rows) {
    const tr = tokEl('tr', 'token-session-row' + (r.sessionId === tokSelected ? ' selected' : ''));
    tr.tabIndex = 0;
    const select = () => tokSelectSession(r.sessionId);
    tr.addEventListener('click', select);
    tr.addEventListener('keydown', (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { if (e.preventDefault) e.preventDefault(); select(); } });

    const first = tokEl('td', 'token-session-cell');
    const name = tokEl('div', 'token-session-title');
    if (r.isRunning) {
      const dot = tokEl('span', 'token-running');
      dot.title = 'Running';
      dot.setAttribute('aria-label', 'Running');
      name.appendChild(dot);
    }
    // Untrusted text: the title is whatever the transcript or the user holds.
    name.appendChild(tokEl('span', '', r.title || String(r.sessionId || '').slice(0, 8)));
    first.appendChild(name);
    first.appendChild(tokEl('div', 'token-session-slug', r.projectPath || r.slug || ''));
    first.title = String(r.sessionId || '') + (Array.isArray(r.models) && r.models.length ? '\n' + r.models.join(', ') : '');
    tr.appendChild(first);

    tokCell(tr, tokWhen(r.lastTs), 'num', tokDateTime(r.lastTs));
    tokCell(tr, tokGroupText(r.main), 'num', tokGroupTitle(r.main));
    const sub = r.subagents || {};
    tokCell(tr, tokGroupText(sub), 'num', tokGroupTitle(sub, sub.agents !== undefined ? ' · ' + tokNum(sub.agents) + ' agents' : ''));
    const wf = r.workflow || {};
    tokCell(tr, tokGroupText(wf), 'num', tokGroupTitle(wf, (wf.agents !== undefined ? ' · ' + tokNum(wf.agents) + ' agents' : '') +
      (wf.workflows !== undefined ? ' · ' + tokNum(wf.workflows) + ' workflows' : '')));
    tokCell(tr, formatTokens(r.weighted), 'num token-strong',
      tokNum(r.weighted) + ' weighted' + (r.unfinalized > 0 ? '\n' + tokNum(r.unfinalized) + ' responses not finalised (output is a lower bound)' : ''));
    tokCell(tr, r.peakContext > 0 ? formatTokens(r.peakContext) : '–', 'num', tokNum(r.peakContext) + ' tokens in context at the largest response');
    tokCell(tr, r.compactions > 0 ? tokNum(r.compactions) : '–', 'num');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (rows.length < total && tokLimit < TOK_MAX_LIMIT) {
    const more = tokEl('button', 'token-btn token-more', 'Show more');
    more.type = 'button';
    more.addEventListener('click', () => {
      tokLimit = Math.min(TOK_MAX_LIMIT, tokLimit + TOK_PAGE);
      more.disabled = true;
      tokReloadSessions();
    });
    wrap.appendChild(more);
  }
  container.appendChild(wrap);
}

async function tokSelectSession(sessionId) {
  if (!tokUi || !sessionId) return;
  const ui = tokUi;
  tokSelected = sessionId;
  const ctxGen = ++tokCtxGen;
  tokSpinner(ui.context, 'Loading context history…');
  const settled = (await Promise.allSettled([tokCall('getTokenStatsContext', { sessionId })]))[0];
  if (ctxGen !== tokCtxGen || tokUi !== ui) return;
  const outcome = tokOutcome(settled);
  if (outcome.kind === 'disabled') { const body = tokBody(); if (body) tokRenderOff(body, outcome); return; }
  try {
    tokRenderContext(ui.context, outcome);
    if (typeof ui.context.scrollIntoView === 'function') ui.context.scrollIntoView({ block: 'nearest' });
  } catch (err) { try { console.error('[token-stats] context failed', err); } catch {} }
}

// ── context over time ───────────────────────────────────────────────────────

function tokTooltip() {
  if (tokTooltipEl) return tokTooltipEl;
  tokTooltipEl = tokEl('div', 'token-tooltip');
  tokTooltipEl.style.display = 'none';
  document.body.appendChild(tokTooltipEl);
  return tokTooltipEl;
}

function tokHideTooltip() {
  if (tokTooltipEl) tokTooltipEl.style.display = 'none';
}

function tokRenderContext(container, outcome) {
  tokHideTooltip();
  if (!outcome) { tokEmpty(container, 'Select a session to see its context over time.'); return; }
  const data = tokGuard(container, outcome);
  if (!data) return;
  tokClear(container);
  const wrap = tokEl('div', 'token-block token-context');
  tokTitle(wrap, 'Context over time · ' + (data.title || String(data.sessionId || '').slice(0, 8)));

  const points = (Array.isArray(data.points) ? data.points : []).filter(p => p && isFinite(p.t) && isFinite(p.ctx));
  const compactions = (Array.isArray(data.compactions) ? data.compactions : []).filter(c => c && isFinite(c.t));
  const handoffs = (Array.isArray(data.handoffs) ? data.handoffs : []).filter(h => h && isFinite(h.t));
  if (!points.length) {
    wrap.appendChild(tokEl('div', 'plans-empty token-empty', 'This session has no responses of its own to chart.'));
    container.appendChild(wrap);
    return;
  }

  const W = 900, H = 260, L = 56, R = 16, T = 22, B = 28;
  const plotW = W - L - R, plotH = H - T - B;
  let t0 = points[0].t, t1 = points[points.length - 1].t;
  for (const m of compactions.concat(handoffs)) { if (m.t < t0) t0 = m.t; if (m.t > t1) t1 = m.t; }
  if (t1 - t0 < 60000) { t0 -= 1800000; t1 += 1800000; }   // one response: give it an hour to sit in
  const win = Number(data.contextWindow) > 0 ? Number(data.contextWindow) : 0;
  let yMax = win;
  for (const p of points) if (p.ctx > yMax) yMax = p.ctx;
  for (const c of compactions) if (c.pre > yMax) yMax = c.pre;
  if (!(yMax > 0)) yMax = 200000;
  const sx = (t) => L + ((t - t0) / (t1 - t0)) * plotW;
  const sy = (v) => T + plotH - (Math.max(0, Math.min(v, yMax)) / yMax) * plotH;

  const svg = tokSvg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'token-ctx-svg', role: 'img' });
  svg.setAttribute('aria-label', 'Context tokens over time: ' + points.length + ' responses, peak ' +
    formatTokens(points.reduce((a, p) => Math.max(a, p.ctx), 0)));

  // Grid and axes: recessive, drawn first.
  for (const v of tokYTicks(yMax)) {
    const y = sy(v).toFixed(1);
    svg.appendChild(tokSvg('line', { x1: L, x2: W - R, y1: y, y2: y, class: v === 0 ? 'token-ctx-axis' : 'token-ctx-grid' }));
    svg.appendChild(tokSvg('text', { x: L - 8, y: Number(y) + 3, class: 'token-ctx-tick', 'text-anchor': 'end' }, formatTokens(v)));
  }
  for (const tick of tokXTicks(t0, t1)) {
    const x = sx(tick.t).toFixed(1);
    svg.appendChild(tokSvg('line', { x1: x, x2: x, y1: T + plotH, y2: T + plotH + 4, class: 'token-ctx-axis' }));
    svg.appendChild(tokSvg('text', { x, y: H - 8, class: 'token-ctx-tick', 'text-anchor': 'middle' }, tick.label));
  }

  // Reference lines, labelled in place so they need no legend entry.
  const refs = [];
  if (TOK_HANDOFF_TRIGGER <= yMax && TOK_HANDOFF_TRIGGER !== win) refs.push([TOK_HANDOFF_TRIGGER, 'handoff trigger ' + formatTokens(TOK_HANDOFF_TRIGGER)]);
  if (win > 0) refs.push([win, 'context window ' + formatTokens(win)]);
  for (const [v, label] of refs) {
    const y = sy(v);
    svg.appendChild(tokSvg('line', { x1: L, x2: W - R, y1: y.toFixed(1), y2: y.toFixed(1), class: 'token-ctx-ref' }));
    // Above the line, or below it when the line is the top of the plot.
    svg.appendChild(tokSvg('text', { x: W - R - 4, y: (y - T < 12 ? y + 11 : y - 4).toFixed(1), class: 'token-ctx-ref-label', 'text-anchor': 'end' }, label));
  }

  // Compactions: where the context was cut. The drop is the fact; the label
  // says by how much. Labels are skipped when they would sit on each other;
  // every mark keeps its tooltip.
  let lastLabelX = -Infinity;
  for (const c of compactions) {
    const x = sx(c.t);
    const g = tokSvg('g', { class: 'token-ctx-compaction' });
    const text = formatTokens(c.pre) + ' → ' + formatTokens(c.post);
    g.appendChild(tokSvg('title', {}, 'Compaction' + (c.trigger ? ' (' + c.trigger + ')' : '') + ' at ' + tokDateTime(c.t) + ': ' + text));
    g.appendChild(tokSvg('line', { x1: x.toFixed(1), x2: x.toFixed(1), y1: T, y2: T + plotH, class: 'token-ctx-compaction-line' }));
    if (isFinite(c.pre) && isFinite(c.post)) {
      g.appendChild(tokSvg('line', { x1: x.toFixed(1), x2: x.toFixed(1), y1: sy(c.pre).toFixed(1), y2: sy(c.post).toFixed(1), class: 'token-ctx-compaction-drop' }));
      if (x - lastLabelX >= 84) {
        const right = x + 90 > W - R;
        g.appendChild(tokSvg('text', { x: (right ? x - 4 : x + 4).toFixed(1), y: T - 8, class: 'token-ctx-mark-label', 'text-anchor': right ? 'end' : 'start' }, text));
        lastLabelX = x;
      }
    }
    svg.appendChild(g);
  }

  // The series itself.
  svg.appendChild(tokSvg('path', { d: tokStepPath(points, sx, sy), class: 'token-ctx-line', fill: 'none' }));
  if (points.length < 300) {
    for (const p of points) svg.appendChild(tokSvg('circle', { cx: sx(p.t).toFixed(1), cy: sy(p.ctx).toFixed(1), r: 2, class: 'token-ctx-point' }));
  }

  // Handoffs: when a handoff file was written, and at what context size.
  for (const h of handoffs) {
    const x = sx(h.t), consumed = !!h.consumedBy;
    const g = tokSvg('g', { class: 'token-ctx-handoff' + (consumed ? ' consumed' : '') });
    g.appendChild(tokSvg('title', {}, 'Handoff written at ' + tokDateTime(h.t) +
      (isFinite(h.tokens) && h.tokens > 0 ? ' with ' + formatTokens(h.tokens) + ' in context' : '') +
      (consumed ? ' · consumed by ' + h.consumedBy : '')));
    g.appendChild(tokSvg('line', { x1: x.toFixed(1), x2: x.toFixed(1), y1: T, y2: T + plotH, class: 'token-ctx-handoff-line' }));
    if (isFinite(h.tokens) && h.tokens > 0) {
      const y = sy(h.tokens);
      // A tick, on a ring of the surface colour so it stays legible on the line.
      g.appendChild(tokSvg('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 7, class: 'token-ctx-handoff-ring' }));
      g.appendChild(tokSvg('path', { d: 'M' + (x - 3.5).toFixed(1) + ' ' + y.toFixed(1) + 'l2.5 2.5l4.5 -5', class: 'token-ctx-handoff-tick', fill: 'none' }));
    }
    svg.appendChild(g);
  }

  // Hover layer: one crosshair, one marker, one tooltip, all reused.
  const cross = tokSvg('line', { y1: T, y2: T + plotH, class: 'token-ctx-cross' });
  const marker = tokSvg('circle', { r: 4, class: 'token-ctx-marker' });
  cross.style.display = 'none';
  marker.style.display = 'none';
  svg.appendChild(cross);
  svg.appendChild(marker);
  const hide = () => { cross.style.display = 'none'; marker.style.display = 'none'; tokHideTooltip(); };
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect || !(rect.width > 0)) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = tokNearestIndex(points, t0 + ((vx - L) / plotW) * (t1 - t0));
    if (i < 0) return;
    const p = points[i], x = sx(p.t).toFixed(1);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    marker.setAttribute('cx', x);
    marker.setAttribute('cy', sy(p.ctx).toFixed(1));
    cross.style.display = '';
    marker.style.display = '';
    const tip = tokTooltip();
    tokClear(tip);
    tip.appendChild(tokEl('div', 'token-tooltip-head', tokDateTime(p.t)));
    tip.appendChild(tokEl('div', '', 'Context ' + formatTokens(p.ctx) + ' (' + tokNum(p.ctx) + ')'));
    tip.appendChild(tokEl('div', '', 'Output ' + formatTokens(p.out) + (p.fin === 0 || p.fin === false ? ' (not finalised)' : '')));
    if (data.model) tip.appendChild(tokEl('div', 'token-tooltip-dim', data.model));
    tip.style.display = '';
    const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200;
    tip.style.left = Math.max(8, Math.min(e.clientX + 14, vw - 240)) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  svg.addEventListener('mouseleave', hide);
  wrap.appendChild(svg);

  const parts = [tokNum(points.length) + ' responses', tokNum(compactions.length) + ' compactions', tokNum(handoffs.length) + ' handoffs'];
  if (data.downsampled) parts.push('down-sampled');
  wrap.appendChild(tokEl('div', 'token-caption', parts.join(' · ')));
  container.appendChild(wrap);
}

// ── footer ──────────────────────────────────────────────────────────────────

function tokRenderFooter(container, outcome) {
  tokClear(container);
  if (outcome.kind !== 'ok') return;   // the sections above already say why
  const data = outcome.data;
  const scan = data.scan || tokScan || {};
  const version = (data.weighted && data.weighted.pricesVersion) || scan.pricesVersion || 'an unknown date';
  const unfin = (data.totals && data.totals.unfinalized) || 0;
  const notice = tokEl('div', 'stats-notice token-footer-text',
    'Each API response is counted once (deduplicated by message id across resumed and forked sessions; copied history ' +
    'belongs to the original session). Weighted total is an estimate using API price ratios as of ' + version +
    ' — not a bill. Output is a lower bound: ' + tokNum(unfin) + ' responses never recorded a final count. ' +
    'Days follow this machine’s clock. Scanned ' + tokNum(tokFileCount(scan)) + ' files, last update ' +
    (scan.lastScanMs ? tokDateTime(scan.lastScanMs) : 'not yet') + '.');
  container.appendChild(notice);
  if (scan.filesMissing > 0) {
    container.appendChild(tokEl('div', 'stats-notice token-footer-text',
      tokNum(scan.filesMissing) + ' transcript files are no longer on disk; their history is kept.'));
  }
}

// ── script load ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && window.api && typeof window.api.onTokenStatsChanged === 'function') {
  try { window.api.onTokenStatsChanged(tokOnChanged); } catch (err) { try { console.error('[token-stats] listener failed', err); } catch {} }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TOK_NEEDS_RESTART, TOK_ALL_FROM,
    formatTokens, tokNum, tokDayKey, tokParseDay, tokDayLabel, tokRangeFor, tokOutcome, tokOffAction, tokFileCount,
    tokNearestIndex, tokStepPath, tokBucketDays, tokYTicks, tokXTicks, tokCounterValue,
  };
}
