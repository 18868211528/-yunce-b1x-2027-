/* Interactive launcher; private browser data stays beside source and is excluded from delivery. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
async function main(){
 console.log('云策2027 完整版：启动本地服务和比赛浏览器。关闭此窗口将停止服务。');
 let pw;try{pw=require('playwright');}catch{
  console.log('首次运行正在安装浏览器连接依赖，请保持联网……');
  const installed=cp.spawnSync(process.platform==='win32'?'npm.cmd':'npm',['install','--registry=https://registry.npmjs.org'],{cwd:__dirname,stdio:'inherit',shell:process.platform==='win32'});
  if(installed.status!==0)throw Error('依赖安装失败。可先离线使用工作台，联网后重新运行启动器。');
  pw=require('playwright');
 }
 const port=Number(process.env.YUNCE_PORT||8766),url='http://127.0.0.1:'+port;
 let already=false;try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1200)});already=r.ok&&(await r.json()).localService===true;}catch{}
 const server=already?null:require('./campaign-server.cjs').start(port);
 if(server)await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 let browser;try{browser=await pw.chromium.connectOverCDP('http://127.0.0.1:9228',{timeout:1500});}catch{
  const candidates=[process.env['PROGRAMFILES(X86)']&&path.join(process.env['PROGRAMFILES(X86)'],'Microsoft/Edge/Application/msedge.exe'),process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,'Microsoft/Edge/Application/msedge.exe'),process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  const executablePath=candidates.find(p=>fs.existsSync(p));if(!executablePath)throw Error('未找到 Edge 或 Chrome。请安装任一种后重试。');
  const context=await pw.chromium.launchPersistentContext(path.join(__dirname,'.browser-profile'),{executablePath,headless:false,viewport:null,acceptDownloads:true,args:['--remote-debugging-port=9228','--remote-debugging-address=127.0.0.1','--start-maximized']});
  browser=context.browser();
 }
 const context=browser.contexts()[0],pages=context.pages();
 let red=pages.find(p=>p.url().includes('flairmedia.com.cn:881'));if(!red){red=await context.newPage();await red.goto('https://flairmedia.com.cn:881/index',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});}
 let app=context.pages().find(p=>p.url().startsWith(url));if(!app){app=await context.newPage();await app.goto(url);}
 await app.bringToFront();
 console.log('已打开 '+url+' 。模型连接设置中输入比赛密钥；库存同步前在红豆标签页登录。');
 console.log('Python 3 用于读取库存导出；未安装时同步会说明原因，离线方案仍可用。');
 await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 if(server)await new Promise(resolve=>server.close(resolve));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
