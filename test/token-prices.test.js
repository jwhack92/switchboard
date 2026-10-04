const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prices = require('../token-prices');
const { loadPriceTable, normalizeModel, weightsFor, weightedTokens, estimateUsd } = prices;

// Design 5.2, re-checked against the claude-api skill on 2026-10-03. Dollar
// columns are per million tokens. The test derives every dollar figure from
// baseUsd and the ratios, so a wrong ratio OR a wrong base price fails here.
const DESIGN_5_2 = [
  // id, base, output, write5m, write1h, cacheRead, readRatio
  ['claude-fable-5-1', 10, 50, 12.5, 20, 0.25, 0.025],
  ['claude-fable-5', 10, 50, 12.5, 20, 1.0, 0.1],
  ['claude-opus-5-5', 4, 20, 5.0, 8.0, 0.2, 0.05],
  ['claude-opus-5', 5, 25, 6.25, 10.0, 0.5, 0.1],
  ['claude-opus-4-8', 5, 25, 6.25, 10.0, 0.5, 0.1],
  ['claude-sonnet-5-5', 2, 10, 2.5, 4.0, 0.2, 0.1],
  ['claude-sonnet-5', 2, 10, 2.5, 4.0, 0.2, 0.1],
  ['claude-haiku-4-5', 1, 5, 1.25, 2.0, 0.1, 0.1],
];

function near(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: got ${actual}, want ${expected}`);
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-token-prices-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())), 'temp dir is under os.tmpdir()');
  return dir;
}

function writeTable(file, obj, mtimeSec) {
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  // Set the mtime explicitly: two writes inside one clock tick would otherwise
  // look like an unchanged file.
  if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
}

test('token-prices.json: version and exactly the models of design 5.2', () => {
  const table = loadPriceTable();
  assert.strictEqual(table.version, '2026-09-25');
  assert.deepStrictEqual(
    Object.keys(table.models).sort(),
    DESIGN_5_2.map((r) => r[0]).sort(),
  );
});

test('every model in 5.2 returns the listed ratios and base price', () => {
  const table = loadPriceTable();
  for (const [id, base, output, w5, w1, cacheRead, readRatio] of DESIGN_5_2) {
    const w = weightsFor(id, table);
    assert.strictEqual(w.priced, true, id);
    assert.strictEqual(w.baseUsd, base, `${id} baseUsd`);
    assert.strictEqual(w.input, 1, `${id} input`);
    assert.strictEqual(w.output, 5, `${id} output`);
    assert.strictEqual(w.write5m, 1.25, `${id} write5m`);
    assert.strictEqual(w.write1h, 2, `${id} write1h`);
    assert.strictEqual(w.read, readRatio, `${id} read`);
    // The dollar columns of the table follow from base price x ratio.
    near(w.baseUsd * w.output, output, `${id} output $/MTok`);
    near(w.baseUsd * w.write5m, w5, `${id} write 5m $/MTok`);
    near(w.baseUsd * w.write1h, w1, `${id} write 1h $/MTok`);
    near(w.baseUsd * w.read, cacheRead, `${id} cache read $/MTok`);
  }
});

test('weightsFor with no table argument reads token-prices.json', () => {
  assert.deepStrictEqual(weightsFor('claude-opus-5-5'), weightsFor('claude-opus-5-5', loadPriceTable()));
  assert.strictEqual(weightsFor('claude-opus-5-5').read, 0.05);
});

test('normalizeModel strips a trailing -YYYYMMDD and lower-cases', () => {
  assert.strictEqual(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.strictEqual(normalizeModel('Claude-Opus-5-5'), 'claude-opus-5-5');
  assert.strictEqual(normalizeModel('claude-opus-5-5'), 'claude-opus-5-5');
  // A version suffix is not a date and must survive.
  assert.strictEqual(normalizeModel('claude-fable-5-1'), 'claude-fable-5-1');
  // Only a TRAILING date is stripped.
  assert.strictEqual(normalizeModel('claude-3-5-haiku-20241022'), 'claude-3-5-haiku');
  assert.strictEqual(normalizeModel('claude-20251001-x'), 'claude-20251001-x');
  assert.strictEqual(normalizeModel(null), '');
  assert.strictEqual(normalizeModel(undefined), '');
  assert.strictEqual(normalizeModel(42), '');
});

test('claude-haiku-4-5-20251001 maps to Haiku 4.5 without its own row', () => {
  const table = loadPriceTable();
  assert.ok(!Object.prototype.hasOwnProperty.call(table.models, 'claude-haiku-4-5-20251001'));
  assert.deepStrictEqual(
    weightsFor('claude-haiku-4-5-20251001', table),
    weightsFor('claude-haiku-4-5', table),
  );
  assert.strictEqual(weightsFor('claude-haiku-4-5-20251001', table).baseUsd, 1);
});

test('unknown model: model-independent ratios, read 0.1, baseUsd null, not priced', () => {
  const table = loadPriceTable();
  for (const id of ['claude-nonesuch-9', '', null, undefined, 'constructor', '__proto__', 'toString']) {
    const w = weightsFor(id, table);
    assert.deepStrictEqual(
      w,
      { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1, baseUsd: null, priced: false },
      `id ${String(id)}`,
    );
  }
});

test('weightedTokens: the worked example on claude-opus-5-5 is 340', () => {
  const w = weightsFor('claude-opus-5-5', loadPriceTable());
  const row = { input: 100, output: 10, cache_write_5m: 80, cache_write_1h: 20, cache_read: 1000 };
  // 100 + 50 + 100 + 40 + 50
  near(weightedTokens(row, w), 340, 'worked example');
});

test('weightedTokens: no remainder term, cache_write itself is never weighted', () => {
  const w = weightsFor('claude-opus-5-5', loadPriceTable());
  const row = { input: 100, output: 10, cache_write_5m: 80, cache_write_1h: 20, cache_read: 1000 };
  const withTotal = { ...row, cache_write: 100, thinking: 7, finalized: 1 };
  near(weightedTokens(withTotal, w), weightedTokens(row, w), 'extra columns ignored');
  // A row with only the un-split counter contributes nothing for writes.
  near(weightedTokens({ cache_write: 500 }, w), 0, 'cache_write alone');
});

test('weightedTokens: the same row weighs differently by model read ratio', () => {
  const table = loadPriceTable();
  const row = { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 1000000 };
  near(weightedTokens(row, weightsFor('claude-fable-5-1', table)), 25000, 'fable 5.1');
  near(weightedTokens(row, weightsFor('claude-opus-5-5', table)), 50000, 'opus 5.5');
  near(weightedTokens(row, weightsFor('claude-opus-5', table)), 100000, 'opus 5');
  near(weightedTokens(row, weightsFor('who-knows', table)), 100000, 'unknown');
});

test('weightedTokens: null sums, missing columns and missing weights do not give NaN', () => {
  const w = weightsFor('claude-opus-5', loadPriceTable());
  assert.strictEqual(weightedTokens({}, w), 0);
  assert.strictEqual(weightedTokens(null, w), 0);
  assert.strictEqual(weightedTokens({ input: null, output: undefined, cache_read: NaN }, w), 0);
  assert.strictEqual(weightedTokens({ input: 10, output: 2 }, w), 20);
  // No weights passed: the model-independent ratios.
  near(weightedTokens({ input: 10, output: 2, cache_read: 100 }), 30, 'default ratios');
});

test('estimateUsd: weighted x base price per million, null when unpriced', () => {
  const table = loadPriceTable();
  const opus = weightsFor('claude-opus-5-5', table);
  near(estimateUsd(340, opus), 0.00136, 'worked example in dollars');
  near(estimateUsd(1e6, opus), 4, 'one million input equivalents');
  near(estimateUsd(1e6, weightsFor('claude-fable-5-1', table)), 10, 'fable');
  assert.strictEqual(estimateUsd(0, opus), 0);
  assert.strictEqual(estimateUsd(1e6, weightsFor('who-knows', table)), null);
  assert.strictEqual(estimateUsd(NaN, opus), null);
  assert.strictEqual(estimateUsd(1e6, null), null);
});

test('estimateUsd agrees with pricing each counter at its own dollar rate', () => {
  // Independent check of the "input-token equivalents" idea: weighting then
  // multiplying by the base price must equal the per-counter bill.
  const row = { input: 123456, output: 7890, cache_write_5m: 4321, cache_write_1h: 999, cache_read: 2468024 };
  for (const [id, base, output, w5, w1, cacheRead] of DESIGN_5_2) {
    const w = weightsFor(id, loadPriceTable());
    const bill = (row.input * base + row.output * output + row.cache_write_5m * w5
      + row.cache_write_1h * w1 + row.cache_read * cacheRead) / 1e6;
    near(estimateUsd(weightedTokens(row, w), w), bill, id);
  }
});

test('weightsFor reads the table passed in: a JSON edit changes the result with no code change', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'prices.json');
  try {
    writeTable(file, { version: 'v1', models: { 'claude-opus-5-5': { baseUsd: 4, read: 0.05 } } }, 1000);
    const t1 = loadPriceTable(file);
    assert.strictEqual(t1.version, 'v1');
    const row = { input: 100, output: 10, cache_write_5m: 80, cache_write_1h: 20, cache_read: 1000 };
    near(weightedTokens(row, weightsFor('claude-opus-5-5', t1)), 340, 'before the edit');

    // Unchanged file: the cached object comes back.
    assert.strictEqual(loadPriceTable(file), t1);

    writeTable(file, { version: 'v2', models: { 'claude-opus-5-5': { baseUsd: 8, read: 0.5 } } }, 2000);
    const t2 = loadPriceTable(file);
    assert.strictEqual(t2.version, 'v2');
    const w2 = weightsFor('claude-opus-5-5', t2);
    assert.strictEqual(w2.read, 0.5);
    assert.strictEqual(w2.baseUsd, 8);
    // 100 + 50 + 100 + 40 + 500
    near(weightedTokens(row, w2), 790, 'after the edit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain object table works without a file', () => {
  const table = { version: 't', models: { 'my-model': { baseUsd: 3, read: 0.2, output: 4 } } };
  const w = weightsFor('MY-MODEL-20260101', table);
  assert.deepStrictEqual(w, { input: 1, output: 4, write5m: 1.25, write1h: 2, read: 0.2, baseUsd: 3, priced: true });
});

test('a table missing a model falls back to the model-independent ratios', () => {
  const table = { version: 't', models: { 'claude-opus-5-5': { baseUsd: 4, read: 0.05 } } };
  const w = weightsFor('claude-fable-5-1', table);
  assert.strictEqual(w.read, 0.1);
  assert.strictEqual(w.baseUsd, null);
  assert.strictEqual(w.priced, false);
  // Malformed tables behave the same way and do not throw.
  for (const bad of [{}, { models: null }, { models: [] }, { version: 'x' }]) {
    assert.strictEqual(weightsFor('claude-opus-5-5', bad).priced, false);
  }
});

test('a row with a ratio but no usable base price weights and is unpriced', () => {
  const table = { version: 't', models: { a: { read: 0.05 }, b: { baseUsd: -1, read: 0.05 }, c: { baseUsd: 4, read: 'x' } } };
  assert.deepStrictEqual(
    [weightsFor('a', table).read, weightsFor('a', table).baseUsd, weightsFor('a', table).priced],
    [0.05, null, false],
  );
  assert.strictEqual(weightsFor('b', table).priced, false);
  assert.strictEqual(estimateUsd(1e6, weightsFor('b', table)), null);
  // No usable read ratio: the whole row is ignored.
  assert.strictEqual(weightsFor('c', table).read, 0.1);
  assert.strictEqual(weightsFor('c', table).priced, false);
});

test('loadPriceTable never throws: missing, broken and wrong-shaped files give version "unavailable"', () => {
  const dir = tmpDir();
  try {
    const missing = loadPriceTable(path.join(dir, 'nope.json'));
    assert.strictEqual(missing.version, 'unavailable');
    assert.deepStrictEqual(missing.models, {});
    assert.strictEqual(weightsFor('claude-opus-5-5', missing).read, 0.1);
    assert.strictEqual(weightsFor('claude-opus-5-5', missing).priced, false);

    const cases = {
      'broken.json': '{ "version": "x", "models": ',
      'empty.json': '',
      'array.json': '[]',
      'null.json': 'null',
      'noversion.json': '{"models":{}}',
      'nomodels.json': '{"version":"x"}',
    };
    for (const [name, body] of Object.entries(cases)) {
      const file = path.join(dir, name);
      writeTable(file, body);
      assert.strictEqual(loadPriceTable(file).version, 'unavailable', name);
    }
    // A directory in place of the file.
    assert.strictEqual(loadPriceTable(dir).version, 'unavailable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPriceTable: a broken file recovers when it is fixed, a bad row is dropped', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'prices.json');
  try {
    writeTable(file, 'not json', 1000);
    assert.strictEqual(loadPriceTable(file).version, 'unavailable');
    writeTable(file, {
      version: 'fixed',
      models: {
        good: { baseUsd: 2, read: 0.1 },
        'Dated-Key-20260101': { baseUsd: 3, read: 0.2 },
        bad: { baseUsd: 2, read: -1 },
        worse: 'nope',
      },
    }, 2000);
    const t = loadPriceTable(file);
    assert.strictEqual(t.version, 'fixed');
    assert.deepStrictEqual(Object.keys(t.models).sort(), ['dated-key', 'good']);
    assert.strictEqual(weightsFor('dated-key', t).baseUsd, 3);
    assert.strictEqual(weightsFor('bad', t).priced, false);

    // The file going away afterwards is not served from the cache.
    fs.rmSync(file);
    assert.strictEqual(loadPriceTable(file).version, 'unavailable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the loaded table is frozen, so one caller cannot change another caller\'s prices', () => {
  const table = loadPriceTable();
  assert.ok(Object.isFrozen(table));
  assert.ok(Object.isFrozen(table.models));
  assert.ok(Object.isFrozen(table.models['claude-opus-5-5']));
  const w = weightsFor('claude-opus-5-5', table);
  w.read = 99; // the returned weights are a fresh object each call
  assert.strictEqual(weightsFor('claude-opus-5-5', table).read, 0.05);
});

test('requiring the module does no I/O and needs no electron', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'token-prices.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(src));
  assert.ok(!/require\(['"]\.\/token-usage/.test(src));
});
