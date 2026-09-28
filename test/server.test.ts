import {test} from 'node:test';import net from 'node:net';import assert from 'node:assert/strict';import {once} from 'node:events';import {createMonitor} from '../src/server.ts';import type {Runner} from '../src/server.ts';
type Monitor=ReturnType<typeof createMonitor>;const port=(s:net.Server)=>(s.address() as net.AddressInfo).port;
const host={name:'c8',ssh:'c8',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'};
const snapshot={schemaVersion:1,host:'c8',collectedAt:'2026-09-27T00:00:00Z',services:[],attention:[],hardware:{cpuCount:8,load:[0,0,0],uptime:10,kernel:'Linux'}};
async function running(run:Runner,fn:(m:Monitor,base:string)=>Promise<void>){const monitor=createMonitor({hosts:[host]},{run});monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await fn(monitor,'http://127.0.0.1:'+port(monitor.server));}finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}}
test('offline collectors retain the old snapshot without claiming fresh or healthy data',async()=>{let fail=false;await running(async()=>{if(fail)throw Error('private diagnostic');return {stdout:JSON.stringify(snapshot)};},async(m,base)=>{
 await m.refresh();let j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[0].status,'online');fail=true;await m.refresh();j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[0].status,'offline');assert.equal(j.hosts[0].snapshot.host,snapshot.host);assert.equal(JSON.stringify(j).includes('private diagnostic'),false);
 });});
test('identity mismatch never becomes a valid host snapshot',async()=>{await running(async()=>({stdout:JSON.stringify({...snapshot,host:'other'})}),async(m,base)=>{await m.refresh();const j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[0].status,'offline');assert.equal(j.hosts[0].snapshot,null);});});
test('web server serves a closed asset inventory and rejects state changes',async()=>{await running(async()=>({stdout:JSON.stringify(snapshot)}),async(m,base)=>{assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/api/fleet',{method:'POST'})).status,405);assert.equal((await fetch(base+'/%2e%2e/package.json')).status,404);const r=await fetch(base+'/app.js');assert.equal(r.status,200);assert.ok(r.headers.get('content-security-policy')!.includes("default-src 'self'"));});});
test('fresh receipt cannot make an old or future snapshot appear current',async()=>{let clock=Date.parse(snapshot.collectedAt);const monitor=createMonitor({hosts:[host]},{now:()=>clock,run:async()=>({stdout:JSON.stringify(snapshot)})});monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const base='http://127.0.0.1:'+port(monitor.server);assert.equal((await (await fetch(base+'/api/fleet')).json() as any).hosts[0].stale,false);clock+=61000;await monitor.refresh();assert.equal((await (await fetch(base+'/api/fleet')).json() as any).hosts[0].stale,true);}finally{await new Promise(r=>monitor.server.close(r));}});

test('unknown top-level and nested collector fields never reach the browser API',async()=>{const canary='private-canary-value';const input={...snapshot,rawJournal:canary,hardware:{...snapshot.hardware,environment:canary},services:[{name:'web.service',scope:'user',health:'ok',active:'active',auth:canary}],containers:[{name:'web',state:'running',environment:canary}]};await running(async()=>({stdout:JSON.stringify(input)}),async(m,base)=>{await m.refresh();const r=await fetch(base+'/api/fleet');const text=await r.text();assert.equal(text.includes(canary),false);assert.equal(JSON.parse(text).hosts[0].status,'online');});});
test('important service markers come from host configuration with a server-wide default',async()=>{const monitor=createMonitor({importantServices:['web'],hosts:[host,{...host,name:'other',importantServices:['db','dsh-']}]},{run:async()=>({stdout:JSON.stringify(snapshot)})});monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{const base='http://127.0.0.1:'+port(monitor.server);await monitor.refresh();const j=await (await fetch(base+'/api/fleet')).json() as any;assert.deepEqual(j.hosts.map((h:any)=>h.importantServices),[['web'],['db','dsh-']]);}finally{await new Promise(r=>monitor.server.close(r));}
 for(const importantServices of ['web',[1],['a b'],['x'.repeat(129)]])assert.throws(()=>createMonitor({hosts:[{...host,importantServices}]}),/invalid-important-services/);});
test('a request target that cannot be parsed is answered 400 without stopping the server',async()=>{await running(async()=>({stdout:JSON.stringify(snapshot)}),async(m,base)=>{
 const status=await new Promise<string>((resolve,reject)=>{const socket=net.connect(port(m.server),'127.0.0.1',()=>socket.end('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));let data='';socket.setEncoding('utf8');socket.on('data',d=>data+=d);socket.on('error',reject);socket.on('close',()=>resolve(data.split('\r\n')[0]));});
 assert.equal(status,'HTTP/1.1 400 Bad Request');assert.equal((await fetch(base+'/healthz')).status,200);
});});
test('remote collector commands outside the ssh allowlist never reach the runner',async()=>{
 const bad={config:'/app/h.json;id',collector:'$(id)',node:'/usr/bin/node x',ssh:'-oProxyCommand=id'};
 const calls:unknown[]=[];const monitor=createMonitor({hosts:Object.entries(bad).map(([field,value],i)=>({...host,name:'bad'+i,[field]:value}))},{run:async(...args)=>{calls.push(args);return {stdout:JSON.stringify(snapshot)};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
 assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.status,h.snapshot]),[['bad0','offline',null],['bad1','offline',null],['bad2','offline',null],['bad3','offline',null]]);assert.equal(calls.length,0);}finally{await new Promise(r=>monitor.server.close(r));}
});
test('an adb host is collected by the server with one adb shell call and parsed in-process',async()=>{
 const adbOutput=(await import('node:fs')).readFileSync(new URL('./fixtures/android/adb-shell.txt',import.meta.url),'utf8');const {ADB_SCRIPT}=await import('../src/android.ts');
 const calls:unknown[][]=[];const monitor=createMonitor({hosts:[{name:'s22',adb:{serial:'EXAMPLE123'}},{name:'phone',adb:{serial:'EXAMPLE456',bin:'/usr/bin/adb'}}]},{run:async(file,args,options)=>{calls.push([file,args,options.timeout]);return {stdout:adbOutput};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.deepEqual(calls,[['adb',['-s','EXAMPLE123','shell',ADB_SCRIPT],30000],['/usr/bin/adb',['-s','EXAMPLE456','shell',ADB_SCRIPT],30000]]);
  assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.status,h.snapshot.host,h.snapshot.android.battery.level]),[['s22','online','s22',84],['phone','online','phone',84]]);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('a detached adb device shows offline and never raises an offline alert',async()=>{
 let clock=Date.parse('2026-09-29T12:00:00Z');const posts:unknown[]=[];
 const monitor=createMonitor({hosts:[{name:'s22',adb:{serial:'MISSING000'}}],alerts:{webhookUrl:'http://127.0.0.1:8000/notify',offlineAfterSeconds:1}},{now:()=>clock,run:async()=>{throw Object.assign(Error("adb: device 'MISSING000' not found"),{code:1});},fetch:async(url,init)=>{posts.push([url,init]);return {ok:true,status:200};},sleep:async()=>{}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{
  for(let i=0;i<3;i++){await monitor.refresh();clock+=600000;}await monitor.idle();
  const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.equal(j.hosts[0].status,'offline');assert.equal(j.hosts[0].snapshot,null);assert.equal(JSON.stringify(j).includes('MISSING000'),false);
  assert.deepEqual(posts,[]);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('adb host entries outside the allowlist never reach the runner',async()=>{
 const bad=[{serial:'-e'},{serial:'X; reboot'},{serial:'X',bin:'adb -H evil'},{serial:'X',bin:'relative/adb'},{serial:''},'X'];
 const calls:unknown[]=[];const monitor=createMonitor({hosts:[...bad.map((adb,i)=>({name:'bad'+i,adb})),{name:'both',adb:{serial:'X'},ssh:'c8',node:'/n',collector:'/c',config:'/h'}]},{run:async(...args)=>{calls.push(args);return {stdout:''};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.ok(j.hosts.every((h:any)=>h.status==='offline'&&h.snapshot===null));assert.equal(calls.length,0);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
