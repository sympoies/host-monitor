import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {once} from 'node:events';
import {createTracker,createNotifier,createHistory,webhookUrl,parseQuietHours,inQuietHours} from '../src/alerts.ts';
import {createMonitor} from '../src/server.ts';import type {Attention} from '../src/model.ts';import type net from 'node:net';
const port=(s:net.Server)=>(s.address() as net.AddressInfo).port;
const T0=Date.parse('2026-09-28T04:00:00Z');
const stopped={severity:'error',kind:'service',title:'web.service',detail:'user · inactive · success'};
const tmp=()=>fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-alerts-'));
function recorder({fail=0}={}){const calls:{url:string;init:RequestInit&{headers:Record<string,string>};body:any}[]=[];let failures=fail;const fetchImpl=async(url:URL,init:RequestInit)=>{calls.push({url:String(url),init:init as RequestInit&{headers:Record<string,string>},body:JSON.parse(init.body as string)});if(failures-->0)throw Error('relay down');return new Response('ok');};return {calls,fetchImpl};}

test('transitions are emitted once per new attention item, recovery and offline period',()=>{
 const t=createTracker({offlineAfterMs:300000});
 assert.deepEqual(t.online('c8',[],T0),[],'first observation is a silent baseline');
 const raised=t.online('c8',[stopped],T0+20000);assert.deepEqual(raised.map(e=>[e.type,e.kind,e.title,e.severity]),[['attention','service','web.service','error']]);assert.equal(raised[0].at,new Date(T0+20000).toISOString());
 assert.deepEqual(t.online('c8',[{...stopped,detail:'user · inactive · exit-code'}],T0+40000),[],'a changed detail is the same item');
 assert.deepEqual(t.online('c8',[],T0+60000).map(e=>[e.type,e.title]),[['recovered','web.service']]);
 assert.deepEqual(t.offline('c8',T0+80000),[]);assert.deepEqual(t.offline('c8',T0+379999),[]);
 assert.deepEqual(t.offline('c8',T0+380000).map(e=>[e.type,e.kind,e.title]),[['offline','host','c8']]);assert.deepEqual(t.offline('c8',T0+900000),[]);
 assert.deepEqual(t.online('c8',[],T0+920000).map(e=>e.type),['online']);
 assert.deepEqual(t.online('c8',[],T0+940000),[]);
});
test('webhook URLs must be loopback or tailnet without embedded credentials',()=>{
 for(const url of ['http://127.0.0.1:8000/notify','http://localhost:8000/notify','http://[::1]:8000/notify','https://sympoies.tail841b2e.ts.net:8001/notify','http://100.99.173.75:8000/notify'])assert.equal(webhookUrl(url).href,new URL(url).href);
 for(const url of ['http://example.com/notify','https://relay.ts.net.example.com/','http://user:secret@127.0.0.1:8000/notify','http://127.0.0.1:8000/notify?token=x','http://10.0.0.5:8000/','http://100.128.0.1/','file:///tmp/x','not a url'])assert.throws(()=>webhookUrl(url),/invalid-alerts-webhook/);
});
test('quiet hours wrap midnight in the configured time zone',()=>{
 const q=parseQuietHours({start:'23:00',end:'07:00',timeZone:'Asia/Taipei'});
 assert.equal(inQuietHours(q,Date.parse('2026-09-28T15:30:00Z')),true);assert.equal(inQuietHours(q,Date.parse('2026-09-28T22:59:00Z')),true);
 assert.equal(inQuietHours(q,Date.parse('2026-09-28T23:00:00Z')),false);assert.equal(inQuietHours(q,Date.parse('2026-09-28T14:59:00Z')),false);
 for(const bad of [{start:'25:00',end:'07:00'},{start:'23:00',end:'7'},{start:'23:00',end:'07:00',timeZone:'Mars/Base'}])assert.throws(()=>parseQuietHours(bad),/invalid-quiet-hours/);
});
test('notifications use the relay JSON shape, a fixed prefix and an auth header only from the named environment variable',async()=>{
 const {calls,fetchImpl}=recorder();const n=createNotifier({url:'http://127.0.0.1:8000/notify',authEnv:'RELAY_TOKEN',env:{RELAY_TOKEN:'env-secret'},fetchImpl,sleep:async()=>{}});
 const t=createTracker();t.online('c8',[],T0);n.submit(t.online('c8',[stopped],T0+1),T0+1);n.submit(t.online('c8',[{severity:'warning',kind:'journal',title:'noisy.service',detail:'3 errors in the last hour'}],T0+2),T0+2);await n.idle();
 assert.equal(calls.length,2,'recovery of the service is sent; journal kinds are history only by default');
 assert.deepEqual(calls[0].body,{title:'[host-monitor] c8: service needs attention',body:'web.service — user · inactive · success',type:'failure',format:'text'});
 assert.deepEqual(calls[1].body,{title:'[host-monitor] c8: service recovered',body:'web.service',type:'success',format:'text'});
 assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers['content-type'],'application/json');assert.equal(calls[0].init.headers.authorization,'Bearer env-secret');
 const plain=recorder();const m=createNotifier({url:'http://127.0.0.1:8000/notify',fetchImpl:plain.fetchImpl,sleep:async()=>{}});m.submit([{at:new Date(T0).toISOString(),host:'c8',type:'offline',kind:'host',title:'c8',severity:'error',detail:'no successful collection for 5 min'}],T0);await m.idle();
 assert.equal(plain.calls[0].init.headers.authorization,undefined);assert.equal(plain.calls[0].body.title,'[host-monitor] c8: collector unreachable');
});
test('delivery retries are bounded, queued and never awaited by the caller',async()=>{
 const flaky=recorder({fail:2});const sleeps:number[]=[];const n=createNotifier({url:'http://127.0.0.1:8000/notify',fetchImpl:flaky.fetchImpl,sleep:async (ms:number)=>{sleeps.push(ms);},retries:3});
 const event={at:new Date(T0).toISOString(),host:'c8',type:'attention' as const,kind:'service',title:'web.service',severity:'error'};
 assert.equal(n.submit([event],T0),undefined);await n.idle();assert.equal(flaky.calls.length,3);assert.equal(sleeps.length,2);assert.deepEqual(n.stats(),{sent:1,failed:0,dropped:0});
 const dead=recorder({fail:99});const d=createNotifier({url:'http://127.0.0.1:8000/notify',fetchImpl:dead.fetchImpl,sleep:async()=>{},retries:3,maxQueue:2});
 d.submit([event,{...event,title:'a'},{...event,title:'b'}],T0);await d.idle();assert.deepEqual(d.stats(),{sent:0,failed:2,dropped:1});assert.equal(dead.calls.length,6);
});
test('quiet hours defer alerts to one summary and drop items that recovered meanwhile',async()=>{
 const {calls,fetchImpl}=recorder();const quietHours={start:'23:00',end:'07:00',timeZone:'Asia/Taipei'};const n=createNotifier({url:'http://127.0.0.1:8000/notify',quietHours,fetchImpl,sleep:async()=>{}});
 const night=Date.parse('2026-09-28T16:00:00Z'),morning=Date.parse('2026-09-28T23:05:00Z');const t=createTracker();t.online('c8',[],night);
 n.submit(t.online('c8',[stopped,{severity:'error',kind:'probe',title:'web API',detail:'HTTP 500'}],night),night);n.submit(t.online('c8',[stopped],night+60000),night+60000);n.tick(night+120000);await n.idle();
 assert.equal(calls.length,0);n.tick(morning);await n.idle();assert.equal(calls.length,1);
 assert.equal(calls[0].body.title,'[host-monitor] quiet hours summary');assert.match(calls[0].body.body,/c8 service web\.service needs attention/);assert.doesNotMatch(calls[0].body.body,/web API/);
 n.tick(morning+60000);await n.idle();assert.equal(calls.length,1);
});
test('history is an append-only JSONL log capped by size and rotation that survives restart',async()=>{
 const dir=await tmp();try{
  const h=createHistory({dir,maxBytes:600,keep:50});await h.load();
  for(let i=0;i<20;i++)h.add({at:new Date(T0+i*1000).toISOString(),host:'c8',type:'attention',kind:'service',title:'unit-'+i,severity:'error'});await h.flush();
  const files=(await fs.readdir(dir)).sort();assert.deepEqual(files,['events.1.jsonl','events.jsonl']);
  for(const f of files)assert.ok((await fs.stat(path.join(dir,f))).size<=600);
  assert.deepEqual(h.recent({limit:3}).map(e=>e.title),['unit-19','unit-18','unit-17']);
  const again=createHistory({dir,maxBytes:600,keep:50});await again.load();const kept=again.recent({limit:50});assert.equal(kept[0].title,'unit-19');assert.ok(kept.length<20&&kept.length>=5);
  await fs.appendFile(path.join(dir,'events.jsonl'),'not json\n{"at":1}\n');const tolerant=createHistory({dir,maxBytes:600});await tolerant.load();assert.equal(tolerant.recent({limit:1})[0].title,'unit-19');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

const host={name:'c8',ssh:'c8',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'};
const snap=(at:number,attention:Attention[]=[])=>({schemaVersion:1,host:'c8',collectedAt:new Date(at).toISOString(),services:[],attention,hardware:{cpuCount:8,load:[0,0,0],uptime:10,kernel:'Linux'}});
async function serve(monitor:ReturnType<typeof createMonitor>,fn:(base:string)=>Promise<void>){monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');try{await fn('http://127.0.0.1:'+port(monitor.server));}finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}}
test('a stopped required service produces exactly one notification and one recovery, recorded in /api/events',async()=>{
 const dir=await tmp();try{
  let clock=T0,attention:Attention[]=[];const {calls,fetchImpl}=recorder();
  const config={hosts:[host],stateDir:dir,alerts:{webhookUrl:'http://127.0.0.1:8000/notify'}};
  const monitor=createMonitor(config,{now:()=>clock,fetch:fetchImpl,sleep:async()=>{},run:async()=>({stdout:JSON.stringify(snap(clock,attention))})});
  await serve(monitor,async base=>{
   await monitor.refresh();attention=[stopped];for(let i=0;i<3;i++){clock+=20000;await monitor.refresh();}attention=[];clock+=20000;await monitor.refresh();clock+=20000;await monitor.refresh();await monitor.idle();
   assert.deepEqual(calls.map(c=>c.body.title),['[host-monitor] c8: service needs attention','[host-monitor] c8: service recovered']);
   const events=(await (await fetch(base+'/api/events')).json() as any).events;assert.deepEqual(events.map((e:any)=>[e.type,e.host,e.title]),[['recovered','c8','web.service'],['attention','c8','web.service']]);
   assert.equal((await (await fetch(base+'/api/events?limit=1')).json() as any).events.length,1);
   for(const q of ['limit=0','limit=501','limit=x','host=other','host=c8;id'])assert.equal((await fetch(base+'/api/events?'+q)).status,400);
   assert.equal((await fetch(base+'/api/events',{method:'POST'})).status,405);
  });
  attention=[stopped];const restarted=createMonitor(config,{now:()=>clock,fetch:fetchImpl,sleep:async()=>{},run:async()=>({stdout:JSON.stringify(snap(clock,attention))})});
  await serve(restarted,async base=>{await restarted.refresh();await restarted.idle();assert.equal(calls.length,3,'persisted state still detects a new item after restart');
   const again=createMonitor(config,{now:()=>clock,fetch:fetchImpl,sleep:async()=>{},run:async()=>({stdout:JSON.stringify(snap(clock,attention))})});await again.refresh();await again.idle();again.stop();assert.equal(calls.length,3,'an item already notified is not repeated after restart');
   assert.equal((await (await fetch(base+'/api/events')).json() as any).events.length,3);});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a hung host times out on its own without delaying other hosts',async()=>{
 const monitor=createMonitor({hosts:[{...host,name:'hung',ssh:'hung',timeoutSeconds:0.3},host]},{run:async(_bin:string,args:string[])=>args.includes('hung')?new Promise(()=>{}):{stdout:JSON.stringify(snap(Date.now()))}});
 await serve(monitor,async base=>{
  const all=monitor.refresh();await monitor.refreshHost('c8');
  let j=await (await fetch(base+'/api/fleet')).json() as any;assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.status]),[['hung','loading'],['c8','online']]);
  const started=Date.now();await all;assert.ok(Date.now()-started<2000);
  j=await (await fetch(base+'/api/fleet')).json() as any;assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.status]),[['hung','offline'],['c8','online']]);
 });
 assert.throws(()=>createMonitor({hosts:[{...host,timeoutSeconds:0}]}),/invalid-hosts/);assert.throws(()=>createMonitor({hosts:[{...host,refreshSeconds:'20'}]}),/invalid-hosts/);
});
test('staleness follows each host refresh interval',async()=>{
 let clock=T0;const monitor=createMonitor({refreshSeconds:20,hosts:[host,{...host,name:'slow',ssh:'slow',refreshSeconds:120}]},{now:()=>clock,run:async(_b:string,args:string[])=>({stdout:JSON.stringify({...snap(T0),host:args.includes('slow')?'slow':'c8'})})});
 await serve(monitor,async base=>{await monitor.refresh();clock+=61000;let j=await (await fetch(base+'/api/fleet')).json() as any;assert.deepEqual(j.hosts.map((h:any)=>[h.name,h.refreshSeconds,h.stale]),[['c8',20,true],['slow',120,false]]);
  clock+=300000;j=await (await fetch(base+'/api/fleet')).json() as any;assert.equal(j.hosts[1].stale,true);});
});
test('alert configuration rejects unsafe webhooks and never needs a token value',()=>{
 for(const alerts of [{webhookUrl:'https://api.telegram.org/bot123/sendMessage'},{webhookUrl:'http://127.0.0.1:8000/notify',authEnv:'lower-case'},{webhookUrl:'http://127.0.0.1:8000/notify',quietHours:{start:'x',end:'07:00'}},{webhookUrl:'http://127.0.0.1:8000/notify',kinds:['service','bogus kind!']},{webhookUrl:'http://127.0.0.1:8000/notify',offlineAfterSeconds:-1}])assert.throws(()=>createMonitor({hosts:[host],alerts}),/invalid-alerts/);
 assert.throws(()=>createMonitor({hosts:[host],stateDir:'relative/dir'}),/invalid-state-dir/);
});
test('history keeps persisting after events.jsonl is removed externally and reports it once with a fixed warning',async()=>{
 const dir=await tmp();try{
  const warnings:string[]=[];const h=createHistory({dir,maxBytes:600,keep:100,log:(m:string)=>warnings.push(m)});await h.load();
  const ev=(i:number)=>({at:new Date(T0+i*1000).toISOString(),host:'c8',type:'attention',kind:'service',title:'unit-'+i,severity:'error'});
  for(let i=0;i<4;i++)h.add(ev(i));await h.flush();
  await fs.rm(path.join(dir,'events.jsonl'));
  for(let i=4;i<12;i++)h.add(ev(i));await h.flush();
  const again=createHistory({dir,maxBytes:600,keep:100});await again.load();const titles=again.recent({limit:100}).map(e=>e.title);
  assert.equal(titles[0],'unit-11');for(const t of ['unit-4','unit-5','unit-10'])assert.ok(titles.includes(t),t+' persisted');
  for(const f of await fs.readdir(dir))assert.ok((await fs.stat(path.join(dir,f))).size<=600);
  assert.deepEqual(warnings,['host-monitor: history file missing; recreated']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
