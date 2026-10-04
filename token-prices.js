const fs = require('fs');
const path = require('path');

/**
 * Price table and weighting for the token analytics (design section 5).
 *
 * The headline number is "input-token equivalents": every counter expressed as
 * the number of base input tokens that cost the same. It is an estimate shown
 * next to the four raw counters, never a bill.
 *
 * Exports (build contract 6.2):
 *   loadPriceTable([filePath])  -> { version, models: { <id>: { baseUsd, read, ... } } }
 *   normalizeModel(id)          -> lower-cased id without a trailing -YYYYMMDD
 *   weightsFor(model, [table])  -> { input, output, write5m, write1h, read, baseUsd, priced }
 *   weightedTokens(row, [w])    -> number (row uses the DB column names)
 *   estimateUsd(weighted, w)    -> number, or null when the model has no price
 *
 * Nothing here does I/O at require time and nothing here throws: the Tokens tab
 * must still show its counters when the price file is missing or hand-edited
 * into something broken.
 */

// Ratios to base input that hold for every model in the table (design 5.1).
// Only the cache-read ratio and the base price vary by model, so only those
// two are required in a token-prices.json row.
const DEFAULT_RATIOS = Object.freeze({
  input: 1,
  output: 5,
  write5m: 1.25,
  write1h: 2,
  read: 0.1,
});

const UNAVAILABLE_VERSION = 'unavailable';
const DEFAULT_FILE = path.join(__dirname, 'token-prices.json');

// One entry per file path: { mtimeMs, size, table }. Keyed by path because the
// tests load their own files; the app only ever loads DEFAULT_FILE.
const cache = new Map();

function fallbackTable() {
  // No rows: every model resolves to the model-independent ratios, unpriced.
  return deepFreeze({ version: UNAVAILABLE_VERSION, models: {} });
}

function deepFreeze(obj) {
  // The cached table is handed to every caller, so one caller's mutation would
  // silently change everyone's prices until the next file edit.
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

function isPositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isRatio(n) {
  // A ratio of 0 is allowed (a counter that is free); negative or NaN is not.
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Turn parsed JSON into a table, or null when it is not one. A bad row is
 * dropped rather than failing the file: that model then shows as unpriced,
 * which the UI states, instead of being weighted with a nonsense number.
 */
function sanitizeTable(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.version !== 'string' || !parsed.version) return null;
  const src = parsed.models;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;

  const models = {};
  for (const key of Object.keys(src)) {
    const row = src[key];
    if (!row || typeof row !== 'object') continue;
    if (!isRatio(row.read)) continue;
    const out = { baseUsd: isPositive(row.baseUsd) ? row.baseUsd : null, read: row.read };
    for (const k of ['output', 'write5m', 'write1h']) {
      if (isRatio(row[k])) out[k] = row[k];
    }
    // Keys are normalised the same way lookups are, so a row written with a
    // dated id or in upper case is still found.
    models[normalizeModel(key)] = out;
  }
  return { version: parsed.version, models };
}

/**
 * Read the price table. Cached by mtime (and size, for two edits inside one
 * mtime tick), so a price edit is picked up at the next query with no restart
 * and an unchanged file costs one stat. Never throws.
 */
function loadPriceTable(filePath) {
  const file = typeof filePath === 'string' && filePath ? filePath : DEFAULT_FILE;
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.table;

    let table = null;
    try {
      table = sanitizeTable(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      table = null;
    }
    // A broken file is cached too, so it is not re-parsed on every query; the
    // next save changes the mtime and it is read again.
    const result = table ? deepFreeze(table) : fallbackTable();
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, table: result });
    return result;
  } catch {
    // Missing or unreadable. Not cached: there is no mtime to key on, and the
    // file may appear later.
    cache.delete(file);
    return fallbackTable();
  }
}

/**
 * Transcripts carry both the alias and the dated snapshot of the same model
 * (claude-haiku-4-5 and claude-haiku-4-5-20251001). Strip a trailing eight
 * digit date so both land on one row. Only eight digits: a version suffix such
 * as the "-5" of claude-opus-5-5 must survive.
 */
function normalizeModel(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase().replace(/-\d{8}$/, '');
}

/**
 * Weights for one model. An unknown model still gets the model-independent
 * ratios (read 0.1) so the weighted figure is always computable; only its USD
 * is unknown (baseUsd null, priced false) and the caller lists it as unpriced
 * (design 5.3).
 */
function weightsFor(model, table) {
  const t = table && typeof table === 'object' ? table : loadPriceTable();
  const models = t && t.models && typeof t.models === 'object' ? t.models : {};
  const key = normalizeModel(model);
  // hasOwnProperty, not a plain lookup: a model id of "constructor" must not
  // resolve to Object.prototype.
  const row = key && Object.prototype.hasOwnProperty.call(models, key) ? models[key] : null;
  const usable = row && typeof row === 'object' && isRatio(row.read);

  if (!usable) {
    return { ...DEFAULT_RATIOS, baseUsd: null, priced: false };
  }
  const baseUsd = isPositive(row.baseUsd) ? row.baseUsd : null;
  return {
    input: DEFAULT_RATIOS.input,
    output: isRatio(row.output) ? row.output : DEFAULT_RATIOS.output,
    write5m: isRatio(row.write5m) ? row.write5m : DEFAULT_RATIOS.write5m,
    write1h: isRatio(row.write1h) ? row.write1h : DEFAULT_RATIOS.write1h,
    read: row.read,
    baseUsd,
    // A row with ratios but no usable base price weights correctly and has no
    // dollar figure, the same as an unknown model.
    priced: baseUsd !== null,
  };
}

function count(n) {
  // Counters come from SQLite sums: a NULL sum (no rows) must weigh as 0, not NaN.
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Weighted total for one row or one per-model sum, in input-token equivalents.
 * There is no remainder term for cache_write: the parser normalises the split
 * so cache_write_5m + cache_write_1h = cache_write on every row (design 5.1),
 * and adding cache_write here would count those tokens twice.
 */
function weightedTokens(row, w) {
  const r = row && typeof row === 'object' ? row : {};
  const k = w && typeof w === 'object' ? w : DEFAULT_RATIOS;
  return count(r.input) * count(k.input)
    + count(r.output) * count(k.output)
    + count(r.cache_write_5m) * count(k.write5m)
    + count(r.cache_write_1h) * count(k.write1h)
    + count(r.cache_read) * count(k.read);
}

/**
 * Dollars for a weighted total of ONE model: weighted input-equivalents times
 * that model's base input price per million. Returns null when the model has
 * no price, so the caller can show ">=" and name it instead of adding zero.
 */
function estimateUsd(weighted, w) {
  if (!w || typeof w !== 'object' || !isPositive(w.baseUsd)) return null;
  if (typeof weighted !== 'number' || !Number.isFinite(weighted)) return null;
  return weighted * w.baseUsd / 1e6;
}

module.exports = {
  loadPriceTable,
  normalizeModel,
  weightsFor,
  weightedTokens,
  estimateUsd,
  DEFAULT_RATIOS,
  UNAVAILABLE_VERSION,
};
