// Isolated fixture acceptance; never connects to installed hosts or shared browsers.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const fixture=JSON.parse(await fs.readFile(path.join(root,'test/fixtures/host-detail-tabs.json'),'utf8'));
const stats=JSON.parse(await fs.readFile(path.join(root,'test/fixtures/beszel/system-stats.json'),'utf8')).items[0].stats;
let api=structuredClone(fixture);
const require=createRequire(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT?path.join(path.resolve(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT),'package.json'):import.meta.url);
const {chromium}=require('playwright');
const out=process.argv[2],mode=process.argv[3]??'all';
if(out)await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url??'/', 'http://localhost').pathname;
  if(pathname==='/api/fleet'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(api));return;}
  if(pathname==='/api/events'){res.end('{"events":[]}');return;}
  const file=path.join(root,'public',pathname==='/'?'index.html':pathname.slice(1));
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'} as Record<string,string>)[path.extname(file)]??'application/octet-stream');
  res.end(await fs.readFile(file));
 }catch{res.statusCode=404;res.end();}
});
server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address();if(!address||typeof address==='string')throw Error('fixture server unavailable');
const browser=await chromium.launch({headless:true,channel:'chrome',chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
 if(mode==='large')await page.addInitScript(()=>{
  const state=globalThis as typeof globalThis & {disclosureScans:{calls:number;rows:number}};
  state.disclosureScans={calls:0,rows:0};
  const query=Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll=function(this:Element,selector:string){
   const nodes=query.call(this,selector);
   if(this.id==='agent-sessions'){state.disclosureScans.calls++;state.disclosureScans.rows+=nodes.length;}
   return nodes;
  } as typeof query;
 });
 await page.goto('http://127.0.0.1:'+address.port);await page.locator('#hosts .host').first().waitFor();
 const refresh=async()=>{const done=page.waitForResponse((r:{url():string})=>new URL(r.url()).pathname==='/api/events');await page.locator('#refresh').click();await done;};
 const capture=async(prefix:string)=>{
  if(!out)return;
  for(const [label,width,height] of [['desktop',1440,1000],['phone',390,844]] as const){
   await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,prefix+'-'+label+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
 };
 if(mode==='large'){
  const results:{sessions:number;operation:string;calls:number;rows:number}[]=[];
  const resetScans=()=>page.evaluate(()=>{(globalThis as typeof globalThis & {disclosureScans:{calls:number;rows:number}}).disclosureScans={calls:0,rows:0};});
  const settle=async()=>{await page.evaluate(()=>new Promise<void>(resolve=>setTimeout(resolve,50)));};
  const record=async(sessions:number,operation:string)=>{
   await settle();
   const scan=await page.evaluate(()=>(globalThis as typeof globalThis & {disclosureScans:{calls:number;rows:number}}).disclosureScans);
   results.push({sessions,operation,...scan});
  };
  const details=page.locator('#agent-sessions details');
  for(const sessions of [100,1000]){
   api=structuredClone(fixture);
   const inventory=api.hosts[0].snapshot.agentSessions,sample=inventory.sessions[0];
   inventory.sessions=Array.from({length:sessions},(_,index)=>({...sample,title:'Example session '+index,createdAt:new Date(Date.parse(api.serverTime)-3600000+index).toISOString()}));
   await page.reload();await page.waitForFunction((count:number)=>document.querySelectorAll('#agent-sessions details').length===count,sessions);
   await record(sessions,'initial');
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(node=>node.open)),true);
   await resetScans();await refresh();await record(sessions,'refresh');
   await resetScans();await page.getByRole('button',{name:'全部收合',exact:true}).click();await record(sessions,'bulk-collapse');
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(node=>!node.open)),true);
   await resetScans();await page.getByRole('button',{name:'全部展開',exact:true}).click();await record(sessions,'bulk-expand');
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(node=>node.open)),true);
   await resetScans();await details.first().locator('summary').click();await record(sessions,'individual');
   assert.equal(await details.first().evaluate((node:HTMLDetailsElement)=>node.open),false);
   assert.equal(await page.getByRole('button',{name:'全部展開',exact:true}).count(),1);
   await resetScans();await refresh();await record(sessions,'mixed-refresh');
   assert.equal(await details.first().evaluate((node:HTMLDetailsElement)=>node.open),false,'real user collapse persists');
   assert.equal(await details.nth(1).evaluate((node:HTMLDetailsElement)=>node.open),true,'other rows remain expanded');
   await resetScans();await page.getByRole('button',{name:'全部展開',exact:true}).click();await record(sessions,'mixed-bulk-expand');
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(node=>node.open)),true);
  }
  console.log(JSON.stringify({disclosureScans:results}));
  if(out)await fs.writeFile(path.join(out,'disclosure-scans.json'),JSON.stringify(results,null,2)+'\n');
  for(const result of results){
   assert.ok(result.calls<=3&&result.rows<=result.sessions*3,`bounded linear disclosure work for ${result.sessions} rows on ${result.operation}: ${result.calls} scans, ${result.rows} elements`);
  }
  assert.deepEqual(errors,[]);
 }else if(mode==='before'){
  await page.locator('#tab-agents').click();await capture('before');
 }else{
  if(mode==='all'||mode==='layout'){
   const tabs=page.locator('#host-tabs [role=tab]');
   assert.deepEqual(await tabs.allTextContents(),['工作階段','磁碟容量','功能檢查與最近錯誤','最近事件','服務']);
   assert.equal(await page.locator('#tab-agents').getAttribute('aria-selected'),'true');
   assert.equal(await page.locator('#resource-panel').getAttribute('role'),null);
   assert.equal(await page.locator('#resource-panel').evaluate((node:HTMLElement)=>Boolean(node.compareDocumentPosition(document.querySelector('#host-tabs')!)&Node.DOCUMENT_POSITION_FOLLOWING)),true);
   for(const tab of await tabs.all()){await tab.click();assert.equal(await page.locator('#resources').isVisible(),true);}
   await page.evaluate(()=>localStorage.setItem('host-monitor.hostTabs.v1',JSON.stringify({order:['events','resources','agents','services','disks','checks'],selected:'resources'})));
   await page.reload();await page.locator('#tab-agents').waitFor();
   assert.deepEqual(await tabs.allTextContents(),['最近事件','工作階段','服務','磁碟容量','功能檢查與最近錯誤']);
   assert.equal(await page.locator('#tab-agents').getAttribute('aria-selected'),'true');
   await page.locator('#tab-agents').dragTo(page.locator('#tab-events'));
   assert.equal((await tabs.allTextContents())[0],'工作階段');
   await page.locator('.tab-order-menu summary').click();await page.locator('#move-tab-right').click();
   const order=await tabs.allTextContents();await page.reload();await page.locator('#tab-agents').waitFor();assert.deepEqual(await tabs.allTextContents(),order);
   await page.evaluate(()=>localStorage.removeItem('host-monitor.hostTabs.v1'));await page.reload();await page.locator('#tab-agents').waitFor();
  }
  if(mode==='all'||mode==='toggle'){
   await page.locator('#tab-agents').click();
   const details=page.locator('#agent-sessions details');
   assert.equal(await details.count(),6);
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(n=>n.open)),true,'session details default expanded');
   await page.getByRole('button',{name:'全部收合',exact:true}).click();
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(n=>!n.open)),true);
   await refresh();assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(n=>!n.open)),true,'collapse survives polling');
   await page.locator('#agent-session-filters').getByRole('tab',{name:/Working/}).click();
   await page.getByRole('button',{name:'全部展開',exact:true}).click();
   await page.locator('#agent-session-filters').getByRole('tab',{name:/All/}).click();
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(n=>n.open)),true,'toggle includes filtered rows');
   await details.first().locator('summary').click();await refresh();
   assert.equal(await details.first().evaluate((node:HTMLDetailsElement)=>node.open),false,'individual collapse survives polling');
   await page.locator('#hosts .host').filter({hasText:'android-a'}).click();
   assert.equal(await page.locator('#toggle-session-details').isVisible(),false);
   await page.locator('#hosts .host').first().click();
   assert.equal(await details.first().evaluate((node:HTMLDetailsElement)=>node.open),false,'individual choice survives host switches');
   await page.getByRole('button',{name:'全部展開',exact:true}).click();
   await capture('after');
   await page.setViewportSize({width:390,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.getByRole('button',{name:'全部收合',exact:true}).click();
   assert.equal(await details.evaluateAll((nodes:HTMLDetailsElement[])=>nodes.every(n=>!n.open)),true);
   await page.setViewportSize({width:1440,height:1000});
  }
  if(mode==='all'||mode==='metrics'){
   const host=api.hosts[0];host.snapshot.resources='external';host.snapshot.platform='darwin';
   host.beszel={status:'ok',recordedAt:api.serverTime,lastSuccess:api.serverTime,cpuBusy:stats.cpu,memory:{total:16*2**30,used:6*2**30,available:10*2**30},disks:[{source:'Beszel',type:'root',mount:'/',total:100*2**30,used:40*2**30,available:60*2**30,percent:40}],gpus:[{name:'Example GPU',busy:27}]};
   await refresh();
   const card=page.locator('#hosts .host').first();
   assert.match(await card.innerText(),/CPU 3.1%.*記憶體可用 10.0 GiB.*磁碟 40.*GPU 27.0%/s);
   assert.match(await page.locator('#resources').innerText(),/3.1%.*10.0 GiB.*40%.*27.0%/s);
   await capture('beszel');
   for(const status of ['stale','unavailable']){
    host.beszel.status=status;await refresh();
    for(const target of [card,page.locator('#resources')]){
     assert.match(await target.innerText(),/無資料.*Beszel.*(過期|讀不到)/s);
     assert.doesNotMatch(await target.innerText(),/3.1%|10.0 GiB|27.0%|40%/);
    }
    await page.locator('#tab-disks').click();assert.equal(await page.locator('#disks .disk').count(),0,'old disk values are not presented as current');
   }
   host.beszel=undefined;await refresh();assert.match(await card.innerText(),/無資料.*未設定/);
   host.beszel={status:'ok',recordedAt:api.serverTime,disks:[],gpus:[]};await refresh();
   assert.match(await page.locator('#resources').innerText(),/無資料.*未提供/s);
   host.beszel={status:'ok',recordedAt:api.serverTime,cpuBusy:3.1,memory:{total:16*2**30,used:6*2**30,available:10*2**30},disks:[],gpus:[]};
   host.snapshot.agentless=true;await refresh();assert.match(await card.innerText(),/CPU 3.1%/,'agentless delegated hosts also use Beszel');
  }
  assert.deepEqual(errors,[]);
 }
 console.log(JSON.stringify({ok:true,mode,widths:mode==='large'?[1440]:[1440,390]}));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
