// Isolated, fixture-backed headless acceptance. Never attaches to a shared browser or device.
import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {once} from 'node:events';import assert from 'node:assert/strict';
import {createMonitor} from '../src/server.ts';import {parseSessionList,labelRules} from '../src/sessions.ts';
const fixture=await fs.readFile(new URL('../test/fixtures/sessions/list.json',import.meta.url),'utf8');
const active=parseSessionList(fixture,labelRules([{label:'Coordinator',match:{role:'coordinator'}}]));
let clock=Date.parse('2026-10-03T10:00:00Z'),fail=false;
const names=['active','empty','unknown','legacy','uncollected','disabled'];
const monitor=createMonitor({hosts:names.map(name=>({name,node:'/usr/bin/node',collector:'/app/collector.ts',config:name}))},{now:()=>clock,run:async(_bin,args)=>{
 const name=args.at(-1)!;if(fail||name==='uncollected')throw Error('offline');
 return {stdout:JSON.stringify({schemaVersion:1,host:name,collectedAt:'2026-10-03T10:00:00Z',hardware:{cpuCount:4,load:[],uptime:600,kernel:'Example'},services:[],attention:[],
  ...(name==='legacy'?{}:{agentSessions:name==='active'?active:name==='empty'?{status:'ok',sessions:[]}:name==='disabled'?{status:'disabled',sessions:[]}:{status:'unknown',sessions:[]}})})};
}});
const require=createRequire(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT?path.join(path.resolve(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT),'package.json'):import.meta.url);
const {chromium}=require('playwright');const browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.HOST_MONITOR_CHROMIUM?{executablePath:process.env.HOST_MONITOR_CHROMIUM}:{})});
monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');
const base='http://127.0.0.1:'+(monitor.server.address() as net.AddressInfo).port;
const out=process.argv[2];if(out)await fs.mkdir(out,{recursive:true});
try{
 await monitor.refresh();
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.goto(base);
 await page.locator('#hosts .host').first().waitFor();
 assert.equal(await page.locator('#agent-sessions').count(),1,'host detail owns an Agent sessions section');
 const card=(name:string)=>page.locator('#hosts .host').filter({has:page.locator('.host-name',{hasText:new RegExp('^'+name+'$')})});
 await card('active').click();
 assert.match(await card('active').innerText(),/Agents 4.*工作 1.*等待 \/ 待命 2.*未知 1/);
 assert.equal(await page.locator('.agent-session').count(),4);
 assert.match(await page.locator('.agent-session').first().innerText(),/Coordinator/);
 assert.equal(await page.locator('.agent-session').first().getByRole('img',{name:'Codex',exact:true}).count(),1);
 assert.equal(await page.locator('#agent-sessions img').count(),0,'titles render as text');
 const text=await page.locator('#agent-sessions').innerText();
 for(const value of ['example-project','account-a','未讀 2','活動 30 秒前','建立 1 小時前','working','waiting'])assert.ok(text.includes(value),value);
 for(const name of ['unknown','legacy','uncollected']){await card(name).click();assert.match(await page.locator('#agent-sessions').innerText(),/無法確認/);assert.doesNotMatch(await page.locator('#agent-sessions').innerText(),/目前沒有/);}
 await card('empty').click();assert.match(await page.locator('#agent-sessions').innerText(),/目前沒有執行中的 agent/);
 await card('disabled').click();assert.match(await page.locator('#agent-sessions').innerText(),/未啟用/);
 await card('active').click();if(out)await page.screenshot({path:path.join(out,'sessions-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.locator('.agent-session').first().isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px page has no horizontal overflow');
 for(const box of await page.locator('.agent-session').all()){const rect=await box.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=390);}
 if(out)await page.screenshot({path:path.join(out,'sessions-mobile.png'),fullPage:true});
 clock+=61000;await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#agent-sessions')?.textContent?.includes('最後已知'));
 assert.match(await card('active').innerText(),/最後已知 Agents/);
 fail=true;await monitor.refresh();await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#agent-sessions')?.textContent?.includes('連線或資料已過期'));
 assert.equal(await page.locator('.agent-session').count(),4);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,widths:[1440,390],states:['active','empty','unknown','legacy','uncollected','disabled','stale','offline'],pageErrors:errors}));
}finally{monitor.stop();await browser.close();await new Promise<void>(resolve=>monitor.server.close(()=>resolve()));}
