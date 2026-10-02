import {test} from 'node:test';import assert from 'node:assert/strict';import {AGENTLESS_SCRIPT,agentlessSnapshot} from '../src/agentless.ts';import {createMonitor} from '../src/server.ts';
const output=['host-monitor-agentless-v1','{ sec = 1759000000, usec = 123456 } Tue Sep 28 00:00:00 2025','10','Apple M4','25.0.0','host-monitor-agentless-end',''].join('\n');
const now=(1759000000+90061)*1000;
test('the output becomes a darwin snapshot with external resources, uptime, and no services',()=>{
 const s=agentlessSnapshot('lap',output,now);
 assert.equal(s.host,'lap');assert.equal(s.platform,'darwin');assert.equal(s.resources,'external');assert.equal(s.agentless,true);
 assert.equal(s.hardware.cpuCount,10);assert.equal(s.hardware.cpuModel,'Apple M4');assert.equal(s.hardware.kernel,'25.0.0');assert.equal(s.hardware.uptime,90061);
 assert.deepEqual([s.services,s.failedUnits,s.containers,s.probes,s.attention,s.collectionIssues],[[],[],[],[],[],[]]);assert.equal(s.collectedAt,new Date(now).toISOString());
});
test('truncated, garbled, or implausible output is rejected as a whole',()=>{
 for(const bad of ['',output.replace('host-monitor-agentless-end\n',''),output.replace('10\n','many\n'),output.replace('{ sec = 1759000000, usec = 123456 }','nothing'),output.replace('{ sec = 1759000000','{ sec = 9999999999999'),'x'.repeat(5000)])
  assert.throws(()=>agentlessSnapshot('lap',bad,now),/invalid-agentless/);
});
test('the remote command is one fixed read-only script',()=>{
 const script=AGENTLESS_SCRIPT.replaceAll('2>/dev/null','');
 assert.ok(!/[>]|\brm\b|\btee\b|\bmv\b|\bcp\b|\bcurl\b|\bwget\b/.test(script),AGENTLESS_SCRIPT);
 assert.match(AGENTLESS_SCRIPT,/sysctl -n kern.boottime/);
});
test('an agentless host is collected over ssh with only the fixed script and shows up in the fleet',async()=>{
 const calls:Array<[string,string[]]>=[];
 const m=createMonitor({hosts:[{name:'lap',ssh:'lap',agentless:true}]} as any,{now:()=>now,run:async(f,a)=>{calls.push([f,a]);return {stdout:output};}});
 await m.refreshHost('lap');
 assert.deepEqual(calls,[['ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','lap',AGENTLESS_SCRIPT]]]);
 m.server.listen(0,'127.0.0.1');await new Promise(r=>m.server.once('listening',r));
 try{const h=(await (await fetch('http://127.0.0.1:'+(m.server.address() as any).port+'/api/fleet')).json() as any).hosts[0];assert.equal(h.status,'online');assert.equal(h.snapshot.agentless,true);assert.equal(h.snapshot.hardware.uptime,90061);}finally{m.stop();m.server.close();}
});
test('agentless needs a plain ssh alias and cannot be combined with collector or adb settings',()=>{
 for(const bad of [{name:'x'},{name:'x',ssh:'-oBad',agentless:true},{name:'x',ssh:'x',agentless:true,collector:'/c'},{name:'x',ssh:'x',agentless:true,adb:{serial:'A1'}},{name:'x',ssh:'x',agentless:'yes'}])
  assert.throws(()=>createMonitor({hosts:[bad.agentless===undefined?{...bad,agentless:true}:bad]} as any),/invalid-hosts/);
});
test('an unreachable agentless best-effort host backs off like any best-effort host',async()=>{
 let up=false,collections=0,probes=0,clock=now;
 const m=createMonitor({hosts:[{name:'lap',ssh:'lap',agentless:true,bestEffort:true}]} as any,{now:()=>clock,run:async(_f,a)=>{if(a.at(-1)==='true'){probes++;if(!up)throw Error('x');return {stdout:''};}collections++;if(!up)throw Error('x');return {stdout:output};}});
 await m.refreshHost('lap');clock+=60000;await m.refreshHost('lap');assert.equal(collections,1);assert.ok(probes>=2);
 up=true;clock+=120000;await m.refreshHost('lap');assert.equal(collections,2);assert.equal(m.reachability('lap'),undefined);m.stop();
});
