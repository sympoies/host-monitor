import {test} from 'node:test';import net from 'node:net';import assert from 'node:assert/strict';import {once} from 'node:events';import {createMonitor} from '../src/server.ts';import type {Runner} from '../src/server.ts';
type Monitor=ReturnType<typeof createMonitor>;const port=(s:net.Server)=>(s.address() as net.AddressInfo).port;
const host={name:'collector-a',ssh:'collector-a',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'};
const snapshot={schemaVersion:1,host:'collector-a',collectedAt:'2026-09-27T00:00:00Z',services:[],attention:[],hardware:{cpuCount:8,load:[0,0,0],uptime:10,kernel:'Linux'}};
async function running(run:Runner,fn:(m:Monitor,base:string)=>Promise<void>){const monitor=createMonitor({hosts:[host]},{run});monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await fn(monitor,'http://127.0.0.1:'+port(monitor.server));}finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}}
const adbOutput=(await import('node:fs')).readFileSync(new URL('./fixtures/android/adb-shell.txt',import.meta.url),'utf8');const {ADB_SCRIPT}=await import('../src/android.ts');
test('offline collectors retain the old snapshot without claiming fresh or healthy data',async()=>{let fail=false;await running(async()=>{if(fail)throw Error('private diagnostic');return {stdout:JSON.stringify(snapshot)};},async(m,base)=>{
 await m.refresh();let j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[0].status,'online');fail=true;await m.refresh();j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[0].status,'offline');assert.equal(j.hosts[0].snapshot.host,snapshot.host);assert.equal(JSON.stringify(j).includes('private diagnostic'),false);
 });});
test('identity mismatch never becomes a valid host snapshot',async()=>{await running(async()=>({stdout:JSON.stringify({...snapshot,host:'other'})}),async(m,base)=>{await m.refresh();const j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[0].status,'offline');assert.equal(j.hosts[0].snapshot,null);});});
test('web server serves the closed browser asset inventory and rejects state changes',async()=>{await running(async()=>({stdout:JSON.stringify(snapshot)}),async(m,base)=>{assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/api/fleet',{method:'POST'})).status,405);assert.equal((await fetch(base+'/%2e%2e/package.json')).status,404);const r=await fetch(base+'/app.js');assert.equal(r.status,200);assert.ok(r.headers.get('content-security-policy')!.includes("default-src 'self'"));assert.equal((await fetch(base+'/tabs.js')).status,200);});});
test('service logs are fetched only for an online local host and an exact configured unit',async()=>{
 const at=Date.parse(snapshot.collectedAt),calls:Array<[string,string[]]>=[];
 const monitor=createMonitor({hosts:[{name:'collector-a',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json',logUnits:[{scope:'user',name:'web.service'}]}]},
  {now:()=>at,run:async(file,args)=>{calls.push([file,args]);return {stdout:file==='journalctl'?'private journal line':JSON.stringify({...snapshot,platform:'linux',services:[{name:'web.service',scope:'user',health:'ok',active:'active'}]})};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');
 try{await monitor.refresh();const base='http://127.0.0.1:'+port(monitor.server);
  for(const query of ['host=missing&unit=web.service','host=collector-a&unit=other.service','host=collector-a&unit=web.service%3Bwhoami'])assert.equal((await fetch(base+'/api/logs?'+query)).status,404);
  assert.equal(calls.length,1);
  const response=await fetch(base+'/api/logs?host=collector-a&unit=web.service');assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json() as any).text,'private journal line');
  assert.equal(calls.length,2);assert.equal(calls[1][0],'journalctl');assert.ok(calls[1][1].includes('web.service'));
  assert.equal(JSON.stringify(await (await fetch(base+'/api/fleet')).json()).includes('private journal line'),false);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('log access fails closed on offline hosts, invalid configurations, and reader failure',async()=>{
 const local={name:'collector-a',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'};
 for(const logUnits of [[{scope:'user',name:'bad;unit.service'}],[{scope:'user',name:'web.service'},{scope:'user',name:'web.service'}],[{scope:'user',name:'web.service'},{scope:'system',name:'web.service'}],[{scope:'root',name:'web.service'}]])
  assert.throws(()=>createMonitor({hosts:[{...local,logUnits}]}),/invalid-log-units/);
 assert.throws(()=>createMonitor({hosts:[{...host,logUnits:[{scope:'user',name:'web.service'}]}]}),/invalid-log-units/);
 let fail=false,read=false;
 const monitor=createMonitor({hosts:[{...local,logUnits:[{scope:'user',name:'web.service'}]}]},
  {now:()=>Date.parse(snapshot.collectedAt),run:async(file)=>{if(file==='journalctl'){read=true;throw Error('private diagnostic');}if(fail)throw Error('offline');return {stdout:JSON.stringify({...snapshot,platform:'linux',services:[{name:'web.service',scope:'user',health:'ok',active:'active'}]})};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');
 try{const url='http://127.0.0.1:'+port(monitor.server)+'/api/logs?host=collector-a&unit=web.service';
  assert.equal((await fetch(url)).status,503);assert.equal(read,false);
  await monitor.refresh();const failed=await fetch(url);assert.equal(failed.status,502);assert.equal((await failed.text()).includes('private diagnostic'),false);
  fail=true;await monitor.refresh();assert.equal((await fetch(url)).status,503);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('system journal scope uses fixed arguments and concurrent tails are capped',async()=>{
 const local={name:'collector-a',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'};
 let active=0,maxActive=0;const pending:(()=>void)[]=[];const argsSeen:string[][]=[];
 const monitor=createMonitor({hosts:[{...local,logUnits:[{scope:'system',name:'web.service'}]}]},
  {now:()=>Date.parse(snapshot.collectedAt),run:async(file,args)=>{
   if(file!=='journalctl')return {stdout:JSON.stringify({...snapshot,platform:'linux',services:[{name:'web.service',scope:'system',health:'ok',active:'active'}]})};
   argsSeen.push(args);active++;maxActive=Math.max(active,maxActive);
   await new Promise<void>(resolve=>pending.push(resolve));active--;return {stdout:'bounded log'};
  }});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');
 try{await monitor.refresh();const url='http://127.0.0.1:'+port(monitor.server)+'/api/logs?host=collector-a&unit=web.service';
  const first=fetch(url),second=fetch(url);
  while(pending.length<2)await new Promise(r=>setTimeout(r,1));
  assert.equal((await fetch(url)).status,429);assert.equal(maxActive,2);
  assert.deepEqual(argsSeen[0],['--system','--unit','web.service','--lines','120','--no-pager','--output=short-iso','--quiet']);
  pending.splice(0).forEach(resolve=>resolve());assert.equal((await first).status,200);assert.equal((await second).status,200);
 }finally{pending.splice(0).forEach(resolve=>resolve());monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
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
  const calls:unknown[][]=[];const monitor=createMonitor({hosts:[{name:'phone-a',adb:{serial:'EXAMPLE123'}},{name:'phone',adb:{serial:'EXAMPLE456',bin:'/usr/bin/adb'}}]},{run:async(file,args,options)=>{calls.push([file,args,options.timeout]);return {stdout:adbOutput};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.deepEqual(calls,[['adb',['-s','EXAMPLE123','shell',ADB_SCRIPT],30000],['/usr/bin/adb',['-s','EXAMPLE456','shell',ADB_SCRIPT],30000]]);
  assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.status,h.snapshot.host,h.snapshot.android.battery.level]),[['phone-a','online','phone-a',84],['phone','online','phone',84]]);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('a detached adb device shows offline and never raises an offline alert',async()=>{
 let clock=Date.parse('2026-09-29T12:00:00Z');const posts:unknown[]=[];
 const monitor=createMonitor({hosts:[{name:'phone-a',adb:{serial:'MISSING000'}}],alerts:{webhookUrl:'http://127.0.0.1:8000/notify',offlineAfterSeconds:1}},{now:()=>clock,run:async()=>{throw Object.assign(Error("adb: device 'MISSING000' not found"),{code:1});},fetch:async(url,init)=>{posts.push([url,init]);return {ok:true,status:200};},sleep:async()=>{}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{
  for(let i=0;i<3;i++){await monitor.refresh();clock+=600000;}await monitor.idle();
  const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.equal(j.hosts[0].status,'offline');assert.equal(j.hosts[0].snapshot,null);assert.equal(JSON.stringify(j).includes('MISSING000'),false);
  assert.deepEqual(posts,[]);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('an adb device on another host is read through one quoted ssh command',async()=>{
 const calls:unknown[][]=[];const monitor=createMonitor({hosts:[{name:'phone-a',ssh:'collector-a',adb:{serial:'EXAMPLE123',bin:'/opt/homebrew/bin/adb'}}]},{run:async(file,args,options)=>{calls.push([file,args,options.timeout]);return {stdout:adbOutput};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  const quoted="'"+ADB_SCRIPT.replaceAll("'","'\\''")+"'";
  assert.deepEqual(calls,[['ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','collector-a','/opt/homebrew/bin/adb','-s','EXAMPLE123','shell',quoted],30000]]);
  assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.status,h.snapshot.host,h.snapshot.android.battery.level]),[['phone-a','online','phone-a',84]]);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('a remote adb entry needs an absolute adb path and a plain ssh alias',async()=>{
 const bad=[{ssh:'collector-a',adb:{serial:'X'}},{ssh:'collector-a',adb:{serial:'X',bin:'adb'}},{ssh:'-oProxyCommand=x',adb:{serial:'X',bin:'/a/adb'}},{ssh:'collector-a x',adb:{serial:'X',bin:'/a/adb'}}];
 const calls:unknown[]=[];const monitor=createMonitor({hosts:bad.map((h,i)=>({name:'bad'+i,...h}))},{run:async(...args)=>{calls.push(args);return {stdout:''};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.ok(j.hosts.every((h:any)=>h.status==='offline'&&h.snapshot===null));assert.equal(calls.length,0);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('an adb device with its own offlineAfterSeconds alerts once when it stays unreachable, and again when it returns',async()=>{
 let clock=Date.parse('2026-09-29T12:00:00Z'),fail=true;const posts:any[]=[];
 const monitor=createMonitor({hosts:[{name:'phone-a',adb:{serial:'X'},offlineAfterSeconds:3600},{name:'quiet',adb:{serial:'Y'}}],alerts:{webhookUrl:'http://127.0.0.1:8000/notify',offlineAfterSeconds:0}},{now:()=>clock,run:async(_f,args)=>{if(fail||args[1]==='Y')throw Error('private diagnostic');return {stdout:adbOutput};},fetch:async(url,init)=>{posts.push(JSON.parse(String(init.body)));return {ok:true,status:200};},sleep:async()=>{}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{
  for(let i=0;i<4;i++){await monitor.refresh();clock+=1200000;}await monitor.idle();
  assert.deepEqual(posts.map(p=>p.title),['[host-monitor] phone-a: collector unreachable']);
  assert.match(posts[0].body,/^no successful collection for \d+ min$/);assert.equal(JSON.stringify(posts).includes('private diagnostic'),false);
  fail=false;await monitor.refresh();await monitor.idle();
  assert.deepEqual(posts.map(p=>p.title),['[host-monitor] phone-a: collector unreachable','[host-monitor] phone-a: collector reachable again']);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('adb host entries outside the allowlist never reach the runner',async()=>{
 const bad=[{serial:'-e'},{serial:'X; reboot'},{serial:'X',bin:'adb -H evil'},{serial:'X',bin:'relative/adb'},{serial:''},'X'];
 const calls:unknown[]=[];const monitor=createMonitor({hosts:[...bad.map((adb,i)=>({name:'bad'+i,adb})),{name:'both',adb:{serial:'X'},ssh:'collector-a',node:'/n',collector:'/c',config:'/h'}]},{run:async(...args)=>{calls.push(args);return {stdout:''};}});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await monitor.refresh();const j=await (await fetch('http://127.0.0.1:'+port(monitor.server)+'/api/fleet')).json() as any;
  assert.ok(j.hosts.every((h:any)=>h.status==='offline'&&h.snapshot===null));assert.equal(calls.length,0);
 }finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});

test('session API independently removes command, cwd, prompt and account objects while retaining safe metadata',async()=>{
 const input={...snapshot,agentSessions:{status:'ok',sessions:[{agent:'codex',status:'running',phase:'working',title:'Example task',account:'account-a',cwd:'private-canary',attach_command:'private-canary',ssh_attach_command:'private-canary',prompt_file:'private-canary',log_file:'private-canary',tmux_session:'private-canary',last_prompt:{text:'private-canary'},codex_account:{credential:'private-canary'}}]}};
 await running(async()=>({stdout:JSON.stringify(input)}),async(m,base)=>{await m.refresh();const response=await (await fetch(base+'/api/fleet')).text();assert.equal(response.includes('private-canary'),false);assert.deepEqual(JSON.parse(response).hosts[0].snapshot.agentSessions,{status:'ok',sessions:[{agent:'codex',status:'running',phase:'working',title:'Example task',account:'account-a'}]});});
});
