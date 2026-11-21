/* Queries only the logged-in task browser. No passwords or cookies are read/exported. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
let connection,busy=false;
function playwright(){try{return require('playwright')}catch{return require('../qa/node_modules/playwright')}}
function support(name){const base=fs.existsSync(path.join(__dirname,'support'))?path.join(__dirname,'support'):path.join(__dirname,'../official');return JSON.parse(fs.readFileSync(path.join(base,name),'utf8'));}
async function sync(input){
 if(busy)throw Error('已有同步进行中，请稍后重试');
 if(!/^2027-\d{2}-\d{2}$/.test(input.start||'')||!/^2027-\d{2}-\d{2}$/.test(input.end||'')||Date.parse(input.start)>Date.parse(input.end))throw Error('请填写有效2027完整档期');
 const base=support('campaign-dataset.json');if(input.brand!==base.brand.brand)throw Error('请先导入当前客户的官方门店和覆盖依据');
 busy=true;let tmp;
 try{
  if(!connection?.isConnected())connection=await playwright().chromium.connectOverCDP('http://127.0.0.1:9228',{timeout:8000});
  const ctx=connection.contexts()[0];let page=ctx.pages().find(p=>p.url().includes('/medium/inventory/inventory-bus'));
  if(!page){page=ctx.pages().find(p=>p.url().includes('flairmedia.com.cn:881/'));if(!page)throw Error('请先在比赛浏览器登录红豆系统');const menu=page.getByRole('menuitem',{name:'公交媒体库',exact:true});if(!await menu.isVisible())await page.getByRole('menuitem',{name:'媒体管理',exact:true}).click();await menu.click();}
  page.setDefaultTimeout(10000);await page.getByRole('combobox',{name:'开始日期',exact:true}).waitFor();
  // Clear old range first so a later start date is not reverted by the date picker.
  await page.getByRole('combobox',{name:'开始日期',exact:true}).fill('');await page.getByRole('combobox',{name:'结束日期',exact:true}).fill(input.end);await page.getByRole('combobox',{name:'结束日期',exact:true}).press('Tab');await page.getByRole('combobox',{name:'开始日期',exact:true}).fill(input.start);await page.getByRole('combobox',{name:'开始日期',exact:true}).press('Tab');
  if(await page.getByRole('combobox',{name:'开始日期',exact:true}).inputValue()!==input.start||await page.getByRole('combobox',{name:'结束日期',exact:true}).inputValue()!==input.end)throw Error('系统未接受目标日期，已停止同步');
  const responsePromise=page.waitForResponse(r=>r.url().includes('/media-inventory/bus/page')&&r.url().includes('startDate='+input.start)&&r.url().includes('endDate='+input.end),{timeout:25000}).catch(e=>({error:e.message}));await page.getByRole('button',{name:'搜索',exact:true}).click();const response=await responsePromise;if(response.error)throw Error('库存查询超时');const j=await response.json();if(j.code!==0)throw Error('库存系统拒绝查询，请重新登录');
  const dlPromise=page.waitForEvent('download',{timeout:30000}).catch(e=>({error:e.message}));await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).filter({visible:true}).click();const dl=await dlPromise;if(dl.error)throw Error('导出未完成，请检查系统提示');
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yunce-stock-'));const file=path.join(tmp,'inventory.xlsx');await dl.saveAs(file);
  const args=[path.join(__dirname,'read-xlsx.py'),file];let parsed=cp.spawnSync('py',args,{encoding:'utf8',maxBuffer:10000000,windowsHide:true});if(parsed.error)parsed=cp.spawnSync('python3',args,{encoding:'utf8',maxBuffer:10000000});if(parsed.status!==0)throw Error('实时同步需要Python 3读取系统导出；原数据已保留');
  const adapter=fs.existsSync(path.join(__dirname,'normalize-campaign.cjs'))?require('./normalize-campaign.cjs'):require('../normalize-campaign.cjs');
  const dataset=adapter.buildDataset({brandInfo:support('brand-anchors.json'),coverageNormalized:support('coverage-normalized.json'),pricingRules:support('pricing-rules.json'),busExportRows:JSON.parse(parsed.stdout),busQuery:{start:input.start,end:input.end,checkedAt:new Date().toISOString(),source:'红豆公交媒体库比赛专户 · 当前档期重新查询',pageUrl:page.url(),queryResponses:[{data:j}]},metroExportRows:support('红豆地铁库存_2027-03-01_2027-03-31.json'),metroQuery:support('redbean-metro-query.json'),busSourceFile:'红豆公交库存_'+input.start+'_'+input.end+'.xlsx'});
  const checked=require('./campaign-engine.js').validate(dataset);if(checked.errors.length)throw Error(checked.errors.slice(0,3).join('；'));return dataset;
 }catch(e){if(/ECONNREFUSED|connectOverCDP|Cannot find module/.test(e.message))throw Error('请启动比赛浏览器并完成登录；实时模式需安装playwright依赖');throw e;}
 finally{busy=false;if(tmp){const resolved=path.resolve(tmp);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('yunce-stock-'))fs.rmSync(resolved,{recursive:true,force:true});}}
}
module.exports={sync};
