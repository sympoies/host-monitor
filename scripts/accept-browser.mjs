import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
// Usage: node scripts/accept-browser.mjs --config <server-config.json> <url> <private-evidence-dir>
// The expected hosts are the server configuration's hosts. Playwright resolves from this checkout unless
// HOST_MONITOR_PLAYWRIGHT_ROOT names another directory whose node_modules contains it.
const args=process.argv.slice(2),at=args.indexOf('--config');if(at<0||!args[at+1])throw Error('server config required: --config <server-config.json>');
const configPath=args[at+1];args.splice(at,2);const [url,out]=args;if(!url||!out)throw Error('URL and private evidence directory required');
const hosts=JSON.parse(await fs.readFile(configPath,'utf8')).hosts?.map(h=>h.name);if(!Array.isArray(hosts)||!hosts.length||hosts.some(h=>typeof h!=='string'||!/^[-a-zA-Z0-9]+$/.test(h)))throw Error('server config has no valid hosts');
const playwrightRoot=process.env.HOST_MONITOR_PLAYWRIGHT_ROOT;
const require=createRequire(playwrightRoot?path.join(path.resolve(playwrightRoot),'package.json'):import.meta.url);const {chromium}=require('playwright');
const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.locator('#hosts .host').first().waitFor();
 assert.equal(await page.locator('#hosts .host').count(),hosts.length);
 for(const host of hosts){
  await page.locator('#hosts .host').filter({has:page.locator('.host-name',{hasText:new RegExp('^'+host+'$')})}).click();
  await page.waitForFunction(host=>document.querySelector('#host-title')?.textContent===host&&document.querySelector('#resources .metric'),host);
  assert.equal(await page.locator('#resources .metric').count(),4);
  assert.ok(await page.locator('#disks .disk').count()>0);
  const inventory=await page.evaluate(async host=>{const s=(await (await fetch('/api/fleet',{cache:'no-store'})).json()).hosts.find(h=>h.name===host)?.snapshot;return s?s.services.length+(s.containers?.length??0):0;},host);
  await page.locator('#filter').selectOption('all');assert.ok(inventory>0);assert.equal(await page.locator('#services tr').count(),inventory);
  const sample=(await page.locator('#services tr td:first-child').first().evaluate(td=>td.firstChild.textContent)).trim();
  await page.locator('#search').fill(sample);assert.ok(await page.locator('#services tr').count()>0);assert.ok((await page.locator('#services').innerText()).includes(sample));
  await page.locator('#search').fill('no-such-service-acceptance');assert.equal(await page.locator('#services tr').count(),0);assert.ok(await page.locator('#empty').isVisible());
  await page.locator('#search').fill('');await page.locator('#filter').selectOption('important');
  assert.equal(await page.locator('#connection').innerText(),'');
  await page.screenshot({path:out+'/'+host+'-desktop.png',fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.screenshot({path:out+'/'+hosts.at(-1)+'-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser-receipt.json',JSON.stringify({passed:true,hosts,checks:['real-installed-chrome','headed-X11','host-selection','live-resources','installed-inventory','search','empty-state','mobile-no-page-overflow','no-JS-errors']},null,2)+'\n');
 console.log('Host Monitor browser acceptance passed');
}finally{await browser.close();}
