const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../campaign-engine.js');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../support/pricing-rules.json'), 'utf8').replace(/^\uFEFF/, ''));
const officialAnchors = JSON.parse(fs.readFileSync(path.join(__dirname, '../support/brand-anchors.json'), 'utf8').replace(/^\uFEFF/, '')).anchors;
const rate = grade => rules.standardRates.find(row => row.medium === '公交车身' && row.grade === grade);
const busPrice = grade => { const row = rate(grade); return { monthlyLow: row.mediaPriceLowCny, monthlyHigh: row.mediaPriceHighCny, productionLow: row.production.lowCny, productionHigh: row.production.highCny }; };
const anchors = officialAnchors.slice(0, 3);
const a = anchors.map(anchor => anchor.id);
const brief = { budget: 1000000, months: 1, mediaTypes: ['bus', 'metro'], anchorIds: [a[0]], start: '2027-03-01', end: '2027-03-31' };
function resource(id, overrides = {}) {
  return { id, name: '测试资源 ' + id, mediaType: 'bus', grade: 'A+', available: 50, coverageAnchorIds: [a[0]], price: busPrice('A+'), sourceRef: '红豆比赛专户 / 2027-03-01—2027-03-31 / 原始 ID ' + id, ...overrides };
}
function dataset(resources = [resource('BUS-01')], overrides = {}) {
  return { version: 'test-2027-03', inventoryPeriod: { start: '2027-03-01', end: '2027-03-31', checkedAt: '2026-11-21T12:00:00+08:00', source: '红豆比赛专户完整档期查询（测试夹具，非真实可售结论）' }, anchors, resources, ...overrides };
}

test('official pricing fixture is preserved as monthly per-physical-unit intervals', () => {
  const result = Engine.validate(dataset());
  assert.deepEqual(result.errors, []);
  assert.equal(result.dataset.resources[0].available, 50);
  assert.deepEqual(Engine.quote(result.dataset.resources[0], 2, 1), { low: 70000, high: 120000, complete: true, errors: [] });
});

test('50 simultaneously sellable buses are not limited by one month having 31 days', () => {
  const data = dataset();
  const result = Engine.plan(data, { ...brief, budget: 5000000 });
  assert.deepEqual(result.errors, []);
  assert.equal(Engine.quantity(result.selection, 'BUS-01'), 50);
  const summary = Engine.summarize(data, result.selection, { ...brief, budget: 5000000 });
  assert.equal(summary.busUnits, 50);
  assert.equal(summary.high, 3000000);
  assert.equal(summary.quantity, 50);
  assert.equal(summary.remainingHigh, 2000000);
});

test('production is charged per physical bus once, not once per route or once per month', () => {
  const row = resource('BUS-01');
  assert.equal(Engine.quote(row, 50, 3).high, 50 * (50000 * 3 + 10000));
  assert.equal(Engine.quote(row, 50, 3).low, 50 * (30000 * 3 + 5000));
  assert.deepEqual(Engine.quote(row, 0, 3), { low: 0, high: 0, complete: true, errors: [] });
});

test('2026, 2028 and any inventory query date mismatch are rejected', () => {
  for (const override of [{ start: '2026-03-01', end: '2026-03-31' }, { start: '2028-03-01', end: '2028-03-31' }, { end: '2027-03-30' }, { start: '2027-03-02' }, { start: '2027-02-30' }]) {
    const result = Engine.plan(dataset(), { ...brief, ...override });
    assert(result.errors.length);
    assert.equal(Object.keys(result.selection).length, 0);
    assert(Engine.checkSelection(dataset(), { 'BUS-01': 1 }, { ...brief, ...override }).length);
  }
});

test('a stale resource period is individually excluded', () => {
  const data = dataset([resource('CURRENT'), resource('STALE', { inventoryPeriod: { start: '2026-11-13', end: '2026-11-13' } })]);
  const result = Engine.plan(data, brief);
  assert.deepEqual(result.errors, []);
  assert.equal(Engine.quantity(result.selection, 'STALE'), 0);
  assert.equal(result.excludedStats.periodMismatch, 1);
});

test('metro production without actual area is unknown, never zero-cost input to optimization', () => {
  const row = resource('METRO-01', { mediaType: 'metro', grade: 'A+', available: 3, price: { monthlyLow: 150000, monthlyHigh: 250000, productionLow: null, productionHigh: null } });
  const quote = Engine.quote(row, 1, 1);
  assert.equal(quote.complete, false);
  assert.equal(quote.low, null);
  assert.equal(quote.high, null);
  const result = Engine.plan(dataset([row]), brief);
  assert.deepEqual(result.errors, []);
  assert.equal(Object.keys(result.selection).length, 0);
  assert.equal(result.excludedStats.incompletePrice, 1);
  assert(Engine.checkSelection(dataset([row]), { 'METRO-01': 1 }, brief).some(error => error.includes('报价不完整')));
  const summary = Engine.summarize(dataset([row]), { 'METRO-01': 1 }, brief);
  assert.equal(summary.complete, false);
  assert.equal(summary.high, null);
  assert.equal(summary.remainingHigh, null);
});

test('all three official starting budgets stay within known upper costs', () => {
  const data = dataset([resource('A', { available: 5000 }), resource('B', { grade: 'A++', price: busPrice('A++'), available: 5000 })]);
  for (const budget of rules.scope.requiredInitialBudgetCny) {
    const b = { ...brief, budget };
    const plan = Engine.plan(data, b);
    const summary = Engine.summarize(data, plan.selection, b);
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(Engine.checkSelection(data, plan.selection, b), []);
    assert(summary.high <= budget);
    assert(summary.low <= summary.high);
    assert(summary.quantity > 0);
  }
});

test('unknown and sold-out availability are excluded rather than inferred from other counts', () => {
  const data = dataset([resource('UNKNOWN', { available: null, totalVehicles: 5000, contractVehicles: 10 }), resource('MISSING', { available: undefined }), resource('SOLD', { available: 0 })]);
  const plan = Engine.plan(data, brief);
  assert.equal(Object.keys(plan.selection).length, 0);
  assert.equal(plan.excludedStats.unknownAvailability, 2);
  assert.equal(plan.excludedStats.soldOut, 1);
  assert(Engine.checkSelection(data, { UNKNOWN: 1 }, brief).length);
});

test('public projection drops private fields at every nested level', () => {
  const raw = dataset([resource('BUS-01', { confidentialMargin: 'PRIVATE_ROW', price: { ...busPrice('A+'), apiKey: 'PRIVATE_PRICE' }, coverageEvidence: [{ anchorId: a[0], sourceRef: '覆盖查询 / 行1', secret: 'PRIVATE_COVERAGE' }] })]);
  raw.privateKey = 'PRIVATE_ROOT';
  raw.inventoryPeriod.accountPassword = 'PRIVATE_PERIOD';
  raw.anchors = raw.anchors.map(anchor => ({ ...anchor, contactPhone: 'PRIVATE_ANCHOR' }));
  const result = Engine.validate(raw);
  assert.deepEqual(result.errors, []);
  assert(!JSON.stringify(result.dataset).includes('PRIVATE_'));
});

test('prototype-method resource IDs use own-property quantities safely', () => {
  for (const id of ['toString', 'hasOwnProperty', 'valueOf', 'constructor', '__proto__']) {
    const data = dataset([resource(id)]);
    assert.deepEqual(Engine.validate(data).errors, []);
    assert.equal(Engine.quantity({}, id), 0);
    assert.equal(Engine.summarize(data, {}, brief).quantity, 0);
    const plan = Engine.plan(data, brief);
    assert(Engine.quantity(plan.selection, id) > 0);
    assert.deepEqual(Engine.checkSelection(data, plan.selection, brief), []);
  }
  assert.equal(Engine.quantity(Object.create({ 'BUS-01': 20 }), 'BUS-01'), 0);
});

test('new anchor coverage takes priority over adding cheap repeated buses', () => {
  const data = dataset([
    resource('CHEAP-REPEAT', { price: { monthlyLow: 50000, monthlyHigh: 50000, productionLow: 0, productionHigh: 0 }, coverageAnchorIds: [a[0]] }),
    resource('COVERS-B', { price: { monthlyLow: 250000, monthlyHigh: 250000, productionLow: 0, productionHigh: 0 }, coverageAnchorIds: [a[1]] })
  ]);
  const b = { ...brief, anchorIds: [a[0], a[1]] };
  const plan = Engine.plan(data, b);
  assert(Engine.quantity(plan.selection, 'COVERS-B') >= 1);
  assert.deepEqual(plan.coveredAnchorIds, [a[0], a[1]]);
  assert.deepEqual(plan.uncoveredAnchorIds, []);
  assert.equal(Engine.quantity(plan.selection, 'CHEAP-REPEAT'), 15);
});

test('greedy chooses more new anchors per upper cost, not fabricated audience or exposure', () => {
  const data = dataset([
    resource('BOTH', { coverageAnchorIds: [a[0], a[1]], price: { monthlyLow: 100000, monthlyHigh: 100000, productionLow: 0, productionHigh: 0 }, available: 1 }),
    resource('ONE', { coverageAnchorIds: [a[0]], price: { monthlyLow: 60000, monthlyHigh: 60000, productionLow: 0, productionHigh: 0 }, available: 1, grossImpressionsPerUnit: 1e12, audienceFit: 1 })
  ]);
  const plan = Engine.plan(data, { ...brief, anchorIds: [a[0], a[1]] });
  assert.equal(Engine.quantity(plan.selection, 'BOTH'), 1);
  assert.deepEqual(plan.coveredAnchorIds, [a[0], a[1]]);
  assert(!JSON.stringify(Engine.validate(data).dataset).includes('grossImpressions'));
  assert(!JSON.stringify(Engine.summarize(data, plan.selection, brief)).includes('audienceFit'));
});

test('missing coverage and unmatched media types never enter automatic combinations', () => {
  const data = dataset([resource('UNMATCHED', { coverageAnchorIds: [a[1]] }), resource('NO-COVERAGE', { coverageAnchorIds: [] }), resource('METRO', { mediaType: 'metro' })]);
  const plan = Engine.plan(data, { ...brief, mediaTypes: ['bus'] });
  assert.equal(Object.keys(plan.selection).length, 0);
  assert.equal(plan.excludedStats.missingCoverage, 2);
  assert.equal(plan.excludedStats.mediaTypeMismatch, 1);
});

test('an uncovered requested anchor prevents the post-coverage volume-fill stage', () => {
  const plan = Engine.plan(dataset([resource('ONLY-A', { available: 50 })]), { ...brief, anchorIds: [a[0], a[1]] });
  assert.equal(Engine.quantity(plan.selection, 'ONLY-A'), 1);
  assert.deepEqual(plan.uncoveredAnchorIds, [a[1]]);
  assert(plan.warnings.some(warning => warning.includes('未进入')));
});

test('explicit exclusions persist and cannot be added back by planning', () => {
  const plan = Engine.plan(dataset([resource('EXCLUDED'), resource('OK')]), brief, ['EXCLUDED']);
  assert.equal(Engine.quantity(plan.selection, 'EXCLUDED'), 0);
  assert(Engine.quantity(plan.selection, 'OK') > 0);
  assert.equal(plan.excludedStats.excludedByUser, 1);
});

test('manual over-budget, overstock, incomplete, unknown and malformed quantities are rejected', () => {
  const data = dataset();
  for (const selection of [{ 'BUS-01': 50 }, { 'BUS-01': 51 }, { 'BUS-01': '1' }, { 'BUS-01': -1 }, { 'BUS-01': 1.2 }, { UNKNOWN: 1 }, { 'BUS-01': NaN }, { 'BUS-01': Infinity }]) {
    assert(Engine.checkSelection(data, selection, brief).length);
    assert.doesNotThrow(() => Engine.summarize(data, selection, brief));
  }
});

test('data validation rejects negative/fractional money, malformed ranges, duplicate IDs and oversized stock', () => {
  for (const override of [{ available: 5001 }, { available: 1.5 }, { price: { ...busPrice('A+'), monthlyLow: -1 } }, { price: { ...busPrice('A+'), productionLow: 5.5 } }, { price: { ...busPrice('A+'), monthlyLow: 60000 } }, { sourceUrl: 'javascript:alert(1)' }]) assert(Engine.validate(dataset([resource('BAD', override)])).errors.length);
  assert(Engine.validate(dataset([resource('SAME'), resource('SAME')])).errors.length);
});

test('budget and billing-month validation is explicit and defaults to one month only', () => {
  assert.deepEqual(Engine.plan(dataset(), { ...brief, months: undefined }).errors, []);
  for (const override of [{ budget: 999999 }, { budget: 5000001 }, { budget: 1000000.5 }, { months: 0 }, { months: 13 }, { months: 1.5 }, { mediaTypes: [] }, { anchorIds: [] }]) assert(Engine.plan(dataset(), { ...brief, ...override }).errors.length);
});
