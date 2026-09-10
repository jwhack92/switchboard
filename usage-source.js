// usage-source.js — one shared, fail-closed reader for Claude usage.
//
// Replaces the per-window `get-usage` poll (public/app.js refreshQuotaGauge,
// every 5 min in EVERY window) with a single cached read, and fixes three
// things the old path could not express:
//
//   1. It never says "0%" when it means "I don't know." Every read returns a
//      three-state verdict — ok | blocked | unknown — and there is no branch in
//      which the absence of a number produces a number.
//   2. It keeps `extra_usage` and `spend`. claude-auth.js fetches the whole body
//      (claude-auth.js:183) and transformUsageResponse (:131-158) copies only the
//      utilization buckets, discarding exactly the fields that say whether
//      crossing the limit bills. On an account where the member dashboard is
//      unavailable, this is the only place that state can be seen.
//   3. It reads buckets OPENLY. The per-model top-level keys already went null
//      once and the live data moved into `limits[]` (see the note above
//      mapLimits in claude-auth.js). Rather than hardcode a key list that has to
//      be edited every time that happens, walk every top-level object carrying a
//      numeric `utilization` and every `limits[]` row carrying a `percent`.
//
// Every effectful dependency is injected so the whole thing is testable with no
// network, no clock, and no credentials file.

const crypto = require('crypto');

// ---------------------------------------------------------------- constants

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// How long a reading may be served from cache before a refresh is attempted.
const DEFAULT_TTL_MS = 240_000;

// Hard staleness gate. A reading older than this is never returned as `ok`,
// for any reason, including "the refresh failed and we still have the old one."
// Anything acting on usage must fail closed rather than act on a stale number.
const DEFAULT_MAX_AGE_MS = 90_000;

const REQUEST_TIMEOUT_MS = 10_000;

// 429 backoff ladder. Index by consecutive 429 count, clamped to the last entry.
const RATE_LIMIT_LADDER_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

// `disabled_reason` values that mean overage genuinely cannot bill. Anything
// else — including an unrecognised string — is treated as "can bill".
const BENIGN_DISABLED_REASONS = new Set([
  'out_of_credits',
  'org_level_disabled',
  'org_level_disabled_until',
  'org_spend_cap_reached',
  'org_service_level_disabled',
]);

// ---------------------------------------------------------------- injection

let _fetch = (...a) => globalThis.fetch(...a);
let _now = () => Date.now();
let _getCredentials = null; // set by init(); defaults to claude-auth's reader
let _log = console;
let _ttlMs = DEFAULT_TTL_MS;

/**
 * @param {object} [ctx]
 * @param {Function} [ctx.fetchImpl]      stand-in for global fetch
 * @param {Function} [ctx.now]            stand-in for Date.now
 * @param {Function} [ctx.getCredentials] () => { accessToken, expiresAt, ... } | null
 * @param {object}   [ctx.log]
 * @param {number}   [ctx.ttlMs]
 */
function init(ctx = {}) {
  if (ctx.fetchImpl) _fetch = ctx.fetchImpl;
  if (ctx.now) _now = ctx.now;
  if (ctx.getCredentials) _getCredentials = ctx.getCredentials;
  if (ctx.log) _log = ctx.log;
  if (typeof ctx.ttlMs === 'number') _ttlMs = ctx.ttlMs;
  reset();
}

/** Drop all cached state. Exposed for tests and for a forced re-read. */
function reset() {
  _cache = null;
  _inFlight = null;
  _consecutive429 = 0;
  _blockedUntilMs = 0;
  _schemaFingerprint = null;
}

let _cache = null;          // { verdict, fetchedAtMs }
let _inFlight = null;       // Promise, so N callers share one request
let _consecutive429 = 0;
let _blockedUntilMs = 0;    // do not attempt a request before this instant
let _schemaFingerprint = null;

function credentials() {
  if (_getCredentials) return _getCredentials();
  // Lazy require so tests can init() without claude-auth touching the disk.
  return require('./claude-auth').getOAuthToken();
}

// ---------------------------------------------------------------- verdicts

function unknown(reason, extra = {}) {
  return { kind: 'unknown', reason, ...extra };
}

/**
 * Walk every top-level object carrying a numeric `utilization`, plus every
 * `limits[]` row carrying a numeric `percent`. Deliberately open: a limit that
 * migrates to a bucket nobody has heard of is still seen and still counted.
 */
function readBuckets(body) {
  const buckets = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const u = value.utilization;
    if (typeof u !== 'number' || !Number.isFinite(u)) continue;
    buckets.push({
      key,
      source: 'top-level',
      percent: u,
      resetsAt: value.resets_at || null,
      resetsAtMs: parseInstant(value.resets_at),
      lockedReason: value.locked_reason || null,
    });
  }
  const rows = Array.isArray(body?.limits) ? body.limits : [];
  for (const row of rows) {
    if (!row) continue;
    const p = row.percent;
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    buckets.push({
      key: row.kind || 'limits[]',
      source: 'limits',
      percent: p,
      resetsAt: row.resets_at || null,
      resetsAtMs: parseInstant(row.resets_at),
      severity: row.severity || 'normal',
      model: row.scope?.model?.display_name || null,
    });
  }
  return buckets;
}

/**
 * Parse an ISO instant to epoch ms, or null.
 *
 * Returning null rather than NaN matters: NaN !== NaN, so a NaN reset instant
 * used as a window key makes every comparison report "new window" on every
 * single tick. Callers must treat null as "no usable reset instant".
 */
function parseInstant(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Stable fingerprint of the response's top-level shape, for drift detection. */
function fingerprint(body) {
  const keys = Object.keys(body || {}).sort().join(',');
  return crypto.createHash('sha256').update(keys).digest('hex').slice(0, 16);
}

/** Does this payload say that exceeding the plan limit costs money? */
function readBilling(body) {
  const eu = body?.extra_usage || null;
  const sp = body?.spend || null;

  const disabledReason = eu?.disabled_reason || null;

  // Only conclude "cannot bill" from evidence we fully understand. That needs
  // BOTH an explicit is_enabled:false AND a reason we recognise (or none) —
  // an unrecognised reason means we do not know what state this account is in,
  // and not knowing is not the same as being safe. Absent `extra_usage`
  // likewise counts as billable.
  const explicitlyOff = eu?.is_enabled === false;
  const reasonRecognised = !disabledReason || BENIGN_DISABLED_REASONS.has(disabledReason);
  const canBill = eu ? !(explicitlyOff && reasonRecognised) : true;

  const caps = [eu?.monthly_limit, sp?.limit, sp?.cap].filter(
    v => typeof v === 'number' && Number.isFinite(v)
  );

  return {
    canBill,
    capVisible: caps.length > 0,
    caps,
    spendLimitReached: eu?.spend_limit_reached === true,
    disabledReason,
    canToggle: sp?.can_toggle === true,
    dashboardAvailable: body?.member_dashboard_available === true,
    // Reported, never trusted as a halt trigger on its own: whether this field
    // moves on Team-plan overage is unverified and unresolvable from an account
    // whose member dashboard is unavailable.
    spentMinor: typeof sp?.used?.amount_minor === 'number' ? sp.used.amount_minor : null,
    spentExponent: typeof sp?.used?.exponent === 'number' ? sp.used.exponent : 2,
    severity: sp?.severity || null,
    raw: { extraUsage: eu, spend: sp },
  };
}

function buildVerdict(body, fetchedAtMs, requestId) {
  const buckets = readBuckets(body);
  const fiveHour = buckets.find(b => b.key === 'five_hour' && b.source === 'top-level')
    || buckets.find(b => b.key === 'session');

  // five_hour is the window everything is timed against. Without a parseable
  // reset instant there is no window key, so there is no honest verdict.
  if (!fiveHour) return unknown('no_five_hour', { fetchedAtMs });
  if (fiveHour.resetsAtMs === null) return unknown('no_reset_instant', { fetchedAtMs });

  const billing = readBilling(body);

  const fp = fingerprint(body);
  const schemaChanged = _schemaFingerprint !== null && _schemaFingerprint !== fp;
  _schemaFingerprint = fp;

  const percents = {};
  for (const b of buckets) {
    // Math.floor matches how the existing gauge reads (claude-auth.js:92) —
    // note this means 99.9 reads as 99, which is why thresholds leave headroom.
    percents[b.key] = Math.floor(b.percent);
  }

  const maxPercent = buckets.reduce((m, b) => Math.max(m, b.percent), 0);
  const anyLocked = buckets.some(b => b.lockedReason);
  const abnormalSeverity = buckets.some(b => b.severity && b.severity !== 'normal');

  const base = {
    buckets,
    percents,
    // The untouched response. main.js rebuilds the legacy `get-usage` shape
    // from this via claude-auth.transformUsageResponse, so adding the driver's
    // richer verdict costs no extra HTTP request.
    raw: body,
    fiveHourPercent: Math.floor(fiveHour.percent),
    resetsAtMs: fiveHour.resetsAtMs,
    billing,
    schemaChanged,
    schemaFingerprint: fp,
    fetchedAtMs,
    requestId: requestId || null,
  };

  if (maxPercent >= 100 || anyLocked || billing.spendLimitReached) {
    return {
      kind: 'blocked',
      reason: billing.spendLimitReached ? 'spend_limit_reached'
        : anyLocked ? 'locked'
        : 'over_limit',
      ...base,
    };
  }

  return { kind: 'ok', abnormalSeverity, ...base };
}

// ---------------------------------------------------------------- fetching

async function fetchOnce() {
  const creds = credentials();
  if (!creds?.accessToken) return unknown('no_token');

  const tokenExpiresAtMs = typeof creds.expiresAt === 'number' ? creds.expiresAt : null;

  let res;
  try {
    res = await _fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.74',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return unknown('network', { detail: err?.message || String(err), tokenExpiresAtMs });
  }

  const requestId = res.headers?.get?.('request-id') || null;

  if (res.status === 429) {
    _consecutive429 += 1;
    const retryAfterS = parseInt(res.headers?.get?.('retry-after') || '0', 10);
    const ladder = RATE_LIMIT_LADDER_MS[
      Math.min(_consecutive429 - 1, RATE_LIMIT_LADDER_MS.length - 1)
    ];
    const waitMs = Math.max(Number.isFinite(retryAfterS) ? retryAfterS * 1000 : 0, ladder);
    _blockedUntilMs = _now() + waitMs;
    return unknown('http_429', { retryAfterMs: waitMs, requestId, tokenExpiresAtMs });
  }

  if (res.status === 401 || res.status === 403) {
    // The token in the credentials file is re-read on every call, so if the CLI
    // refreshes it in the background this clears on its own. Until then: blind,
    // and blind means stop.
    return unknown('http_401', { status: res.status, requestId, tokenExpiresAtMs });
  }

  if (!res.ok) {
    return unknown('http_error', { status: res.status, requestId, tokenExpiresAtMs });
  }

  _consecutive429 = 0;
  _blockedUntilMs = 0;

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return unknown('bad_json', { detail: err?.message || String(err), requestId });
  }

  const verdict = buildVerdict(body, _now(), requestId);
  verdict.tokenExpiresAtMs = tokenExpiresAtMs;
  return verdict;
}

// ---------------------------------------------------------------- public API

/**
 * Read usage, using the shared cache when it is fresh enough.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force]      bypass the TTL (still honours 429 backoff)
 * @param {number}  [opts.maxAgeMs]   hard staleness gate; default 90s
 * @returns {Promise<object>} a verdict — never a bare number, never undefined
 */
async function read(opts = {}) {
  const maxAgeMs = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const now = _now();

  const cachedAge = _cache ? now - _cache.fetchedAtMs : Infinity;
  const cacheUsable = _cache && cachedAge <= Math.min(_ttlMs, maxAgeMs);
  if (!opts.force && cacheUsable) {
    return { ..._cache.verdict, ageMs: cachedAge, fromCache: true };
  }

  // Rate limited: do NOT fall through to the cached value. A refusal to refresh
  // must not silently become permission to act on an old number.
  if (now < _blockedUntilMs) {
    return unknown('http_429', { retryAfterMs: _blockedUntilMs - now, ageMs: cachedAge });
  }

  if (_inFlight) {
    const v = await _inFlight;
    const age = _now() - (v.fetchedAtMs || _now());
    return { ...v, ageMs: age };
  }

  _inFlight = fetchOnce().finally(() => { _inFlight = null; });
  const verdict = await _inFlight;

  if (verdict.kind === 'ok' || verdict.kind === 'blocked') {
    _cache = { verdict, fetchedAtMs: verdict.fetchedAtMs };
    return { ...verdict, ageMs: 0, fromCache: false };
  }

  // A failed refresh leaves the cache in place for display purposes, but the
  // returned verdict stays `unknown`. Callers that act must use the verdict;
  // only callers that render may reach for lastKnown().
  return { ...verdict, ageMs: cachedAge === Infinity ? null : cachedAge };
}

/** The last good verdict, for display only. Never use this to decide to act. */
function lastKnown() {
  if (!_cache) return null;
  return { ..._cache.verdict, ageMs: _now() - _cache.fetchedAtMs, fromCache: true };
}

/** True when a verdict is safe to act on right now. */
function isActionable(verdict, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!verdict || verdict.kind !== 'ok') return false;
  if (typeof verdict.ageMs !== 'number') return false;
  return verdict.ageMs <= maxAgeMs;
}

module.exports = {
  init,
  reset,
  read,
  lastKnown,
  isActionable,
  // exported for tests and for callers that want the pieces
  readBuckets,
  readBilling,
  buildVerdict,
  parseInstant,
  fingerprint,
  USAGE_URL,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_AGE_MS,
  BENIGN_DISABLED_REASONS,
};
