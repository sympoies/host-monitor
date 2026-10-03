import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const fixture=JSON.parse(await fs.readFile(path.join(root,'test/fixtures/host-detail-tabs.json'),'utf8'));
const playwrightRoot=process.env.HOST_MONITOR_PLAYWRIGHT_ROOT;
const require=createRequire(playwrightRoot?path.join(path.resolve(playwrightRoot),'package.json'):import.meta.url);
const {chromium}=require('playwright');
const screenshotDir=process.env.HOST_MONITOR_SCREENSHOT_DIR;
if(screenshotDir)await fs.mkdir(screenshotDir,{recursive:true});
const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url??'/',`http://${req.headers.host}`).pathname;
  if(pathname==='/api/fleet'){res.setHeader('content-type','application/json');res.end(JSON.stringify(fixture));return;}
  if(pathname==='/api/events'){res.setHeader('content-type','application/json');res.end(JSON.stringify({events:[
   {host:'linux-a',at:'2026-10-03T09:59:00.000Z',type:'attention',kind:'service',title:'Worker failed',severity:'error'},
   {host:'linux-a',at:'2026-10-03T09:58:00.000Z',type:'recovered',kind:'probe',title:'Probe recovered',severity:'warning'}
  ]}));return;}
  const file=path.join(root,'public',pathname==='/'?'index.html':pathname.slice(1));
  const bytes=await fs.readFile(file);res.setHeader('content-type',mime[path.extname(file)]??'application/octet-stream');res.end(bytes);
 }catch{res.statusCode=404;res.end();}
});
server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address();if(!address||typeof address==='string')throw Error('test server did not bind');
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${address.port}`);await page.locator('#hosts .host').first().waitFor();
 if(screenshotDir){await page.screenshot({path:path.join(screenshotDir,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(screenshotDir,'mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});}
 await page.getByRole('tablist',{name:'主機詳情區段'}).waitFor();
 const tabs=page.locator('#host-tabs [role=tab]');
 assert.deepEqual(await tabs.allTextContents(),['資源指標','磁碟容量','功能檢查與最近錯誤','最近事件','Agent sessions','服務']);
 assert.equal(await page.locator('#attention').isVisible(),true);
 await page.locator('#host-filters').getByRole('tab',{name:/需要關注/}).click();assert.equal(await page.locator('#hosts .host').count(),1);
 await page.locator('#host-filters').getByRole('tab',{name:/All/}).click();assert.equal(await page.locator('#hosts .host').count(),3);
 for(const tab of await tabs.all()){
  await tab.click();assert.equal(await tab.getAttribute('aria-selected'),'true');
  const panel=page.locator(`#${await tab.getAttribute('aria-controls')}`);assert.equal(await panel.isVisible(),true);
 }
 await page.getByRole('tab',{name:'Agent sessions'}).click();
 await page.locator('#agent-session-filters').getByRole('tab',{name:/Working/}).click();assert.equal(await page.locator('#agent-sessions .agent-session:visible').count(),2);
 await page.locator('#agent-session-filters').getByRole('tab',{name:/Waiting \/ idle/}).click();assert.equal(await page.locator('#agent-sessions .agent-session:visible').count(),3);
 await page.locator('#agent-session-filters').getByRole('tab',{name:/All/}).click();assert.equal(await page.locator('#agent-sessions .agent-session:visible').count(),6);
 await page.getByRole('tab',{name:'服務'}).click();
 await page.getByRole('tab',{name:/Needs attention/}).click();assert.equal(await page.locator('#services tr').count(),1);
 await page.locator('#service-filters').getByRole('tab',{name:/All/}).click();assert.equal(await page.locator('#services tr').count(),3);
 await page.getByRole('tab',{name:'功能檢查與最近錯誤'}).click();
 await page.locator('#checks-filters').getByRole('tab',{name:/Needs attention/}).click();assert.equal(await page.locator('#checks .check').count(),2);
 await page.locator('#checks-filters').getByRole('tab',{name:/All/}).click();assert.equal(await page.locator('#checks .check').count(),3);
 await page.getByRole('tab',{name:'磁碟容量'}).click();
 await page.locator('#disk-filters').getByRole('tab',{name:/Warning/}).click();assert.equal(await page.locator('#disks .disk').count(),1);
 await page.locator('#disk-filters').getByRole('tab',{name:/All/}).click();assert.equal(await page.locator('#disks .disk').count(),2);
 await page.getByRole('tab',{name:'最近事件'}).click();
 await page.locator('#events-filters').getByRole('tab',{name:/需要關注/}).click();assert.equal(await page.locator('#events .event').count(),1);
 await page.locator('#events-filters').getByRole('tab',{name:/All/}).click();assert.equal(await page.locator('#events .event').count(),2);
 await page.keyboard.press('ArrowRight');
 assert.deepEqual(await page.locator('#host-tabs [role=tab][aria-selected=true]').count(),1);
 await page.locator('.tab-order-menu summary').click();await page.getByRole('button',{name:'Move selected tab left'}).click();
 const beforeDrag=await tabs.allTextContents();await page.getByRole('tab',{name:'資源指標'}).dragTo(page.getByRole('tab',{name:'服務'}));
 const draggedOrder=await tabs.allTextContents();assert.notDeepEqual(draggedOrder,beforeDrag,'desktop drag should reorder tabs');
 await page.reload();await page.getByRole('tablist',{name:'主機詳情區段'}).waitFor();assert.deepEqual(await tabs.allTextContents(),draggedOrder,'tab order should persist');
 await page.locator('.tab-order-menu summary').click();
 await page.getByRole('button',{name:'Reset tab order'}).click();
 await page.getByRole('tab',{name:'Agent sessions'}).click();await page.reload();await page.getByRole('tablist',{name:'主機詳情區段'}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'Agent sessions'}).getAttribute('aria-selected'),'true','last selected tab should persist');
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>(globalThis as any).document.documentElement.scrollWidth<=(globalThis as any).innerWidth),'390px viewport has horizontal page overflow');
 assert.ok(await page.locator('#agent-sessions .session-title').evaluateAll((nodes:Array<{scrollWidth:number;clientWidth:number}>)=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),'session titles should wrap instead of clipping');
 await page.locator('.tab-order-menu summary').click();
 await page.getByRole('button',{name:'Move selected tab right'}).waitFor();
 await page.getByRole('tab',{name:'Agent sessions'}).waitFor();
 if(screenshotDir){await page.locator('.tab-order-menu summary').click();await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(screenshotDir,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(screenshotDir,'mobile.png'),fullPage:true});}
 await page.locator('#hosts .host').filter({hasText:'agentless-a'}).click();
 assert.equal(await page.evaluate(()=>(globalThis as any).location.hash),'#agentless-a','host hash should remain the deep link');
 assert.equal(await page.getByRole('tab',{name:/Agent sessions/}).count(),0,'agentless host should hide sessions tab');
 assert.equal(await page.getByRole('tab',{name:/Services/}).count(),0,'agentless host should hide empty services tab');
 assert.deepEqual(errors,[]);
 console.log('Fixture-backed host tabs browser check passed at 1440px and 390px');
}finally{await browser.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
