import {createNotifier} from '../src/alerts.ts';
import {once} from 'node:events';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {routerSnapshot,ROUTER_COMMAND,createAdGuardReleaseCheck} from '../src/router.ts';import {createMonitor} from '../src/server.ts';
const epoch=Date.parse('2026-10-06T00:00:00+08:00')/1000;
const output=(boot='2026-10-05T06:31:00+08:00')=>`host-monitor-router-v1\nepoch=${epoch}\nuptime=${epoch-Date.parse(boot)/1000}\ncpu_count=4\nkernel=4.19.183\nfirmware=3006.102.7_2\nwan_state=2\nreboot_schedule=01001000630\nutc_offset=+0800\nntp_ready=1\nwebs_state_flag=1\nwebs_state_info=3006_102_9_0\nconnmon=${epoch-60}|2.4|0\nwatchdog_count=0\nradio0=1\nradio1=1\nclients0=3\nclients1=2\nagh_process=1\nagh_listener=1\nagh_dns=1\nagh_blocked=1\nagh_querylog_bytes=4096\nagh_version=0.107.79\nhost-monitor-router-end\n`;
test('router has WAN, uptime, scheduled boot, connmon, radio and firmware notice',()=>{
 const s=routerSnapshot('appliance',output(),epoch*1000);assert.equal(s.hardware.uptime,62940);assert.equal(s.router?.scheduledBoot,true);assert.equal(s.router?.firmwareAvailable,'3006.102.9_0');assert.equal(s.router?.connmon?.latencyMs,2.4);assert.equal(s.router?.clients0,3);
 assert.deepEqual(s.attention.map(a=>[a.title,a.severity]),[['Merlin firmware update 3006.102.9_0','notice']]);
});
test('WAN loss, stale connmon, watchdog and unscheduled boot produce separate attention',()=>{
 const s=routerSnapshot('appliance',output('2026-10-05T09:00:00+08:00').replace('wan_state=2','wan_state=0').replace('watchdog_count=0','watchdog_count=20').replace(`${epoch-60}|2.4|0`,`${epoch-1200}|75|100`),epoch*1000);
 for(const title of ['WAN disconnected','Unscheduled reboot','connmon unavailable','ASUS watchdog loop'])assert.ok(s.attention.some(a=>a.title===title),title);
 assert.ok(!s.attention.some(a=>a.title==='Internet packet loss'),'stale data is unknown, not current loss');
});
test('loss and latency are measured; firmware compares numeric versions and requires update flag',()=>{
 assert.ok(routerSnapshot('r',output().replace('|2.4|0','|75|87'),epoch*1000).attention.some(a=>a.title==='Internet packet loss'));
 for(const text of [output().replace('webs_state_flag=1','webs_state_flag=0'),output().replace('3006_102_9_0','3006_102_7_1')])assert.ok(!routerSnapshot('r',text,epoch*1000).attention.some(a=>a.severity==='notice'));
 assert.equal(routerSnapshot('r',output().replace('3006_102_9_0','3006_102_10_0'),epoch*1000).router?.firmwareAvailable,'3006.102.10_0');
});
test('unknown optional data never appears healthy; malformed or oversized framing fails',()=>{
 const s=routerSnapshot('r',output().replace('connmon='+`${epoch-60}|2.4|0`,'connmon=').replace('radio0=1','radio0=').replace('watchdog_count=0','watchdog_count='),epoch*1000);
 for(const title of ['connmon unavailable','Wi-Fi radio state unknown','Syslog unavailable'])assert.ok(s.attention.some(a=>a.title===title),title);
 for(const bad of ['',output().replace('host-monitor-router-end',''),output()+'token=secret\n',output().replace('uptime=62940','uptime=NaN'),output().replace('wan_state=2','wan_state=2\nwan_state=0')])assert.throws(()=>routerSnapshot('r',bad,epoch*1000),/invalid-router/);
});
test('router uses a fixed SSH command and rejects mixed collection configuration',async()=>{
 const calls:Array<[string,string[]]>=[];const m=createMonitor({hosts:[{name:'appliance',ssh:'appliance',router:true,sshConfig:'/etc/router.conf'}]} as any,{releaseFetch:async()=>Response.json({tag_name:'v0.107.79',draft:false,prerelease:false}),now:()=>epoch*1000,run:async(f,a)=>{calls.push([f,a]);return {stdout:output()};}});await m.refresh();
 assert.equal(calls[0][0],'ssh');assert.equal(calls[0][1].at(-1),ROUTER_COMMAND);
 for(const extra of [{node:'/n'},{agentless:true},{adb:{serial:'x'}},{logUnits:[]},{router:'yes'},{bestEffort:true}])assert.throws(()=>createMonitor({hosts:[{name:'r',ssh:'r',router:true,sshConfig:'/etc/router.conf',...extra}]} as any),/invalid-hosts/);
});

test('firmware notices use the existing relay as informational messages',async()=>{
 const bodies:any[]=[];const n=createNotifier({url:'http://127.0.0.1:8000/notify',fetchImpl:async(_u,init)=>{bodies.push(JSON.parse(init.body as string));return new Response('ok');}});
 n.submit([{at:new Date(epoch*1000).toISOString(),host:'appliance',type:'attention',kind:'probe',title:'Merlin firmware update',severity:'notice'}],epoch*1000);await n.idle();assert.equal(bodies[0].type,'info');
});
test('a router uses its dedicated SSH config without falling back to another identity',async()=>{
 const calls:string[][]=[];const m=createMonitor({hosts:[{name:'r',ssh:'r',router:true,sshConfig:'/private/router.conf'}]} as any,{releaseFetch:async()=>Response.json({tag_name:'v0.107.79',draft:false,prerelease:false}),now:()=>epoch*1000,run:async(_f,a)=>{calls.push(a);return {stdout:output()};}});await m.refresh();assert.deepEqual(calls[0].slice(0,2),['-F','/private/router.conf']);
 assert.throws(()=>createMonitor({hosts:[{name:'r',ssh:'r',router:true,sshConfig:'relative.conf'}]} as any),/invalid-hosts/);
});
test('an already available firmware release notifies once after grace instead of becoming a silent baseline',async()=>{
 const {createTracker}=await import('../src/alerts.ts');const notice=routerSnapshot('r',output(),epoch*1000).attention[0];const t=createTracker({graceMs:90000});
 assert.deepEqual(t.online('r',[notice],epoch*1000),[]);assert.equal(t.online('r',[notice],epoch*1000+90000)[0]?.severity,'notice');assert.deepEqual(t.online('r',[notice],epoch*1000+180000),[]);
 const restored=createTracker({state:t.snapshot(),graceMs:90000});assert.deepEqual(restored.online('r',[notice],epoch*1000+240000),[]);
});

test('the first router firmware notice reaches the relay, and a later version is a distinct notice',async()=>{
 const bodies:any[]=[];let wire=output();const m=createMonitor({alerts:{webhookUrl:'http://127.0.0.1:8000/notify',graceSeconds:0},hosts:[{name:'r',ssh:'r',router:true,sshConfig:'/etc/router.conf'}]},{releaseFetch:async()=>Response.json({tag_name:'v0.107.79',draft:false,prerelease:false}),now:()=>epoch*1000,run:async()=>({stdout:wire}),fetch:async(_u,init)=>{bodies.push(JSON.parse(init.body as string));return new Response('ok');}});
 await m.refresh();await m.idle();assert.equal(bodies.length,1);assert.equal(bodies[0].type,'info');await m.refresh();await m.idle();assert.equal(bodies.length,1);
 wire=wire.replace('3006_102_9_0','3006_102_10_0');await m.refresh();await m.idle();assert.ok(bodies.some(b=>b.type==='info'&&b.body.includes('3006.102.10_0')));
});

test('AdGuard health distinguishes DNS failure, blocking failure and excessive query logs',()=>{
 const wire=output();
 const healthy=routerSnapshot('r',wire,epoch*1000);assert.equal((healthy.router as any).adguard.versionInstalled,'0.107.79');
 for(const [field,title,severity] of [['agh_dns','AdGuard DNS resolution failed','error'],['agh_blocked','AdGuard ad blocking failed','warning'],['agh_process','AdGuard process stopped','error'],['agh_listener','AdGuard DNS listener missing','error']]){
  const s=routerSnapshot('r',wire.replace(field+'=1',field+'=0'),epoch*1000);assert.ok(s.attention.some(a=>a.title===title&&a.severity===severity));
 }
 assert.ok(routerSnapshot('r',wire.replace('agh_querylog_bytes=4096','agh_querylog_bytes=4294967296'),epoch*1000).attention.some(a=>a.title==='AdGuard query log size'));
});

test('latest stable AdGuard release is cached and reaches the informational alert path',async()=>{
 let calls=0;const bodies:any[]=[];const m=createMonitor({alerts:{webhookUrl:'http://127.0.0.1:8000/notify',graceSeconds:0},hosts:[{name:'r',ssh:'r',router:true,sshConfig:'/etc/router.conf'}]},
 {now:()=>epoch*1000,run:async()=>({stdout:output().replace('webs_state_flag=1','webs_state_flag=0').replace('agh_version=0.107.79','agh_version=0.107.77')}),
 releaseFetch:async(url:URL,init:RequestInit)=>{calls++;assert.equal(String(url),'https://api.github.com/repos/AdguardTeam/AdGuardHome/releases/latest');assert.equal(init.credentials,'omit');return Response.json({tag_name:'v0.107.79',draft:false,prerelease:false});},
 fetch:async(_u:URL,init:RequestInit)=>{bodies.push(JSON.parse(init.body as string));return new Response('ok');}} as any);
 await m.refresh();await m.idle();await m.refresh();await m.idle();assert.equal(calls,1);assert.ok(bodies.some(b=>b.type==='info'&&b.body.includes('AdGuard update 0.107.79')));m.stop();
});

test('AdGuard release checks reject unavailable, oversized and non-stable releases; cache expires',async()=>{
 for(const response of [new Response('unavailable',{status:503}),new Response('x'.repeat(65537)),Response.json({tag_name:'v0.107.80-beta',draft:false,prerelease:true}),Response.json({tag_name:'v0.107.80',draft:true,prerelease:false}),new Response('invalid JSON')]){
  const check=createAdGuardReleaseCheck({fetchImpl:async()=>response});assert.equal(await check.read(),null);
 }
 let clock=1,calls=0;const check=createAdGuardReleaseCheck({now:()=>clock,fetchImpl:async()=>{calls++;if(calls===1)throw Error('unavailable');return Response.json({tag_name:'v0.107.79',draft:false,prerelease:false});}});
 assert.deepEqual(await Promise.all([check.read(),check.read()]),[null,null]);assert.equal(calls,1);assert.equal(await check.read(),null);
 clock+=6*3600*1000;assert.equal(await check.read(),'0.107.79');assert.equal(calls,2);
 const s=routerSnapshot('r',output().replace('agh_dns=1','agh_dns=0'),epoch*1000,null);assert.equal(s.router?.adguard.versionAvailable,null);assert.ok(s.attention.some(a=>a.title==='AdGuard DNS resolution failed'&&a.severity==='error'));assert.ok(s.attention.some(a=>a.title==='AdGuard release check unavailable'));
});

test('an upstream release failure leaves the router online and DNS failure visible',async()=>{
 const m=createMonitor({hosts:[{name:'r',ssh:'r',router:true,sshConfig:'/etc/router.conf'}]},
 {now:()=>epoch*1000,run:async()=>({stdout:output().replace('agh_dns=1','agh_dns=0')}),releaseFetch:async()=>{throw Error('release unavailable');}});
 m.server.listen(0,'127.0.0.1');await once(m.server,'listening');
 try{await m.refresh();const port=(m.server.address() as import('node:net').AddressInfo).port;const fleet=await(await fetch('http://127.0.0.1:'+port+'/api/fleet')).json() as any;
 assert.equal(fleet.hosts[0].status,'online');assert.equal(fleet.hosts[0].snapshot.router.adguard.dns,false);assert.ok(fleet.hosts[0].snapshot.attention.some((a:any)=>a.title==='AdGuard release check unavailable'));
 }finally{m.stop();await new Promise<void>(r=>m.server.close(()=>r()));}
});

test('AdGuard DNS failure present on initial router activation alerts once after grace',async()=>{
 let clock=epoch*1000;const bodies:any[]=[];
 const m=createMonitor({alerts:{webhookUrl:'http://127.0.0.1:8000/notify',graceSeconds:90},hosts:[{name:'r',ssh:'r',router:true,sshConfig:'/etc/router.conf'}]},
 {now:()=>clock,run:async()=>({stdout:output().replace('agh_dns=1','agh_dns=0').replace('webs_state_flag=1','webs_state_flag=0')}),releaseFetch:async()=>Response.json({tag_name:'v0.107.79',draft:false,prerelease:false}),
 fetch:async(_u,init)=>{bodies.push(JSON.parse(init.body as string));return new Response('ok');}});
 await m.refresh();await m.idle();assert.equal(bodies.length,0);clock+=90000;await m.refresh();await m.idle();
 assert.equal(bodies.length,1);assert.equal(bodies[0].type,'failure');assert.ok(bodies[0].body.includes('AdGuard DNS resolution failed'));
 await m.refresh();await m.idle();assert.equal(bodies.length,1);m.stop();
});
