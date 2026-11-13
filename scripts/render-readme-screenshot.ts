// Renders docs/images/dashboard.png, the README screenshot, from the synthetic fleet in docs/images/dashboard-fixture.json.
// It serves the real dashboard from public/ plus that fixture on a loopback port and never contacts installed hosts.
// Usage (after `npm run build`): node scripts/render-readme-screenshot.ts [output.png]
// Playwright is an external test tool (see DEVELOPMENT.md); set HOST_MONITOR_PLAYWRIGHT_ROOT and optionally HOST_MONITOR_CHROMIUM.
import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(process.argv[2]??path.join(root,'docs/images/dashboard.png'));
const {fleet,events}=JSON.parse(await fs.readFile(path.join(root,'docs/images/dashboard-fixture.json'),'utf8'));
const require=createRequire(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT?path.join(path.resolve(process.env.HOST_MONITOR_PLAYWRIGHT_ROOT),'package.json'):import.meta.url);
const {chromium}=require('playwright');
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
const browser=await chromium.launch({headless:true,...(process.env.HOST_MONITOR_CHROMIUM?{executablePath:process.env.HOST_MONITOR_CHROMIUM}:{channel:'chrome'}),chromiumSandbox:true});
try{
 // English interface, UTC clock, and a fixed 1280 px width make the image reproducible from any machine.
 const context=await browser.newContext({locale:'en-US',timezoneId:'UTC',colorScheme:'dark',reducedMotion:'reduce',viewport:{width:1280,height:900}}),page=await context.newPage();
 await page.addInitScript(()=>{localStorage.setItem('host-monitor.hostTabs.v1',JSON.stringify({order:['agents','disks','checks','events','services'],selected:'services'}));});
 await page.goto('http://127.0.0.1:'+address.port);await page.locator('#hosts .host').first().waitFor();await page.locator('#services tr').first().waitFor();
 await fs.mkdir(path.dirname(output),{recursive:true});await page.screenshot({path:output,fullPage:true});
 await context.close();
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
// Shrink the PNG when pngquant is installed; the screenshot is valid without it.
const quant=spawnSync('pngquant',['--force','--quality=70-95','--output',output,output],{stdio:'ignore'});
console.log(JSON.stringify({output:path.relative(root,output),bytes:(await fs.stat(output)).size,optimized:quant.status===0}));
