import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {resourceExpectation} from './accept-expectations.ts';
// Browser callbacks passed to Playwright run in the page, so tsconfig.accept.json checks this file with the DOM library.
// Usage: node scripts/accept-browser.ts --config <server-config.json> <url> <private-evidence-dir>
// The expected hosts are the server configuration's hosts. Playwright resolves from this checkout unless
// HOST_MONITOR_PLAYWRIGHT_ROOT names another directory whose node_modules contains it.
const args=process.argv.slice(2),at=args.indexOf('--config');if(at<0||!args[at+1])throw Error('server config required: --config <server-config.json>');
const configPath=args[at+1];args.splice(at,2);const [url,out]=args;if(!url||!out)throw Error('URL and private evidence directory required');
const hosts=JSON.parse(await fs.readFile(configPath,'utf8')).hosts?.map((h:{name:unknown})=>h.name);if(!Array.isArray(hosts)||!hosts.length||hosts.some((h:unknown)=>typeof h!=='string'||!/^[-a-zA-Z0-9]+$/.test(h)))throw Error('server config has no valid hosts');
const playwrightRoot=process.env.HOST_MONITOR_PLAYWRIGHT_ROOT;
const require=createRequire(playwrightRoot?path.join(path.resolve(playwrightRoot),'package.json'):import.meta.url);const {chromium}=require('playwright');
const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];let checkedLogs=0;
 page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.goto(url);await page.locator('#hosts .host').first().waitFor();
 assert.equal(await page.locator('#hosts .host').count(),hosts.length);
 for(const host of hosts){
  await page.locator('#hosts .host').filter({has:page.locator('.host-name',{hasText:new RegExp('^'+host+'$')})}).click();
  await page.waitForFunction((host:string)=>document.querySelector('#host-title')?.textContent===host&&document.querySelector('#resources .metric'),host);
  // Hosts whose resources are external (macOS, Beszel) show a pointer instead of metrics and disk rows.
  const expected=resourceExpectation(await page.evaluate(async(host:string)=>(await (await fetch('/api/fleet',{cache:'no-store'})).json()).hosts.find((h:{name:string})=>h.name===host)?.snapshot,host));
  assert.equal(await page.locator('#resources .metric').count(),expected.metrics);
  if(expected.diskRows)assert.ok(await page.locator('#disks .disk').count()>0);
  else{assert.ok((await page.locator('#resources').innerText()).includes(expected.text));assert.ok((await page.locator('#disks').innerText()).includes(expected.text));}
  const inventory=await page.evaluate(async(host:string)=>{const s=(await (await fetch('/api/fleet',{cache:'no-store'})).json()).hosts.find((h:{name:string})=>h.name===host)?.snapshot;return s?s.services.length+(s.containers?.length??0):0;},host);
  await page.locator('#filter').selectOption('all');assert.ok(inventory>0);assert.equal(await page.locator('#services tr').count(),inventory);
  const sample=(await page.locator('#services tr td:first-child').first().evaluate((td:Element)=>td.firstChild?.textContent??'')).trim();
  await page.locator('#search').fill(sample);assert.ok(await page.locator('#services tr').count()>0);assert.ok((await page.locator('#services').innerText()).includes(sample));
  await page.locator('#search').fill('no-such-service-acceptance');assert.equal(await page.locator('#services tr').count(),0);assert.ok(await page.locator('#empty').isVisible());
  await page.locator('#search').fill('');await page.locator('#filter').selectOption('important');
  const logUnit=await page.evaluate(async(host:string)=>{const h=(await (await fetch('/api/fleet',{cache:'no-store'})).json()).hosts.find((x:{name:string})=>x.name===host);return h?.logUnits?.[0]?.name as string|undefined;},host);
  if(logUnit){
   checkedLogs++;
   await page.locator('#filter').selectOption('all');await page.locator('#search').fill(logUnit);
   const response=page.waitForResponse((r:{url():string})=>r.url().includes('/api/logs?'));
   await page.getByRole('button',{name:`查看 ${logUnit} 日誌`}).click();
   assert.equal((await response).status(),200);assert.ok(await page.locator('#log-panel').isVisible());
   await page.waitForFunction(()=>!document.querySelector('#log-body')?.textContent?.includes('讀取最近'));
   assert.ok(!(await page.locator('#log-body').innerText()).includes('無法讀取'));
   await page.locator('#log-close').click();assert.equal(await page.locator('#log-panel').isVisible(),false);
   await page.locator('#search').fill('');await page.locator('#filter').selectOption('important');
  }
  assert.equal(await page.locator('#connection').innerText(),'');
  await page.screenshot({path:out+'/'+host+'-desktop.png',fullPage:true});
 }
 assert.ok(checkedLogs>0,'no configured service log unit was exercised');
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.screenshot({path:out+'/'+hosts.at(-1)+'-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser-receipt.json',JSON.stringify({passed:true,hosts,checks:['real-installed-chrome','headed-X11','host-selection','live-resources','installed-inventory','search','empty-state','allowlisted-log-view','mobile-no-page-overflow','no-JS-errors']},null,2)+'\n');
 console.log('Host Monitor browser acceptance passed');
}finally{await browser.close();}
