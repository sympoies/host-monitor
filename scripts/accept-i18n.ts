// Isolated, fixture-backed language acceptance: renders every host and tab in English and Traditional Chinese at desktop
// and phone width from synthetic data on a loopback server, and checks the language switch. It never connects to
// installed hosts or shared browsers. Usage: node scripts/accept-i18n.ts [evidence-dir] (after `npm run build`).
import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';
import {dictionaries} from '../public/i18n.ts';
const root=path.resolve(import.meta.dirname,'..'),out=process.argv[2];
const fixture=JSON.parse(await fs.readFile(path.join(root,'test/fixtures/host-detail-tabs.json'),'utf8'));
const stats=JSON.parse(await fs.readFile(path.join(root,'test/fixtures/beszel/system-stats.json'),'utf8')).items[0].stats;
const at=fixture.serverTime as string,linux=fixture.hosts[0],agentless=fixture.hosts[1];
const job=(id:string,status:string)=>({id,label:'Example job',status,reasonCode:status==='healthy'?'success':'snapshot_missing',registryRevision:'a'.repeat(40),sourceRevision:'b'.repeat(40),runtimeRevision:'sha256:'+'c'.repeat(64),outcome:status==='healthy'?'success':undefined,lastSuccess:at,nextDue:at,ageSeconds:5,retryCount:0,retryBudget:2,lastFailure:status==='healthy'?null:{outcome:'timeout',reasonCode:'timeout',at}});
const mac={name:'mac-a',status:'online',stale:false,lastSuccess:at,beszel:{status:'ok',recordedAt:at,lastSuccess:at,cpuBusy:stats.cpu,memory:{total:16*2**30,used:6*2**30,available:10*2**30},gpus:[{name:'Example GPU',busy:27}],disks:[{source:'Beszel',type:'root',mount:'/',total:100*2**30,used:40*2**30,available:60*2**30,percent:40}]},
 snapshot:{...structuredClone(agentless.snapshot),host:'mac-a',agentless:undefined,jobs:{status:'ok',items:[job('job-a','healthy'),job('job-b','unknown')]},agentSessions:{status:'disabled',sessions:[]}}};
const offline={...structuredClone(linux),name:'offline-a',status:'offline',stale:true,reachability:{lastSeen:'2026-10-03T09:00:00.000Z',nextCheck:'2026-10-03T10:05:00.000Z',checks:3}};offline.snapshot.host='offline-a';
const fleet={...fixture,hosts:[...fixture.hosts,mac,offline],defaultOrder:[...fixture.defaultOrder,'mac-a','offline-a']};
const events=['attention','recovered','offline','online'].map((type,index)=>({at:new Date(Date.parse(at)-index*60000).toISOString(),host:'linux-a',type,kind:'service',title:'worker.service',severity:type==='attention'?'error':'warning',detail:index?undefined:'Failed'}));
const require=createRequire(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT?path.join(path.resolve(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT),'package.json'):import.meta.url);
const {chromium}=require('playwright');
if(out)await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url??'/','http://localhost').pathname;
  if(pathname==='/api/fleet'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fleet));return;}
  if(pathname==='/api/events'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({events}));return;}
  const file=path.join(root,'public',pathname==='/'?'index.html':pathname.slice(1));
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'} as Record<string,string>)[path.extname(file)]??'application/octet-stream');
  res.end(await fs.readFile(file));
 }catch{res.statusCode=404;res.end();}
});
server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address();if(!address||typeof address==='string')throw Error('fixture server unavailable');
const base='http://127.0.0.1:'+address.port,cjk=/[぀-ヿ㐀-鿿＀-￯]/;
const browser=await chromium.launch({headless:true,...(process.env.HOST_MONITOR_CHROMIUM?{executablePath:process.env.HOST_MONITOR_CHROMIUM}:{channel:'chrome'}),chromiumSandbox:true});
// Visible text plus the attributes screen readers and tooltips use.
const pageText=(page:{evaluate:Function})=>page.evaluate(()=>[document.title,document.body.innerText,...[...document.querySelectorAll('[aria-label],[placeholder],[title]')].flatMap(node=>[node.getAttribute('aria-label'),node.getAttribute('placeholder'),node.getAttribute('title')])].filter(Boolean).join('\n')) as Promise<string>;
const errors:string[]=[];let tabs=0;
try{
 for(const [language,locale] of [['en','en-US'],['zh','zh-TW']] as const)for(const [label,width,height] of [['desktop',1440,1000],['phone',390,844]] as const){
  const context=await browser.newContext({locale,viewport:{width,height}}),page=await context.newPage(),seen:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.goto(base);await page.locator('#hosts .host').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),language==='zh'?'zh-Hant':'en','the browser language picks the language');
  for(const name of fleet.defaultOrder as string[]){
   await page.locator('#hosts .host').filter({has:page.locator('.host-name',{hasText:new RegExp('^'+name+'$')})}).click();
   for(const tab of await page.locator('#host-tabs [role=tab]').all()){
    await tab.click();tabs++;const text=await pageText(page);seen.push(text);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${language} ${label} ${name}: no horizontal overflow`);
    if(out)await page.screenshot({path:path.join(out,`${language}-${label}-${name}-${await tab.getAttribute('data-tab')}.png`),fullPage:true});
   }
  }
  const all=seen.join('\n'),data=JSON.stringify([fleet,events]);// text that comes from the synthetic data is not translated
  // The switch names the other language in that language, so its own label is the one expected Chinese text.
  const leftovers=all.split('\n').filter(line=>cjk.test(line)&&line!==dictionaries.en['lang.other']);
  if(language==='en')assert.deepEqual(leftovers.slice(0,5),[],`English ${label} UI has Chinese leftovers`);
  else for(const [key,value] of Object.entries(dictionaries.en)){
   // Placeholder-free English text that differs from its Chinese counterpart must never show in the Chinese UI (unless it is data).
   const chinese=(dictionaries.zh as Record<string,string>)[key];
   if(!value.includes('{')&&value.length>=5&&!chinese.includes(value)&&!value.includes(chinese)&&!data.includes(value)&&all.includes(value))assert.fail(`Chinese ${label} UI shows English text of ${key}: ${value}`);
  }
  await context.close();
 }
 // The header switch overrides the browser language and survives a reload.
 for(const [locale,from,to] of [['en-US','en','zh'],['zh-TW','zh','en']] as const){
  const context=await browser.newContext({locale,viewport:{width:1440,height:1000}}),page=await context.newPage();await page.goto(base);await page.locator('#hosts .host').first().waitFor();
  const html=page.locator('html'),switcher=page.locator('#language');
  assert.equal(await html.getAttribute('lang'),from==='zh'?'zh-Hant':'en');assert.equal(await switcher.innerText(),dictionaries[from]['lang.other']);
  await switcher.click();assert.equal(await html.getAttribute('lang'),to==='zh'?'zh-Hant':'en');assert.equal(await page.title(),dictionaries[to].title);
  await page.reload();await page.locator('#hosts .host').first().waitFor();
  assert.equal(await html.getAttribute('lang'),to==='zh'?'zh-Hant':'en','the choice survives a reload');
  assert.equal(await page.locator('#refresh').innerText(),dictionaries[to].refresh);
  await switcher.click();assert.equal(await html.getAttribute('lang'),from==='zh'?'zh-Hant':'en');await page.reload();assert.equal(await html.getAttribute('lang'),from==='zh'?'zh-Hant':'en','switching back is remembered too');
  await context.close();
 }
 // Without usable storage the page still follows the browser language and the switch still works for the session.
 {const context=await browser.newContext({locale:'en-US'}),page=await context.newPage();
  await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked');}});});
  await page.goto(base);await page.locator('#hosts .host').first().waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await page.locator('#language').click();assert.equal(await page.locator('html').getAttribute('lang'),'zh-Hant');await context.close();}
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,languages:['en','zh'],widths:[1440,390],tabsChecked:tabs,pageErrors:errors}));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
