import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {once} from 'node:events';
import {createTracker,createNotifier,createHistory,webhookUrl,parseQuietHours,inQuietHours} from '../src/alerts.ts';
import {createMonitor} from '../src/server.ts';import type {Attention} from '../src/model.ts';import type net from 'node:net';
const port=(s:net.Server)=>(s.address() as net.AddressInfo).port;
const T0=Date.parse('2026-09-28T04:00:00Z');
const stopped={severity:'error',kind:'service',title:'web.service',detail:'user · inactive · success'};
const tmp=()=>fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-alerts-'));
function recorder({fail=0}={}){const calls:{url:string;init:RequestInit&{headers:Record<string,string>};body:any}[]=[];let failures=fail;const fetchImpl=async(url:URL,init:RequestInit)=>{calls.push({url:String(url),init:init as RequestInit&{headers:Record<string,string>},body:JSON.parse(init.body as string)});if(failures-->0)throw Error('relay down');return new Response('ok');};return {calls,fetchImpl};}

test('transitions are emitted once per new attention item, recovery and offline period',()=>{
 const t=createTracker({offlineAfterMs:300000,graceMs:0});
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
 for(const url of ['http://127.0.0.1:8000/notify','http://localhost:8000/notify','http://[::1]:8000/notify','https://relay.example.ts.net:8001/notify','http://100.64.0.10:8000/notify'])assert.equal(webhookUrl(url).href,new URL(url).href);
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
 const t=createTracker({graceMs:0});t.online('c8',[],T0);n.submit(t.online('c8',[stopped],T0+1),T0+1);n.submit(t.online('c8',[{severity:'warning',kind:'journal',title:'noisy.service',detail:'3 errors in the last hour'}],T0+2),T0+2);await n.idle();
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
 const night=Date.parse('2026-09-28T16:00:00Z'),morning=Date.parse('2026-09-28T23:05:00Z');const t=createTracker({graceMs:0});t.online('c8',[],night);
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
   await monitor.refresh();attention=[stopped];for(let i=0;i<6;i++){clock+=20000;await monitor.refresh();}attention=[];clock+=20000;await monitor.refresh();clock+=20000;await monitor.refresh();await monitor.idle();
   assert.deepEqual(calls.map(c=>c.body.title),['[host-monitor] c8: service needs attention','[host-monitor] c8: service recovered']);
   const events=(await (await fetch(base+'/api/events')).json() as any).events;assert.deepEqual(events.map((e:any)=>[e.type,e.host,e.title]),[['recovered','c8','web.service'],['attention','c8','web.service']]);
   assert.equal((await (await fetch(base+'/api/events?limit=1')).json() as any).events.length,1);
   for(const q of ['limit=0','limit=501','limit=x','host=other','host=c8;id'])assert.equal((await fetch(base+'/api/events?'+q)).status,400);
   assert.equal((await fetch(base+'/api/events',{method:'POST'})).status,405);
  });
  attention=[stopped];const restarted=createMonitor(config,{now:()=>clock,fetch:fetchImpl,sleep:async()=>{},run:async()=>({stdout:JSON.stringify(snap(clock,attention))})});
  await serve(restarted,async base=>{await restarted.refresh();clock+=100000;await restarted.refresh();await restarted.idle();assert.equal(calls.length,3,'persisted state still detects a new item after restart');
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
test('Android device attention is notified by default; generic disk and memory kinds stay with Beszel',async()=>{
 const {calls,fetchImpl}=recorder();const n=createNotifier({url:'http://127.0.0.1:8000/notify',fetchImpl,sleep:async()=>{}});
 const t=createTracker({graceMs:0});t.online('s22',[],T0);
 n.submit(t.online('s22',[{severity:'error',kind:'device',title:'Battery temperature',detail:'46.0 °C'},{severity:'warning',kind:'disk',title:'/',detail:'90% used'}],T0+1),T0+1);await n.idle();
 assert.deepEqual(calls.map(c=>c.body),[{title:'[host-monitor] s22: device needs attention',body:'Battery temperature — 46.0 °C',type:'failure',format:'text'}]);
});

// Issue #15: self-healing restarts stay quiet; sustained failures and restart loops still alert.
const probe={severity:'error',kind:'probe',title:'Agent Console speech',detail:'Endpoint unavailable'};
const restarting={severity:'error',kind:'service',title:'agent-console-c8-serve.service',detail:'user · activating · exit-code'};
const types=(events:{type:string;kind:string;title:string}[])=>events.map(e=>[e.type,e.kind,e.title]);
test('an item that recovers within the default 90 s grace window raises no alert and no recovery',()=>{
 const t=createTracker();t.online('c8',[],T0,{'agent-console-c8-serve.service':2});
 assert.deepEqual(t.online('c8',[restarting,probe],T0+30000,{'agent-console-c8-serve.service':2}),[],'exit 75 seen while systemd restarts the unit');
 assert.deepEqual(t.online('c8',[probe],T0+60000,{'agent-console-c8-serve.service':3}),[],'one automatic restart is not a loop');
 assert.deepEqual(t.online('c8',[probe],T0+110000,{'agent-console-c8-serve.service':3}),[],'80 s after it was first seen the probe is still within the window');
 assert.deepEqual(t.online('c8',[],T0+120000,{'agent-console-c8-serve.service':3}),[],'no recovery for an incident that never alerted');
 assert.deepEqual(t.snapshot().c8.active,[]);
});
test('an item still unhealthy after its grace window alerts once and recovers once',()=>{
 const t=createTracker();t.online('sympoies',[],T0);
 for(let at=T0+20000;at<T0+110000;at+=20000)assert.deepEqual(t.online('sympoies',[probe],at),[]);
 const raised=t.online('sympoies',[probe],T0+110000);assert.deepEqual(types(raised),[['attention','probe','Agent Console speech']]);assert.equal(raised[0].detail,'Endpoint unavailable');
 assert.deepEqual(t.online('sympoies',[probe],T0+130000),[]);
 assert.deepEqual(types(t.online('sympoies',[],T0+150000)),[['recovered','probe','Agent Console speech']]);
 const zero=createTracker({graceMs:0});zero.online('c8',[],T0);assert.deepEqual(types(zero.online('c8',[restarting],T0+1)),[['attention','service','agent-console-c8-serve.service']],'a zero window alerts on first sight');
});
test('the grace window can be set per item',()=>{
 const t=createTracker({graceMs:(host:string,a:Attention)=>host==='sympoies'&&a.kind==='probe'&&a.title==='Agent Console speech'?180000:90000});
 t.online('sympoies',[],T0);t.online('sympoies',[probe,stopped],T0+20000);
 assert.deepEqual(types(t.online('sympoies',[probe,stopped],T0+120000)),[['attention','service','web.service']]);
 assert.deepEqual(t.online('sympoies',[probe,stopped],T0+190000),[]);
 assert.deepEqual(types(t.online('sympoies',[probe,stopped],T0+200000)),[['attention','probe','Agent Console speech']]);
});
test('automatic restarts counted by systemd alert as a restart loop even when no collection sees the unit down',()=>{
 const t=createTracker(),name='agent-console-c8-serve.service',at=(m:number)=>T0+m*60000;t.online('c8',[],at(0),{[name]:7});
 assert.deepEqual(t.online('c8',[],at(2),{[name]:8}),[]);assert.deepEqual(t.online('c8',[],at(4),{[name]:9}),[]);
 const loop=t.online('c8',[],at(6),{[name]:10});assert.deepEqual(types(loop),[['attention','service',name]]);assert.equal(loop[0].severity,'error');assert.equal(loop[0].detail,'restart loop · 3 restarts in 10 min');
 assert.deepEqual(t.online('c8',[],at(8),{[name]:11}),[],'further restarts extend the same incident');
 assert.deepEqual(t.online('c8',[],at(13),{[name]:11}),[],'still three restarts in the last 10 min');
 assert.deepEqual(types(t.online('c8',[],at(15),{[name]:11})),[['recovered','service',name]],'fewer than three restarts in the last 10 min');
});
test('a counter reset by a manual restart and the first counter seen are not restarts',()=>{
 const t=createTracker(),name='agent-console-speech.service';t.online('sympoies',[],T0,{[name]:40});
 assert.deepEqual(t.online('sympoies',[],T0+60000,{[name]:0}),[]);assert.deepEqual(t.online('sympoies',[],T0+120000,{[name]:1}),[]);
 assert.deepEqual(t.online('sympoies',[],T0+180000,{[name]:1,'new.service':5}),[]);
 assert.deepEqual(types(t.online('sympoies',[],T0+240000,{[name]:3})),[['attention','service',name]],'1 then 2 more: three restarts');
});
test('a restart seen both as a failed unit and as a counter step counts once',()=>{
 const t=createTracker(),name='agent-console-c8-serve.service',at=(s:number)=>T0+s*1000;t.online('c8',[],at(0),{[name]:0});
 for(let cycle=0;cycle<2;cycle++){const base=cycle*120,count=cycle;
  assert.deepEqual(t.online('c8',[{...restarting,title:name}],at(base+30),{[name]:count}),[]);
  assert.deepEqual(t.online('c8',[],at(base+60),{[name]:count+1}),[]);}
 assert.deepEqual(t.snapshot().c8.active,[],'two restarts are not a loop');
});
test('an item without a restart counter that keeps failing and recovering alerts as flapping',()=>{
 const t=createTracker();t.online('sympoies',[],T0);
 for(const m of [1,3])assert.deepEqual([...t.online('sympoies',[probe],T0+m*60000),...t.online('sympoies',[],T0+m*60000+20000)],[]);
 const flap=t.online('sympoies',[probe],T0+5*60000);assert.deepEqual(types(flap),[['attention','probe','Agent Console speech']]);assert.equal(flap[0].detail,'flapping · 3 failures in 10 min');
 assert.deepEqual(t.online('sympoies',[],T0+5*60000+20000),[],'a flapping incident stays open while failures continue');
 assert.deepEqual(types(t.online('sympoies',[],T0+11*60000+20000)),[['recovered','probe','Agent Console speech']]);
});
test('items found on the first observation are a silent baseline that also recovers silently',()=>{
 const t=createTracker();assert.deepEqual(t.online('c8',[stopped],T0),[]);assert.deepEqual(t.online('c8',[stopped],T0+300000),[]);
 assert.deepEqual(t.online('c8',[],T0+320000),[]);
 const restored=createTracker({state:{c8:{active:[],baseline:[stopped]}}});assert.deepEqual(restored.online('c8',[],T0),[]);
 const notified=createTracker({state:{c8:{active:[stopped]}}});assert.deepEqual(types(notified.online('c8',[],T0)),[['recovered','service','web.service']]);
});
test('grace and restart-loop settings are validated server options',async()=>{
 for(const alerts of [{graceSeconds:-1},{graceSeconds:'90'},{graceSeconds:3601},{restartLoop:{restarts:1,windowSeconds:600}},{restartLoop:{restarts:3,windowSeconds:0}},{restartLoop:{restarts:3}},
  {graceOverrides:[{kind:'probe',title:'x'}]},{graceOverrides:[{kind:'Probe',title:'x',graceSeconds:60}]},{graceOverrides:[{host:'other',kind:'probe',title:'x',graceSeconds:60}]},{graceOverrides:{}}])
  assert.throws(()=>createMonitor({hosts:[host],alerts:{webhookUrl:'http://127.0.0.1:8000/notify',...alerts}}),/invalid-alerts/,JSON.stringify(alerts));
 createMonitor({hosts:[host],alerts:{webhookUrl:'http://127.0.0.1:8000/notify',graceSeconds:0,restartLoop:{restarts:0,windowSeconds:600},graceOverrides:[{host:'c8',kind:'probe',title:'web API',graceSeconds:180}]}});
});
test('the monitor applies the grace window, per-item overrides and systemd restart counters end to end',async()=>{
 let clock=T0,attention:Attention[]=[],restarts=0;const {calls,fetchImpl}=recorder();
 const services=()=>[{name:'agent-console-c8-serve.service',scope:'user',health:'ok',restarts}];
 const config={hosts:[host],alerts:{webhookUrl:'http://127.0.0.1:8000/notify',graceOverrides:[{host:'c8',kind:'probe',title:'slow API',graceSeconds:300}]}};
 const monitor=createMonitor(config,{now:()=>clock,fetch:fetchImpl,sleep:async()=>{},run:async()=>({stdout:JSON.stringify({...snap(clock,attention),services:services()})})});
 const step=async(seconds:number)=>{clock+=seconds*1000;await monitor.refresh();};
 await monitor.refresh();attention=[restarting];await step(20);attention=[];restarts=1;await step(20);await monitor.idle();
 assert.equal(calls.length,0,'a 5 s self-healing restart sends nothing');
 attention=[{...probe,title:'slow API'},stopped];for(let i=0;i<6;i++)await step(20);await monitor.idle();
 assert.deepEqual(calls.map(c=>[c.body.title,c.body.body]),[['[host-monitor] c8: service needs attention','web.service — user · inactive · success']]);
 attention=[];restarts=3;await step(20);await monitor.idle();
 assert.deepEqual(calls.slice(1).map(c=>[c.body.title,c.body.body]),[['[host-monitor] c8: service needs attention','agent-console-c8-serve.service — restart loop · 3 restarts in 10 min'],['[host-monitor] c8: service recovered','web.service']]);
 monitor.stop();
});
