import {test} from 'node:test';import net from 'node:net';import assert from 'node:assert/strict';import {once} from 'node:events';import fs from 'node:fs/promises';import path from 'node:path';
import {createMonitor} from '../src/server.ts';import {parseBeszelStats} from '../src/beszel.ts';
const stats=JSON.parse(await fs.readFile(path.join(import.meta.dirname,'fixtures/beszel/system-stats.json'),'utf8'));
const GIB=2**30,collectedAt='2026-09-28T15:34:15.000Z',at=Date.parse(collectedAt);
const mac={name:'mac-a',ssh:'mac-a',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'};
const snapshot=(resources:string)=>({schemaVersion:1,host:'mac-a',platform:resources==='external'?'darwin':'linux',resources,collectedAt,services:[],attention:[],hardware:{cpuCount:8,load:[0,0,0],uptime:10,kernel:'Darwin'}});
const env={HUB_EMAIL:'monitor@example.test',HUB_PASSWORD:'hub-secret-value'};
const beszel={url:'http://127.0.0.1:8090',emailEnv:'HUB_EMAIL',passwordEnv:'HUB_PASSWORD'};
// A fake hub: records requests and answers like the PocketBase API (auth, systems, system_stats).
function hub({down=false,age=0,known=['Mac-A']}={}){
 const state={down,age,calls:[] as {url:string;auth?:string;body?:string}[]};
 const fetchImpl=async(url:URL|string,init:RequestInit={})=>{
  const u=new URL(String(url)),auth=(init.headers as Record<string,string>|undefined)?.Authorization;
  state.calls.push({url:u.pathname+u.search,auth,body:init.body as string|undefined});
  if(state.down)throw new TypeError('fetch failed');
  const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  if(u.pathname==='/api/collections/users/auth-with-password')return json({token:'session-token'});
  if(auth!=='session-token')return new Response('{}',{status:401});
  if(u.pathname==='/api/collections/systems/records'){const name=/name\s*[=~]\s*'([^']*)'/.exec(u.searchParams.get('filter')??'')?.[1];return json({items:known.some(k=>k.toLowerCase()===name?.toLowerCase())?[{id:'sys1',name}]:[]});}
  if(u.pathname==='/api/collections/system_stats/records'){const record=stats.items[0];return json({items:[{...record,created:new Date(at-state.age).toISOString().replace('T',' ')}]});}
  return new Response('{}',{status:404});
 };
 return Object.assign(state,{fetchImpl});
}
async function running(h:ReturnType<typeof hub>,resources:string,fn:(m:ReturnType<typeof createMonitor>,fleet:()=>Promise<any>)=>Promise<void>,extra:object={}){
 const monitor=createMonitor({hosts:[mac],beszel,...extra} as any,{now:()=>at,env,fetch:h.fetchImpl as any,run:async()=>({stdout:JSON.stringify(snapshot(resources))})});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');const base='http://127.0.0.1:'+(monitor.server.address() as net.AddressInfo).port;
 try{await fn(monitor,async()=>(await fetch(base+'/api/fleet')).json());}finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
}
test('Beszel stats become one root row and one row per extra filesystem',()=>{
 const disks=parseBeszelStats(stats.items[0].stats);
 assert.deepEqual(disks.map(d=>d.mount),['/','Archive','Data A','Data B','Scratch']);
 const root=disks[0];assert.equal(root.total,Math.round(926.3*GIB));assert.equal(root.used,Math.round(81.59*GIB));assert.equal(root.available,root.total-root.used);assert.equal(root.percent,8.8);
 const data=disks.find(d=>d.mount==='Data A')!;assert.equal(data.percent,1);assert.equal(data.source,'Beszel');
 assert.deepEqual(parseBeszelStats({d:100,du:50}).map(d=>d.mount),['/']);
 assert.deepEqual(parseBeszelStats({d:0,du:0,efs:{x:{d:10,du:11},y:{d:'bad'},z:null}}).map(d=>d.mount),[]);
});
test('an external host shows the disks Beszel reports, read-only with the configured credentials',async()=>{
 const h=hub();await running(h,'external',async(m,fleet)=>{
  await m.refresh();const host=(await fleet()).hosts[0];
  assert.equal(host.beszel.status,'ok');assert.equal(host.beszel.disks.length,5);assert.equal(host.beszel.disks[0].mount,'/');assert.equal(host.beszel.lastSuccess,collectedAt);assert.equal(host.beszel.recordedAt,'2026-09-28T15:34:15.000Z');
  assert.equal(JSON.stringify(host).includes('hub-secret-value'),false);assert.equal(JSON.stringify(host).includes('session-token'),false);
  const auth=h.calls[0];assert.equal(auth.url,'/api/collections/users/auth-with-password');assert.deepEqual(JSON.parse(auth.body!),{identity:'monitor@example.test',password:'hub-secret-value'});
  assert.ok(h.calls.slice(1).every(c=>c.auth==='session-token'&&!c.body));
  const n=h.calls.length;await m.refresh();assert.equal(h.calls.length-n,1,'a later refresh reuses the session token and system id');
 });
});
test('a host that collects its own resources never calls the hub',async()=>{
 const h=hub();await running(h,'collected',async(m,fleet)=>{await m.refresh();assert.equal('beszel' in (await fleet()).hosts[0],false);assert.equal(h.calls.length,0);});
});
test('without a beszel block the fleet is unchanged',async()=>{
 const h=hub();const monitor=createMonitor({hosts:[mac]},{now:()=>at,env,fetch:h.fetchImpl as any,run:async()=>({stdout:JSON.stringify(snapshot('external'))})});
 await monitor.refresh();monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');
 try{const j=await (await fetch('http://127.0.0.1:'+(monitor.server.address() as net.AddressInfo).port+'/api/fleet')).json() as any;assert.equal('beszel' in j.hosts[0],false);assert.equal(h.calls.length,0);}finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('an unreachable hub keeps the last disks and last success time and says it is unavailable',async()=>{
 const h=hub();await running(h,'external',async(m,fleet)=>{
  await m.refresh();h.down=true;await m.refresh();const host=(await fleet()).hosts[0];
  assert.equal(host.status,'online');assert.equal(host.beszel.status,'unavailable');assert.equal(host.beszel.disks.length,5);assert.equal(host.beszel.lastSuccess,collectedAt);
 });
 const never=hub({down:true});await running(never,'external',async(m,fleet)=>{await m.refresh();const host=(await fleet()).hosts[0];assert.deepEqual(host.beszel,{status:'unavailable',lastSuccess:null,recordedAt:null,disks:[]});});
});
test('a system the hub does not know and missing credentials are unavailable, not errors',async()=>{
 await running(hub({known:[]}),'external',async(m,fleet)=>{await m.refresh();assert.equal((await fleet()).hosts[0].beszel.status,'unavailable');});
 const h=hub(),monitor=createMonitor({hosts:[mac],beszel},{now:()=>at,env:{},fetch:h.fetchImpl as any,run:async()=>({stdout:JSON.stringify(snapshot('external'))})});
 await monitor.refresh();assert.equal(h.calls.length,0);
});
test('a hub record older than the staleness limit is reported stale', async()=>{
 await running(hub({age:11*60*1000}),'external',async(m,fleet)=>{await m.refresh();const host=(await fleet()).hosts[0];assert.equal(host.beszel.status,'stale');assert.equal(host.beszel.disks.length,5);});
});
test('an ok reading turns stale as it ages, without another hub read', async()=>{
 let clock=at;const h=hub(),monitor=createMonitor({hosts:[mac],beszel},{now:()=>clock,env,fetch:h.fetchImpl as any,run:async()=>({stdout:JSON.stringify(snapshot('external'))})});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');const base='http://127.0.0.1:'+(monitor.server.address() as net.AddressInfo).port;
 try{await monitor.refresh();const read=async()=>(await (await fetch(base+'/api/fleet')).json() as any).hosts[0].beszel.status;
  assert.equal(await read(),'ok');clock+=11*60*1000;assert.equal(await read(),'stale');}
 finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('a system recreated in the hub is found again under its new id', async()=>{
 const h=hub();let id='sys1';const inner=h.fetchImpl;
 const fetchImpl=async(url:URL|string,init:RequestInit={})=>{const u=new URL(String(url));
  if(u.pathname==='/api/collections/systems/records')return new Response(JSON.stringify({items:[{id,name:'Mac-A'}]}),{status:200});
  if(u.pathname==='/api/collections/system_stats/records'&&!String(u.searchParams.get('filter')).includes(id))return new Response(JSON.stringify({items:[]}),{status:200});
  return inner(url,init);};
 const monitor=createMonitor({hosts:[mac],beszel},{now:()=>at,env,fetch:fetchImpl as any,run:async()=>({stdout:JSON.stringify(snapshot('external'))})});
 monitor.server.listen(0,'127.0.0.1');await once(monitor.server,'listening');const base='http://127.0.0.1:'+(monitor.server.address() as net.AddressInfo).port;
 try{const status=async()=>(await (await fetch(base+'/api/fleet')).json() as any).hosts[0].beszel.status;
  await monitor.refresh();assert.equal(await status(),'ok');id='sys2';await monitor.refresh();assert.equal(await status(),'unavailable');await monitor.refresh();assert.equal(await status(),'ok');}
 finally{monitor.stop();await new Promise(r=>monitor.server.close(r));}
});
test('the Beszel system name can differ from the host name',async()=>{
 const h=hub({known:['Hub Name']});await running(h,'external',async(m,fleet)=>{await m.refresh();assert.equal((await fleet()).hosts[0].beszel.status,'ok');},{hosts:[{...mac,beszelName:'Hub Name'}]});
});
test('beszel configuration is validated',()=>{
 for(const bad of [{...beszel,url:'http://hub.example.com'},{...beszel,url:'http://user:pw@127.0.0.1:8090'},{...beszel,emailEnv:'lower'},{...beszel,passwordEnv:undefined},{url:beszel.url},'x'])
  assert.throws(()=>createMonitor({hosts:[mac],beszel:bad} as any),/invalid-beszel/);
 assert.throws(()=>createMonitor({hosts:[{...mac,beszelName:'a\nb'}],beszel} as any),/invalid-hosts/);
});
