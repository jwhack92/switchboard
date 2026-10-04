'use strict';
// localDay / dayList (design 1.6, contract D3: they live in token-usage.js, the
// main side). Plain Node: the module must load without Electron or a database.
//
// Every zone-dependent case runs in a child spawned with TZ in its environment
// (spawnSync + env, never a shell `TZ=` prefix), and each child first proves
// that the zone took effect, so a platform that ignores TZ fails loudly instead
// of passing for the wrong reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const MOD = path.join(__dirname, '..', 'token-usage.js');

function inZone(tz, body) {
  const code = `
    const t = require(${JSON.stringify(MOD)});
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const out = (function () { ${body} })();
    process.stdout.write(JSON.stringify({ zone, out }));
  `;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.zone, tz, 'the child must really run in ' + tz);
  return parsed.out;
}

function assertConsecutive(days) {
  assert.equal(new Set(days).size, days.length, 'days are distinct: ' + days.join(','));
  for (let i = 1; i < days.length; i++) {
    assert.ok(days[i] > days[i - 1], 'days ascend: ' + days.join(','));
    // Noon UTC of consecutive calendar dates is exactly one day apart; this
    // checks the strings, not the zone.
    const gap = Date.parse(days[i] + 'T12:00:00Z') - Date.parse(days[i - 1] + 'T12:00:00Z');
    assert.equal(gap, 86400000, days[i - 1] + ' -> ' + days[i] + ' is one calendar day');
  }
}

test('requiring the module loads no database, no electron, no parser, no queries module', () => {
  const code = `
    require(${JSON.stringify(MOD)});
    const hit = Object.keys(require.cache).filter((k) =>
      /better-sqlite3|[\\\\/]electron[\\\\/]|token-usage-parse|token-usage-queries|token-prices/.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('localDay uses the LOCAL day: one instant, three zones', () => {
  const at = "t.localDay(Date.parse('2026-10-04T03:30:00Z'))";
  assert.equal(inZone('America/Los_Angeles', `return ${at};`), '2026-10-03');
  assert.equal(inZone('Pacific/Auckland', `return ${at};`), '2026-10-04');
  assert.equal(inZone('UTC', `return ${at};`), '2026-10-04');
});

test('localDay separates Pacific/Auckland from UTC (a UTC-bucketing bug would not)', () => {
  const at = "t.localDay(Date.parse('2026-10-04T13:30:00Z'))";
  assert.equal(inZone('Pacific/Auckland', `return ${at};`), '2026-10-05');
  assert.equal(inZone('UTC', `return ${at};`), '2026-10-04');
  assert.equal(inZone('America/Los_Angeles', `return ${at};`), '2026-10-04');
});

test('localDay pads and never throws on garbage', () => {
  const out = inZone('UTC', `
    return {
      early: t.localDay(Date.parse('2026-01-05T00:00:00Z')),
      bad: [NaN, Infinity, -Infinity, undefined, null, '2026-10-04', {}, [], 8.7e15].map((v) => t.localDay(v)),
    };
  `);
  assert.equal(out.early, '2026-01-05');
  assert.deepEqual(out.bad, [null, null, null, null, null, null, null, null, null]);
});

test('dayList across the autumn DST change (America/Los_Angeles, 2026-11-01)', () => {
  const out = inZone('America/Los_Angeles', `
    const days = t.dayList('2026-10-30', '2026-11-03');
    // What stepping by 86,400,000 ms from local midnight gives in this zone: the
    // bug the calendar stepping exists to avoid. It must differ, or this test
    // would not be able to tell the two apart.
    const start = new Date(2026, 9, 30).getTime();
    const naive = [];
    for (let i = 0; i < 5; i++) naive.push(t.localDay(start + i * 86400000));
    return { days, naive };
  `);
  assert.deepEqual(out.days, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  assertConsecutive(out.days);
  assert.notDeepEqual(out.naive, out.days, 'ms stepping is wrong across this change');
  assert.ok(new Set(out.naive).size < out.naive.length, 'ms stepping repeats a day: ' + out.naive.join(','));
});

test('dayList across the spring DST change (America/Los_Angeles, 2027-03-14)', () => {
  const out = inZone('America/Los_Angeles', `
    const days = t.dayList('2027-03-12', '2027-03-16');
    // Stepping ms from 23:30 local skips the short day.
    const start = new Date(2027, 2, 12, 23, 30).getTime();
    const naive = [];
    for (let i = 0; i < 5; i++) naive.push(t.localDay(start + i * 86400000));
    return { days, naive };
  `);
  assert.deepEqual(out.days, ['2027-03-12', '2027-03-13', '2027-03-14', '2027-03-15', '2027-03-16']);
  assertConsecutive(out.days);
  assert.notDeepEqual(out.naive, out.days, 'ms stepping is wrong across this change');
});

test('dayList across both DST changes in Pacific/Auckland and under UTC', () => {
  const nz = inZone('Pacific/Auckland', `
    return { spring: t.dayList('2026-09-25', '2026-09-29'), autumn: t.dayList('2027-04-02', '2027-04-06') };
  `);
  assert.deepEqual(nz.spring, ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
  assert.deepEqual(nz.autumn, ['2027-04-02', '2027-04-03', '2027-04-04', '2027-04-05', '2027-04-06']);
  const utc = inZone('UTC', "return t.dayList('2026-10-30', '2026-11-03');");
  assert.deepEqual(utc, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
});

test('every listed day is the localDay of its own local noon, in each zone', () => {
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    const out = inZone(tz, `
      const days = t.dayList('2026-09-20', '2027-04-10');
      const back = days.map((d) => {
        const p = d.split('-').map(Number);
        return t.localDay(new Date(p[0], p[1] - 1, p[2], 12).getTime());
      });
      return { n: days.length, distinct: new Set(days).size, same: JSON.stringify(days) === JSON.stringify(back),
               first: days[0], last: days[days.length - 1] };
    `);
    assert.equal(out.n, 203, tz);            // 11 + 31 + 30 + 31 + 31 + 28 + 31 + 10
    assert.equal(out.distinct, 203, tz);
    assert.equal(out.same, true, tz);
    assert.equal(out.first, '2026-09-20', tz);
    assert.equal(out.last, '2027-04-10', tz);
  }
});

test('dayList: month, year and leap-day rollovers, single day, empty and garbage ranges', () => {
  const out = inZone('America/Los_Angeles', `
    return {
      year: t.dayList('2026-12-30', '2027-01-02'),
      leap: t.dayList('2028-02-28', '2028-03-01'),
      noLeap: t.dayList('2027-02-27', '2027-03-01'),
      one: t.dayList('2026-10-03', '2026-10-03'),
      reversed: t.dayList('2026-10-04', '2026-10-03'),
      bad: [
        t.dayList(), t.dayList(null, null), t.dayList('2026-10-03'), t.dayList(20261003, 20261004),
        t.dayList('2026-1-3', '2026-01-04'), t.dayList('garbage', '2026-01-04'), t.dayList({}, []),
      ],
      thirty: t.dayList('2026-09-04', '2026-10-03').length,
    };
  `);
  assert.deepEqual(out.year, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.deepEqual(out.leap, ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(out.noLeap, ['2027-02-27', '2027-02-28', '2027-03-01']);
  assert.deepEqual(out.one, ['2026-10-03']);
  assert.deepEqual(out.reversed, []);
  for (const b of out.bad) assert.deepEqual(b, []);
  assert.equal(out.thirty, 30);
});
