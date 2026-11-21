/* Campaign assumptions and execution arithmetic. All capacity values are team inputs, not supplier promises. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CampaignPlanning=api;})(globalThis,function createPlanning(){
 'use strict';
 const DAY=86400000;
 const defaults=()=>({clientAlias:'某全国连锁咖啡品牌上海市场',businessGoal:'验证核心门店周边的通勤场景，能否帮助消费者形成“附近有门店、可线下体验”的认知。此为模拟生意需求，尚无客户经营数据。',primaryGoal:'认知',successMeasure:'投前与投后在相同商圈、相同人群口径开展品牌及门店关联认知调查；样本量、基线和提升目标需客户确认。扫码仅作次级观测，不等同增量到店。',upCapacity:6,downCapacity:6,weatherBuffer:2,minPublishDays:14,prepDays:10,executionReserve:0});
 function settings(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('需求设置须为对象');
  const out={...defaults(),...raw};
  for(const k of ['clientAlias','businessGoal','successMeasure'])if(typeof out[k]!=='string'||out[k].length>1500||!out[k].trim())throw Error(k+' 须填写非空文本，最多1500字');
  if(!['认知','到店','促销','拉新'].includes(out.primaryGoal))throw Error('请选择一个campaign主目标');
  for(const [k,min,max] of [['upCapacity',1,500],['downCapacity',1,500],['weatherBuffer',0,30],['minPublishDays',1,365],['prepDays',1,60],['executionReserve',0,5000000]])if(!Number.isSafeInteger(out[k])||out[k]<min||out[k]>max)throw Error(k+' 超出允许整数范围');
  return Object.fromEntries(Object.keys(defaults()).map(k=>[k,out[k]]));
 }
 function date(s){const d=Date.parse(s+'T00:00:00Z');if(!Number.isFinite(d)||new Date(d).toISOString().slice(0,10)!==s)throw Error('档期日期无效');return d;}
 const iso=d=>new Date(d).toISOString().slice(0,10);
 function execution(brief,result,raw){
  const s=settings(raw),start=date(brief.start),end=date(brief.end),days=Math.floor((end-start)/DAY)+1;if(days<1)throw Error('档期结束早于开始');
  const up=Math.ceil(result.busUnits/s.upCapacity),down=Math.ceil(result.busUnits/s.downCapacity),used=up+down+2*s.weatherBuffer;
  let low=0,high=5000;while(low<high){const mid=Math.ceil((low+high)/2);if(Math.ceil(mid/s.upCapacity)+Math.ceil(mid/s.downCapacity)+2*s.weatherBuffer+s.minPublishDays<=days)low=mid;else high=mid-1;}
  const publishDays=result.busUnits>0?Math.max(0,days-used):0,releaseStart=iso(start+(up+s.weatherBuffer)*DAY),releaseEnd=iso(end-(down+s.weatherBuffer)*DAY);
  return {days,upNights:up,downNights:down,bufferNights:2*s.weatherBuffer,publishDays,releaseStart,releaseEnd,maxBusUnits:low,prepStart:iso(start-s.prepDays*DAY),installStart:brief.start,installEnd:up?iso(start+(up-1)*DAY):null,removalStart:down?iso(end-(down-1)*DAY):null,removalEnd:brief.end,feasible:result.busUnits>0&&result.metroUnits===0&&publishDays>=s.minPublishDays,metroPending:result.metroUnits>0,assumptionOnly:true};
 }
 function costs(result,months,raw){const s=settings(raw);let mediaLow=0,mediaHigh=0,productionLow=0,productionHigh=0;for(const r of result.rows){if(!['monthlyLow','monthlyHigh','productionLow','productionHigh'].every(k=>Number.isSafeInteger(r.price[k])))return {complete:false};mediaLow+=r.quantity*months*r.price.monthlyLow;mediaHigh+=r.quantity*months*r.price.monthlyHigh;productionLow+=r.quantity*r.price.productionLow;productionHigh+=r.quantity*r.price.productionHigh;}return{complete:true,mediaLow,mediaHigh,productionLow,productionHigh,reserve:s.executionReserve,envelopeHigh:mediaHigh+productionHigh+s.executionReserve,reserveConfirmed:false};}
 function strategyPlan(engine, dataset, brief, excluded, cfg, scheduleFirst) {
   if (!scheduleFirst) return engine.plan(dataset, brief, excluded);
   const spendLimit = brief.budget - cfg.executionReserve;
   const failed = message => ({selection: Object.create(null), errors: [message], method: '档期优先'});
   if (spendLimit < 0) return failed('执行预算预留超过总预算，请调整预留。');
   if (!brief.mediaTypes.includes('bus')) return failed('档期优先需要公交施工产能；地铁施工条件待核。');
   let maxBusUnits;
   try {
     maxBusUnits = execution(brief, {busUnits: 0, metroUnits: 0}, cfg).maxBusUnits;
   } catch (error) {
     return failed(error.message);
   }
   // The supplied installation/removal capacities only cover bus wraps.
   const plan = engine.plan(dataset, {...brief, mediaTypes: ['bus']}, excluded, {maxBusUnits, spendLimit});
   plan.method += '；已加入团队施工产能与执行预留约束';
   return plan;
 }
 function strategyComparison(engine, dataset, brief, excluded, cfg) {
   function assess(scheduleFirst) {
     const plan = strategyPlan(engine, dataset, brief, excluded, cfg, scheduleFirst);
     if (plan.errors.length) return {reason: plan.errors[0]};
     const result = engine.summarize(dataset, plan.selection, brief);
     const window = execution(brief, result, cfg);
     if (!result.feasible) {
       if (scheduleFirst && !window.maxBusUnits && brief.mediaTypes.includes('bus')) return {reason: '当前档期、产能与最低天数无法容纳一辆公交的上下刊。'};
       return {reason: scheduleFirst ? '扣除预留后，当前库存、报价和覆盖条件下没有可选组合。' : '当前库存、报价和覆盖条件下没有可选组合。'};
     }
     return {selection: plan.selection, result, window};
   }
   return {budget: assess(false), schedule: assess(true)};
 }
 return{defaults,settings,execution,costs,strategyPlan,strategyComparison,createPlanning};
});
