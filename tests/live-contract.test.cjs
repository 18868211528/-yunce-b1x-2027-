const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {buildDataset}=require('../normalize-campaign.cjs'),E=require('../campaign-engine.js');
const read=n=>JSON.parse(fs.readFileSync(path.join(__dirname,'../support',n),'utf8'));
test('a new bus period keeps original metro evidence and excludes unconfirmed metro from planning',()=>{
 const coverage=read('coverage-normalized.json');
 const d=buildDataset({brandInfo:read('brand-anchors.json'),coverageNormalized:coverage,pricingRules:read('pricing-rules.json'),busExportRows:[['resourceType','线路','运营公司','线路等级','媒体类型','总车辆数（可售）','保养影响容量','合同车数','预定车数','空位数','可能续约数'],['bus',coverage.busCandidates[0].routeName,'测试运营公司','A+','大三侧',10,0,0,0,7,0]],busQuery:{start:'2027-04-01',end:'2027-04-30',checkedAt:'2026-11-21T07:40:00Z',source:'测试夹具'},metroQuery:read('redbean-metro-query.json')});
 assert.deepEqual(E.validate(d).errors,[]);assert.equal(d.inventoryPeriod.start,'2027-04-01');
 for(const r of d.resources.filter(r=>r.mediaType==='metro')){assert.equal(r.inventoryPeriod.start,'2027-03-01');assert.equal(r.available,null);assert.match(r.evidence,/不同档期/);}
 assert.equal(d.sourceCounts.busExportRowCount,1);assert(!d.resources.filter(r=>r.mediaType==='bus').some(r=>r.sourceRef.includes('431')));
});
test('invalid calendar dates and reversed ranges are rejected before browser interaction',async()=>{
 const {sync}=require('../live-sync.cjs');
 for(const [start,end] of [['2027-02-31','2027-03-31'],['2027-04-30','2027-04-01'],['2028-01-01','2028-01-31']])await assert.rejects(sync({start,end}),/有效2027/);
});
test('local server isolates private files, rejects cross-origin calls, and returns an AI receipt without changing plan input',async()=>{
 const {createServer}=require('../campaign-server.cjs'),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port,realFetch=global.fetch;let upstreamBody;
 global.fetch=async(u,o)=>u==='https://token.b1x.work/v1/chat/completions'?(upstreamBody=JSON.parse(o.body),new Response(JSON.stringify({choices:[{message:{content:'测试模型解读'}}]}),{status:200,headers:{'Content-Type':'application/json'}})):realFetch(u,o);
 try{
  assert.equal((await realFetch(url+'/live-sync.cjs')).status,404);
  const body={key:'TEST_SECRET_NOT_FOR_EXPORT',model:'deepseek-v4.1-flash-1017',brief:{budget:2000000},summary:{high:1980000},resources:[]},before=JSON.stringify(body);
  assert.equal((await realFetch(url+'/api/strategy',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:before})).status,403);
  const r=await realFetch(url+'/api/strategy',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:before}),out=await r.json();assert.equal(r.status,200);assert.equal(out.strategy,'测试模型解读');assert.equal(out.receipt.model,body.model);assert(Number.isFinite(Date.parse(out.receipt.completedAt)));assert(!JSON.stringify(out).includes(body.key));assert.equal(JSON.stringify(body),before);assert.match(upstreamBody.messages[0].content,/不改变报价/);
 }finally{global.fetch=realFetch;await new Promise(r=>server.close(r));}
});
