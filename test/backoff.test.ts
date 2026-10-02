import {test} from 'node:test';import assert from 'node:assert/strict';import {createMonitor} from '../src/server.ts';
const snapshot={schemaVersion:1,host:'lap',collectedAt:'2026-10-01T00:00:00Z',platform:'linux',services:[],attention:[],hardware:{cpuCount:2,load:[0,0,0],uptime:1,kernel:'Linux'}};
const entry={name:'lap',ssh:'lap',node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json',bestEffort:true};
// A fake ssh: `true` is the reachability probe, anything else is a full collection.
function world(){
 const w={up:false,probes:0,collections:0,clock:Date.parse('2026-10-01T00:00:00Z')};
 const run=async(_f:string,args:string[])=>{if(args.at(-1)==='true'){w.probes++;if(!w.up)throw Error('unreachable');return {stdout:''};}w.collections++;if(!w.up)throw Error('unreachable');return {stdout:JSON.stringify({...snapshot,collectedAt:new Date(w.clock).toISOString()})};};
 return Object.assign(w,{run});
}
const make=(w:ReturnType<typeof world>,extra:object={},host:object={})=>createMonitor({hosts:[{...entry,...host}],alerts:{webhookUrl:'http://127.0.0.1:1/x',offlineAfterSeconds:1},...extra} as any,{now:()=>w.clock,run:w.run,fetch:(async()=>({ok:true,status:200})) as any});
const view=async(m:ReturnType<typeof make>)=>{m.server.listen(0,'127.0.0.1');await new Promise(r=>m.server.once('listening',r));const port=(m.server.address() as any).port;try{return (await (await fetch('http://127.0.0.1:'+port+'/api/fleet')).json() as any).hosts[0];}finally{m.server.close();}};
test('an unreachable best-effort host backs off 1, 2, 5, 15 minutes, capped, with no full collection',async()=>{
 const w=world(),m=make(w);
 await m.refreshHost('lap');assert.equal(w.collections,1);assert.equal(w.probes,1,'the failed collection is followed by one reachability check');
 const next=[];for(let i=0;i<5;i++){const h=m.reachability('lap')!;next.push((h.nextCheckMs-w.clock)/60000);w.clock=h.nextCheckMs;await m.refreshHost('lap');}
 assert.deepEqual(next,[1,2,5,15,15]);assert.equal(w.collections,1,'no full collection while unreachable');assert.equal(w.probes,6);m.stop();
});
test('the first successful check resumes full collection and clears the backoff',async()=>{
 const w=world(),m=make(w);await m.refreshHost('lap');w.clock+=60000;await m.refreshHost('lap');
 w.up=true;w.clock+=120000;await m.refreshHost('lap');
 assert.equal(w.collections,2,'one full collection after recovery');assert.equal(m.reachability('lap'),undefined);
 const host=await view(m);assert.equal(host.status,'online');assert.equal(host.reachability,undefined);m.stop();
});
test('the dashboard data says offline with last seen and next check, and no offline event is recorded',async()=>{
 const w=world(),m=make(w);w.up=true;await m.refreshHost('lap');const seen=new Date(w.clock).toISOString();w.up=false;w.clock+=600000;await m.refreshHost('lap');
 m.server.listen(0,'127.0.0.1');await new Promise(r=>m.server.once('listening',r));const base='http://127.0.0.1:'+(m.server.address() as any).port;
 try{const host=(await (await fetch(base+'/api/fleet')).json() as any).hosts[0];
  assert.equal(host.status,'offline');assert.equal(host.reachability.lastSeen,seen);assert.equal(host.reachability.nextCheck,new Date(w.clock+60000).toISOString());
  w.clock+=3600000;await m.refreshHost('lap');await m.idle();
  assert.deepEqual((await (await fetch(base+'/api/events')).json() as any).events.filter((e:any)=>e.type==='offline'),[]);
 }finally{m.stop();m.server.close();}
});
test('a host that is reachable but fails collection keeps the normal schedule, and required hosts never probe',async()=>{
 const w=world(),broken=createMonitor({hosts:[entry]} as any,{now:()=>w.clock,run:async(_f,args)=>{if(args.at(-1)==='true')return {stdout:''};w.collections++;throw Error('collector broken');}});
 await broken.refreshHost('lap');assert.equal(broken.reachability('lap'),undefined);broken.stop();
 const required=make(w,{},{bestEffort:undefined});await required.refreshHost('lap');await required.refreshHost('lap');assert.equal(w.probes,0);assert.equal(required.reachability('lap'),undefined);required.stop();
});
test('backoff configuration is validated and per-host settings override the server default',()=>{
 for(const bad of [[],[0],[1,'x'],Array(9).fill(60),[86401]])assert.throws(()=>createMonitor({hosts:[entry],backoffSeconds:bad} as any),/invalid-backoff/);
 assert.throws(()=>createMonitor({hosts:[{...entry,bestEffort:'yes'}]} as any),/invalid-hosts/);
 assert.throws(()=>createMonitor({hosts:[{name:'x',node:'/n',collector:'/c',config:'/h',bestEffort:true}]} as any),/invalid-hosts/);
 const w=world(),m=make(w,{backoffSeconds:[30,90]},{backoffSeconds:[10]});return m.refreshHost('lap').then(()=>{assert.equal(m.reachability('lap')!.nextCheckMs-w.clock,10000);m.stop();});
});
test('a host that is reachable again but whose collector fails stops showing the old backoff',async()=>{
 const w=world();
 const fixed=createMonitor({hosts:[entry]} as any,{now:()=>w.clock,run:async(_f,args)=>{if(args.at(-1)==='true'){if(!w.up)throw Error('down');return {stdout:''};}throw Error('collector broken');}});
 await fixed.refreshHost('lap');assert.ok(fixed.reachability('lap'),'probe failed first: backoff');
 w.up=true;w.clock+=60000;await fixed.refreshHost('lap');assert.equal(fixed.reachability('lap'),undefined);
 fixed.server.listen(0,'127.0.0.1');await new Promise(r=>fixed.server.once('listening',r));
 try{const host=(await (await fetch('http://127.0.0.1:'+(fixed.server.address() as any).port+'/api/fleet')).json() as any).hosts[0];assert.equal(host.status,'offline');assert.equal(host.reachability,undefined);}finally{fixed.stop();fixed.server.close();}
});
test('a best-effort ssh alias must be a plain alias',()=>{
 assert.throws(()=>createMonitor({hosts:[{...entry,ssh:'-oProxyCommand=x'}]} as any),/invalid-hosts/);
});
