const test=require('node:test'),assert=require('node:assert/strict'),P=require('../campaign-planning.js'),E=require('../campaign-engine.js'),fs=require('node:fs'),path=require('node:path');
const b={start:'2027-03-01',end:'2027-03-31'},units=n=>({busUnits:n,metroUnits:0});
test('28 buses reserve both installation and removal nights inside the queried period',()=>{const x=P.execution(b,units(28),P.defaults());assert.equal(x.upNights,5);assert.equal(x.downNights,5);assert.equal(x.bufferNights,4);assert.equal(x.publishDays,17);assert.equal(x.releaseStart,'2027-03-08');assert.equal(x.releaseEnd,'2027-03-24');assert.equal(x.maxBusUnits,36);assert.equal(x.feasible,true);assert.equal(x.assumptionOnly,true);});
test('71 buses can fit the media budget while failing the common publication requirement',()=>{const x=P.execution(b,units(71),P.defaults());assert.equal(x.publishDays,3);assert.equal(x.feasible,false);const y=P.execution(b,units(71),{...P.defaults(),upCapacity:12,downCapacity:12});assert.equal(y.publishDays,15);assert.equal(y.feasible,true);});
test('unknown metro capacity and zero selected buses cannot be treated as execution approval',()=>{assert.equal(P.execution(b,{busUnits:0,metroUnits:2},P.defaults()).feasible,false);assert.equal(P.execution(b,units(0),P.defaults()).publishDays,0);});
test('invalid capacities, text, goals and calendar dates are rejected',()=>{for(const raw of [{upCapacity:0},{downCapacity:2.5},{weatherBuffer:-1},{executionReserve:-1},{primaryGoal:'销售额保证'},{clientAlias:''}])assert.throws(()=>P.settings(raw));assert.throws(()=>P.execution({start:'2027-02-31',end:'2027-03-31'},units(28),P.defaults()));});
test('execution ceiling and reserve constrain the same stock and pricing engine',()=>{const d=JSON.parse(fs.readFileSync(path.join(__dirname,'../support/campaign-dataset.json'),'utf8'));const brief={...d.defaultBrief,budget:5000000};const p=E.plan(d,brief,[],{maxBusUnits:36,spendLimit:4000000}),s=E.summarize(d,p.selection,brief);assert.equal(s.busUnits,36);assert(s.high<=4000000);assert.equal(s.coveredAnchorIds.length,6);assert(s.feasible);assert(E.plan(d,brief,[],{maxBusUnits:-1}).errors.length);});
test('budget breakdown reconciles media plus one production round and marks reserve unconfirmed',()=>{const c=P.costs({rows:[{quantity:3,price:{monthlyLow:40000,monthlyHigh:60000,productionLow:5000,productionHigh:10000}}]},2,{...P.defaults(),executionReserve:20000});assert.equal(c.mediaLow,240000);assert.equal(c.productionLow,15000);assert.equal(c.envelopeHigh,410000);assert.equal(c.reserveConfirmed,false);});

const comparisonData = JSON.parse(fs.readFileSync(path.join(__dirname, '../support/campaign-dataset.json'), 'utf8'));
const marchBrief = { ...comparisonData.defaultBrief, budget: 5000000 };

test('both suggestions use the same real March evidence and reconcile their cost, coverage and inclusive dates', () => {
  const {budget, schedule} = P.strategyComparison(E, comparisonData, marchBrief, [], P.defaults());
  for (const [candidate, units, lines, low, high, from, to] of [
    [budget, 71, 14, 3215000, 4990000, '2027-03-15', '2027-03-17'],
    [schedule, 36, 8, 1640000, 2540000, '2027-03-09', '2027-03-23']
  ]) {
    assert.equal(candidate.result.busUnits, units);
    assert.equal(candidate.result.resourceCount, lines);
    assert.equal(candidate.result.low, low);
    assert.equal(candidate.result.high, high);
    assert.equal(candidate.result.coveredAnchorIds.length, 6);
    assert.equal(candidate.window.releaseStart, from);
    assert.equal(candidate.window.releaseEnd, to);
    assert.equal(candidate.window.publishDays, (Date.parse(to) - Date.parse(from)) / 86400000 + 1);
  }
});

test('excluded stock is excluded from both suggestions and infeasible reserves and windows have explicit reasons', () => {
  const allIds = comparisonData.resources.map(resource => resource.id);
  const none = P.strategyComparison(E, comparisonData, marchBrief, allIds, P.defaults());
  assert(none.budget.reason && none.schedule.reason);
  const tight = P.strategyComparison(E, comparisonData, marchBrief, [], { ...P.defaults(), minPublishDays: 31 });
  assert.equal(tight.budget.result.busUnits, 71);
  assert(tight.schedule.reason);
  const reserved = P.strategyComparison(E, comparisonData, { ...marchBrief, budget: 1000000 }, [], { ...P.defaults(), executionReserve: 1100000 });
  assert.equal(reserved.budget.result.busUnits, 14);
  assert.match(reserved.schedule.reason, /预留/);
});

test('schedule-first only adopts media with a supported installation model when imported inventory includes priced metro', () => {
  const bus = comparisonData.resources.find(row => row.available > 0 && row.mediaType === 'bus' && row.coverageAnchorIds.length);
  const metro = { ...bus, id: 'TEST-METRO', name: '测试地铁', mediaType: 'metro', available: 4 };
  const data = { ...comparisonData, resources: [bus, metro] };
  const brief = { ...marchBrief, anchorIds: bus.coverageAnchorIds, mediaTypes: ['bus', 'metro'] };
  const mixed = P.strategyComparison(E, data, brief, [], P.defaults());
  assert.equal(mixed.budget.result.metroUnits, 4);
  assert.equal(mixed.budget.window.metroPending, true);
  assert.equal(mixed.schedule.result.metroUnits, 0);
  assert.equal(mixed.schedule.window.feasible, true);
  const metroOnly = P.strategyComparison(E, data, { ...brief, mediaTypes: ['metro'] }, [], P.defaults());
  assert.match(metroOnly.schedule.reason, /地铁/);
});
