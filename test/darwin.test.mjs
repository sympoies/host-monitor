import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {parseLaunchdServices,parseLaunchdJob,classifyLaunchdJob,hostIdentityMatches} from '../src/model.mjs';
import {collectLaunchd,launchdLogErrors,collect,streamLines} from '../src/collector.mjs';
import {projectSnapshot} from '../src/schema.mjs';
// Fixtures are recorded macOS 26 `launchctl print` and `log show --style ndjson` output with labels, paths and messages replaced.
const fixture=name=>fs.readFileSync(path.join(import.meta.dirname,'fixtures/darwin',name),'utf8');
const details={'com.example.tunnel':'launchctl-print-tunnel.txt','com.example.sync':'launchctl-print-sync.txt','com.example.broken':'launchctl-print-broken.txt','com.example.stopped':'launchctl-print-stopped.txt','org.example.daemon':'launchctl-print-daemon.txt'};
function launchctl({guiDomain=true}={}){const calls=[];const run=async(bin,args)=>{calls.push([bin,...args].join(' '));assert.equal(bin,'launchctl');assert.equal(args[0],'print');const target=args[1];
 if(target==='gui/501'){if(!guiDomain)throw Error('Domain does not support specified action');return fixture('launchctl-print-gui.txt');}
 if(target==='user/501')return fixture('launchctl-print-gui.txt').replace('gui/501 = {','user/501 = {');
 if(target==='system')return fixture('launchctl-print-system.txt');
 const label=target.split('/').pop();if(details[label])return fixture(details[label]);throw Object.assign(Error('Command failed'),{code:113,stderr:fixture('launchctl-print-missing.txt')});};return {run,calls};}
const requiredUser=['com.example.tunnel','com.example.sync','com.example.broken','com.example.stopped','com.example.missing'];
const canary=/private-canary|\/Users\//;

test('launchctl domain inventory keeps pid and last exit status per label and ignores other blocks',()=>{
 const rows=parseLaunchdServices(fixture('launchctl-print-gui.txt'));
 assert.equal(rows.length,9);
 assert.deepEqual(rows.find(r=>r.label==='com.example.tunnel'),{label:'com.example.tunnel',pid:72425,status:null,exitReason:false});
 assert.deepEqual(rows.find(r=>r.label==='com.example.broken'),{label:'com.example.broken',pid:0,status:78,exitReason:false});
 assert.deepEqual(rows.find(r=>r.label==='com.example.stopped'),{label:'com.example.stopped',pid:0,status:-15,exitReason:false});
 assert.deepEqual(rows.find(r=>r.label==='com.apple.progressd'),{label:'com.apple.progressd',pid:0,status:null,exitReason:true});
 assert.equal(rows.some(r=>r.label.includes('disabled')||r.label.includes('unmanaged')),false);
});
test('launchctl job detail reads only allowlisted top-level fields and never environment or arguments',()=>{
 const job=parseLaunchdJob(fixture('launchctl-print-tunnel.txt'));
 assert.deepEqual(job,{type:'LaunchAgent',state:'running',process:'ssh',pid:72425,runs:509,exitCode:255,signal:null,periodic:false});
 assert.equal(canary.test(JSON.stringify(job)),false);
 assert.deepEqual(parseLaunchdJob(fixture('launchctl-print-broken.txt')),{type:'LaunchAgent',state:'spawn scheduled',process:'ExampleDaemon',pid:null,runs:1,exitCode:78,signal:null,periodic:false});
 assert.equal(parseLaunchdJob(fixture('launchctl-print-stopped.txt')).signal,15);
 assert.equal(parseLaunchdJob(fixture('launchctl-print-sync.txt')).periodic,true);
 assert.equal(parseLaunchdJob(fixture('launchctl-print-daemon.txt')).exitCode,null);
});
test('launchd health follows the systemd rules: only required jobs that stop or exit non-zero need attention',()=>{
 const job=(o)=>({state:'not running',exitCode:null,signal:null,periodic:false,installed:'loaded',...o});
 assert.equal(classifyLaunchdJob(job({state:'running',exitCode:255}),true),'ok');
 assert.equal(classifyLaunchdJob(job({exitCode:0,periodic:true}),true),'idle');
 assert.equal(classifyLaunchdJob(job({exitCode:0}),true),'error');
 assert.equal(classifyLaunchdJob(job({state:'spawn scheduled',exitCode:78}),true),'error');
 assert.equal(classifyLaunchdJob(job({signal:15}),true),'error');
 assert.equal(classifyLaunchdJob(job({installed:'missing'}),true),'error');
 assert.equal(classifyLaunchdJob(job({state:'spawn scheduled',exitCode:0}),true),'transition');
 assert.equal(classifyLaunchdJob(job({exitCode:1}),false),'inactive');
 assert.equal(classifyLaunchdJob(job({signal:9}),false),'inactive');
 assert.equal(classifyLaunchdJob(job({exitCode:0}),false),'idle');
 assert.equal(classifyLaunchdJob(job({}),false),'inactive');
});
test('user agents come from the gui domain with detail only for required labels',async()=>{
 const {run,calls}=launchctl();const {services,logTargets}=await collectLaunchd('user',requiredUser,{uid:501,run});
 const by=Object.fromEntries(services.map(s=>[s.name,s]));
 assert.equal(services.length,10);
 assert.deepEqual([by['com.example.tunnel'].health,by['com.example.sync'].health,by['com.example.broken'].health,by['com.example.stopped'].health,by['com.example.missing'].health],['ok','idle','error','error','error']);
 assert.deepEqual([by['com.example.optional-helper'].health,by['com.apple.progressd'].health,by['io.tailscale.ipn.macsys.login-item-helper'].health,by['application.com.example.Editor.410592500.410592506'].health],['inactive','inactive','idle','ok']);
 assert.equal(by['com.example.broken'].result,'exit-code');assert.equal(by['com.example.broken'].exitCode,78);assert.equal(by['com.example.stopped'].result,'signal');
 assert.equal(by['com.example.missing'].installed,'missing');assert.equal(by['com.example.tunnel'].manager,'launchd');assert.equal(by['com.example.tunnel'].scope,'user');assert.equal(by['com.example.tunnel'].type,'LaunchAgent');
 assert.ok(services.every(s=>s.required===requiredUser.includes(s.name)));
 assert.equal(calls.length,1+requiredUser.length);assert.ok(calls.every(c=>/^launchctl print gui\/501(\/com\.example\.[a-z-]+)?$/.test(c)));
 assert.deepEqual(logTargets,[{label:'com.example.tunnel',scope:'user',process:'ssh'},{label:'com.example.sync',scope:'user',process:'sync-job'},{label:'com.example.broken',scope:'user',process:'ExampleDaemon'},{label:'com.example.stopped',scope:'user',process:'Example'}]);
 assert.equal(canary.test(JSON.stringify(services)),false);
});
test('system daemons are read from the system domain without privileges and fall back to the user domain for agents',async()=>{
 let {run,calls}=launchctl();const system=await collectLaunchd('system',['org.example.daemon'],{uid:501,run});
 assert.equal(system.services.find(s=>s.name==='org.example.daemon').health,'ok');assert.equal(system.services.find(s=>s.name==='org.example.daemon').type,'LaunchDaemon');assert.deepEqual(calls,['launchctl print system','launchctl print system/org.example.daemon']);
 ({run,calls}=launchctl({guiDomain:false}));const user=await collectLaunchd('user',['com.example.tunnel'],{uid:501,run});
 assert.equal(user.services.find(s=>s.name==='com.example.tunnel').health,'ok');assert.deepEqual(calls,['launchctl print gui/501','launchctl print user/501','launchctl print user/501/com.example.tunnel']);
});
test('log errors are counted per required job process and message text never leaves the collector',async()=>{
 const seen=[];const stream=async(bin,args,onLine)=>{seen.push([bin,...args]);for(const line of fixture('log-show-errors.ndjson').split('\n'))onLine(line);};
 const rows=await launchdLogErrors([{label:'com.example.tunnel',scope:'user',process:'ssh'},{label:'org.example.daemon',scope:'system',process:'example-daemon'},{label:'com.example.quiet',scope:'user',process:'quiet'},{label:'com.example.bad',scope:'user',process:'x" OR 1==1'}],{uid:501,stream});
 assert.deepEqual(rows,[{unit:'com.example.tunnel',scope:'user',process:'ssh',count:2,lastAt:'2026-09-28T12:11:50.414Z'},{unit:'org.example.daemon',scope:'system',process:'example-daemon',count:1,lastAt:'2026-09-28T11:30:00.000Z'}]);
 assert.equal(seen.length,1);const [bin,...args]=seen[0];assert.equal(bin,'/usr/bin/log');
 assert.deepEqual(args.slice(0,3),['show','--last','1h']);assert.ok(args.includes('ndjson'));
 const predicate=args[args.indexOf('--predicate')+1];assert.equal(predicate,'messageType == error AND (process == "ssh" OR process == "example-daemon" OR process == "quiet")');
 assert.equal(canary.test(JSON.stringify(rows)),false);
 assert.deepEqual(await launchdLogErrors([],{uid:501,stream:async()=>assert.fail('no query without targets')}),[]);
});
test('host identity compares short hostnames case-insensitively or an explicit identity',()=>{
 assert.equal(hostIdentityMatches('m4.local',{name:'m4'}),true);
 assert.equal(hostIdentityMatches('M4.LOCAL',{name:'m4'}),true);
 assert.equal(hostIdentityMatches('c8',{name:'c8'}),true);
 assert.equal(hostIdentityMatches('MacBook',{name:'m4'}),false);
 assert.equal(hostIdentityMatches('MacBook.local',{name:'m4',identity:'MacBook'}),true);
 assert.equal(hostIdentityMatches('m4',{name:'m4',identity:'MacBook'}),false);
 assert.equal(hostIdentityMatches('c8.example.com',{name:'c8'}),false);
});
test('a macOS snapshot reports launchd services, log counts and external resources without collection failures',async()=>{
 const {run,calls}=launchctl();const stream=async(_bin,_args,onLine)=>{for(const line of fixture('log-show-errors.ndjson').split('\n'))onLine(line);};
 const config={name:'m4',identity:'MacBook',required:{user:['com.example.tunnel','com.example.broken'],system:['org.example.daemon']}};
 const s=await collect(config,{platform:'darwin',hostname:'MacBook.local',uid:501,run,stream});
 assert.equal(s.schemaVersion,1);assert.equal(s.host,'m4');assert.equal(s.platform,'darwin');assert.equal(s.resources,'external');
 assert.deepEqual(s.collectionIssues,[]);assert.equal(s.memory,undefined);assert.equal(s.disks,undefined);assert.deepEqual(s.failedUnits,[]);
 assert.ok(calls.every(c=>c.startsWith('launchctl print ')));
 assert.deepEqual(s.attention.map(a=>[a.kind,a.title]),[['service','com.example.broken'],['journal','com.example.tunnel'],['journal','org.example.daemon']]);
 const projected=projectSnapshot(JSON.parse(JSON.stringify(s)));
 assert.equal(projected.platform,'darwin');assert.equal(projected.resources,'external');assert.equal(projected.services[0].manager,'launchd');assert.equal(projected.journalErrors[0].process,'ssh');
 assert.equal(canary.test(JSON.stringify(s)),false);
 await assert.rejects(collect({...config,identity:undefined},{platform:'darwin',hostname:'MacBook.local',uid:501,run,stream}),/host-identity-mismatch/);
});
test('streamed command output is delivered by line and bounded by time and line count',async()=>{
 const lines=[];await streamLines(process.execPath,['-e','process.stdout.write("a\\nb\\n");setTimeout(()=>process.stdout.write("c"),20)'],l=>lines.push(l));assert.deepEqual(lines,['a','b','c']);
 await assert.rejects(streamLines(process.execPath,['-e','setTimeout(()=>{},5000)'],()=>{},{timeout:100}),/command-timeout/);
 await assert.rejects(streamLines(process.execPath,['-e','for(let i=0;i<50;i++)console.log(i)'],()=>{},{maxLines:10}),/command-output-limit/);
 await assert.rejects(streamLines(process.execPath,['-e','process.exit(3)'],()=>{}),/command-failed/);
});
