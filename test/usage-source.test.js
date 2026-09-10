const test = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../usage-source');

// A payload shaped like the real one (probed 2026-09-01T20:56Z), trimmed to the
// fields that matter here. Percentages and reset instants are synthetic.
function payload(over = {}) {
  return {
    five_hour: {
      utilization: 61, resets_at: '2026-09-01T22:49:59.887177+00:00',
      limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null,
    },
    seven_day: { utilization: 28, resets_at: '2026-09-06T00:00:00+00:00' },
    seven_day_opus: { utilization: null, resets_at: null },
    limits: [
      { kind: 'session', percent: 61, resets_at: '2026-09-01T22:49:59.887177+00:00', severity: 'normal' },
      { kind: 'weekly_all', percent: 28, resets_at: '2026-09-06T00:00:00+00:00', severity: 'normal' },
    ],
    extra_usage: {
      is_enabled: true, monthly_limit: null, used_credits: 0, utilization: null,
      spend_limit_reached: false, disabled_reason: null,
    },
    spend: {
      used: { amount_minor: 0, currency: 'USD', exponent: 2 },
      limit: null, cap: null, percent: 0, severity: 'normal',
      enabled: true, can_toggle: false, can_purchase_credits: false,
    },
    member_dashboard_available: false,
    ...over,
  };
}

function makeResponse({ status = 200, body = payload(), headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** Install a fake environment. Returns a handle for asserting call counts. */
function harness({ responses, creds = { accessToken: 'tok', expiresAt: 4_000_000 }, t0 = 1_000_000 } = {}) {
  const state = { calls: 0, now: t0 };
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  usage.init({
    now: () => state.now,
    getCredentials: () => creds,
    log: { error() {}, warn() {}, info() {} },
    fetchImpl: async () => {
      state.calls += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return state;
}

// ---------------------------------------------------------------- unknown

test('no credentials yields unknown, never a number', async () => {
  harness({ responses: makeResponse(), creds: null });
  const v = await usage.read();
  assert.equal(v.kind, 'unknown');
  assert.equal(v.reason, 'no_token');
  assert.equal(v.fiveHourPercent, undefined, 'must not invent a percentage');
});

test('401 yields unknown — a dead token is blind, not zero', async () => {
  harness({ responses: makeResponse({ status: 401 }) });
  const v = await usage.read();
  assert.equal(v.kind, 'unknown');
  assert.equal(v.reason, 'http_401');
});

test('network failure yields unknown', async () => {
  harness({ responses: new Error('ECONNRESET') });
  const v = await usage.read();
  assert.equal(v.kind, 'unknown');
  assert.equal(v.reason, 'network');
});

test('malformed JSON yields unknown', async () => {
  harness({ responses: { ok: true, status: 200, headers: { get: () => null },
    json: async () => { throw new Error('bad json'); } } });
  const v = await usage.read();
  assert.equal(v.kind, 'unknown');
  assert.equal(v.reason, 'bad_json');
});

test('a payload with no five_hour bucket yields unknown', async () => {
  const body = payload();
  delete body.five_hour;
  delete body.limits;
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.kind, 'unknown');
  assert.equal(v.reason, 'no_five_hour');
});

test('five_hour with an unparseable resets_at yields unknown, not NaN', async () => {
  // This is the window-key bug: Date.parse(null) is NaN, NaN !== NaN, so a NaN
  // reset instant makes every tick look like a fresh window and turns
  // "N per window" into "N per tick".
  const body = payload({ five_hour: { utilization: 61, resets_at: null } });
  body.limits = [];
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.kind, 'unknown');
  assert.equal(v.reason, 'no_reset_instant');
});

// ---------------------------------------------------------------- 429

test('429 yields unknown and does NOT fall through to a cached value', async () => {
  const h = harness({ responses: [makeResponse(), makeResponse({ status: 429, headers: { 'retry-after': '30' } })] });
  const first = await usage.read();
  assert.equal(first.kind, 'ok');

  h.now += 300_000; // past the TTL, so a refresh is attempted
  const second = await usage.read();
  assert.equal(second.kind, 'unknown', 'a refusal to refresh must not become permission to act');
  assert.equal(second.reason, 'http_429');
  assert.ok(second.retryAfterMs >= 30_000);
});

test('while rate limited, no further requests are made', async () => {
  const h = harness({ responses: makeResponse({ status: 429, headers: { 'retry-after': '60' } }) });
  await usage.read();
  const callsAfterFirst = h.calls;
  h.now += 1_000;
  const v = await usage.read();
  assert.equal(h.calls, callsAfterFirst, 'must respect its own backoff window');
  assert.equal(v.reason, 'http_429');
});

// ---------------------------------------------------------------- blocked

test('a bucket at or over 100 is blocked', async () => {
  const body = payload();
  body.five_hour.utilization = 100;
  body.limits[0].percent = 100;
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.kind, 'blocked');
  assert.equal(v.reason, 'over_limit');
});

test('spend_limit_reached is blocked even when percentages look fine', async () => {
  const body = payload();
  body.extra_usage.spend_limit_reached = true;
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.kind, 'blocked');
  assert.equal(v.reason, 'spend_limit_reached');
});

test('a locked bucket is blocked', async () => {
  const body = payload();
  body.five_hour.locked_reason = 'usage_limit';
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.kind, 'blocked');
});

// ---------------------------------------------------------------- ok

test('a healthy payload reports percentages and the reset instant', async () => {
  harness({ responses: makeResponse() });
  const v = await usage.read();
  assert.equal(v.kind, 'ok');
  assert.equal(v.fiveHourPercent, 61);
  assert.equal(v.percents.five_hour, 61);
  assert.equal(v.percents.seven_day, 28);
  assert.equal(v.resetsAtMs, Date.parse('2026-09-01T22:49:59.887177+00:00'));
  assert.equal(v.ageMs, 0);
});

test('buckets are read openly, so a brand-new limit key is still seen', async () => {
  const body = payload({ some_future_window: { utilization: 97, resets_at: '2026-09-02T00:00:00Z' } });
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  const found = v.buckets.find(b => b.key === 'some_future_window');
  assert.ok(found, 'an unrecognised bucket must not be silently ignored');
  assert.equal(found.percent, 97);
});

test('buckets with a null utilization are skipped, not read as zero', async () => {
  harness({ responses: makeResponse() });
  const v = await usage.read();
  assert.equal(v.percents.seven_day_opus, undefined);
});

// ---------------------------------------------------------------- billing

test('billing state is preserved — the fields the old path threw away', async () => {
  harness({ responses: makeResponse() });
  const v = await usage.read();
  assert.equal(v.billing.canBill, true, 'extra_usage.is_enabled true means crossing the limit bills');
  assert.equal(v.billing.capVisible, false, 'no monthly_limit, no spend.limit, no spend.cap');
  assert.equal(v.billing.canToggle, false);
  assert.equal(v.billing.dashboardAvailable, false);
  assert.equal(v.billing.spentMinor, 0);
});

test('a visible cap is detected wherever it appears', async () => {
  const body = payload();
  body.spend.limit = 5000;
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.billing.capVisible, true);
  assert.deepEqual(v.billing.caps, [5000]);
});

test('a benign disabled_reason means overage genuinely cannot bill', async () => {
  const body = payload();
  body.extra_usage.is_enabled = false;
  body.extra_usage.disabled_reason = 'org_spend_cap_reached';
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.billing.canBill, false);
});

test('an ABSENT extra_usage object is treated as billable — unknown is not safe', async () => {
  const body = payload();
  delete body.extra_usage;
  delete body.spend;
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.billing.canBill, true, 'fail closed: no evidence of safety is not evidence of safety');
});

test('an unrecognised disabled_reason is treated as billable', async () => {
  const body = payload();
  body.extra_usage.is_enabled = false;
  body.extra_usage.disabled_reason = 'some_new_reason_we_have_never_seen';
  harness({ responses: makeResponse({ body }) });
  const v = await usage.read();
  assert.equal(v.billing.canBill, true);
});

// ---------------------------------------------------------------- caching

test('a second read inside the TTL is served from cache', async () => {
  const h = harness({ responses: makeResponse() });
  await usage.read();
  h.now += 1_000;
  const v = await usage.read();
  assert.equal(h.calls, 1, 'one shared poll, not one per caller');
  assert.equal(v.fromCache, true);
  assert.equal(v.ageMs, 1_000);
});

test('concurrent readers share a single request', async () => {
  const h = harness({ responses: makeResponse() });
  const [a, b, c] = await Promise.all([usage.read(), usage.read(), usage.read()]);
  assert.equal(h.calls, 1);
  assert.equal(a.kind, 'ok'); assert.equal(b.kind, 'ok'); assert.equal(c.kind, 'ok');
});

test('a reading older than the staleness gate is refetched, not served', async () => {
  const h = harness({ responses: makeResponse() });
  await usage.read();
  h.now += 120_000; // older than DEFAULT_MAX_AGE_MS
  await usage.read();
  assert.equal(h.calls, 2);
});

// ---------------------------------------------------------------- actionable

test('isActionable is false for anything that is not a fresh ok', async () => {
  harness({ responses: makeResponse() });
  const ok = await usage.read();
  assert.equal(usage.isActionable(ok), true);

  assert.equal(usage.isActionable({ kind: 'unknown', reason: 'network', ageMs: 0 }), false);
  assert.equal(usage.isActionable({ kind: 'blocked', ageMs: 0 }), false);
  assert.equal(usage.isActionable({ ...ok, ageMs: 999_999 }), false, 'stale ok is not actionable');
  assert.equal(usage.isActionable({ ...ok, ageMs: null }), false, 'unknown age is not actionable');
  assert.equal(usage.isActionable(null), false);
  assert.equal(usage.isActionable(undefined), false);
});

// ---------------------------------------------------------------- schema

test('a change in the response shape is flagged', async () => {
  const body2 = payload();
  delete body2.spend;
  const h = harness({ responses: [makeResponse(), makeResponse({ body: body2 })] });
  const first = await usage.read();
  assert.equal(first.schemaChanged, false, 'the first reading has nothing to compare against');

  h.now += 300_000;
  const second = await usage.read();
  assert.equal(second.schemaChanged, true);
  assert.notEqual(second.schemaFingerprint, first.schemaFingerprint);
});

// ---------------------------------------------------------------- helpers

test('parseInstant returns null rather than NaN', () => {
  assert.equal(usage.parseInstant(null), null);
  assert.equal(usage.parseInstant(undefined), null);
  assert.equal(usage.parseInstant('not a date'), null);
  assert.equal(usage.parseInstant('2026-09-01T22:49:59Z'), Date.parse('2026-09-01T22:49:59Z'));
});

test('lastKnown is display-only and never turns unknown into ok', async () => {
  const h = harness({ responses: [makeResponse(), makeResponse({ status: 500 })] });
  await usage.read();
  h.now += 300_000;
  const v = await usage.read();
  assert.equal(v.kind, 'unknown', 'the acting verdict stays unknown');
  const shown = usage.lastKnown();
  assert.equal(shown.kind, 'ok', 'but the last good reading is still available to render');
  assert.ok(shown.ageMs >= 300_000, 'and it carries its age so the UI can say how stale it is');
});
