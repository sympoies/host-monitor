import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {classifyJob,collectJobs,jobAttention,projectJobs,nativeJobState} from '../src/jobs.ts';
import {createTracker,DEFAULT_ALERT_KINDS} from '../src/alerts.ts';
import type {JobExpectation} from '../src/jobs.ts';
const at=Date.parse('2026-01-02T12:00:00Z'), timestamp=(delta=0)=>new Date(at+delta*1000).toISOString();
const job:JobExpectation={id:'job-a',label:'job-a',deadlineSeconds:45,lastSuccessSlaSeconds:120,staleAfterSeconds:180,registryRevision:'a'.repeat(40),sourceRevision:'b'.repeat(40),runtimeRevision:'sha256:'+'c'.repeat(64),entrypointRevision:'sha256:'+'d'.repeat(64)};
const snapshot=(extra:Record<string,unknown>={})=>({schema_version:'host-jobs.status.v1',job_id:'job-a',host:'collector-a',registry_revision:job.registryRevision,source_revision:job.sourceRevision,runtime_revision:job.runtimeRevision,entrypoint_revision:job.entrypointRevision,started_at_utc:timestamp(-10),finished_at_utc:timestamp(-1),updated_at_utc:timestamp(),last_success_utc:timestamp(-1),duration_seconds:9,outcome:'success',reason_code:'success',retry_count:0,retry_budget:1,deadline_seconds:45,next_due_utc:timestamp(50),pending_delivery_count:0,last_failure:null,retry_day_utc:'2026-01-02',retry_day_count:0,status_age_seconds:0,recovery_confirmed:false,lease_identity:{id:'00000000-0000-0000-0000-000000000000',pid:1,process_group:2,started_at_utc:timestamp(-10)},...extra});
test('scheduled status differentiates idle success, unknown, SLA, freshness, deadline and uncertainty',()=>{
 assert.equal(classifyJob(snapshot(),job,'collector-a',at).status,'healthy');
 assert.equal(classifyJob(null,job,'collector-a',at).status,'unknown');
 for(const [extra,reason] of [[{updated_at_utc:timestamp(-181)},'snapshot_stale'],[{last_success_utc:timestamp(-121)},'last_success_sla'],[{outcome:'running',reason_code:'running',started_at_utc:timestamp(-46)},'running_past_deadline'],[{outcome:'timeout_uncertain',reason_code:'process_group_unreaped'},'timeout_uncertain'],[{runtime_revision:'sha256:'+'0'.repeat(64)},'revision_drift'],[{host:'other'},'snapshot_invalid'],[{last_success_utc:null},'last_success_unknown']] as const){
  const result=classifyJob(snapshot(extra),job,'collector-a',at);assert.notEqual(result.status,'healthy');assert.equal(result.reasonCode,reason);
 }
 const skipped=classifyJob(snapshot({outcome:'skipped_window',reason_code:'skipped_window'}),job,'collector-a',at);assert.equal(skipped.status,'healthy');
});
test('snapshot projection excludes arbitrary output, args, paths, and reasons',()=>{
 const value=classifyJob(snapshot({raw_output:'PRIVATE_CANARY',argv:['PRIVATE_CANARY'],reason_code:'PRIVATE_CANARY'}),job,'collector-a',at);
 assert.equal(value.status,'unknown');assert.doesNotMatch(JSON.stringify(value),/PRIVATE_CANARY/);
 const projected=projectJobs({status:'ok',items:[{...classifyJob(snapshot(),job,'collector-a',at),raw_output:'PRIVATE_CANARY'}]});
 assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_CANARY/);
});
test('collector reads only configured bounded regular files and never runs a job',async()=>{
 const dir=await fs.mkdtemp(path.join(os.homedir(),'.scheduled-status-'));
 try{
  const file=path.join(dir,'job-a.json');await fs.writeFile(file,JSON.stringify(snapshot()));
  const before=(await fs.stat(file)).mtimeMs;
  let nativeCalls=0;
  const result=await collectJobs({statusDir:dir,entries:[job]},'collector-a',{now:at,native:async()=>{nativeCalls++;return 'ready';}});
  assert.equal(result?.items[0].status,'healthy');assert.equal(nativeCalls,1);assert.equal((await fs.stat(file)).mtimeMs,before);
  await fs.writeFile(file,'x'.repeat(16385));assert.equal((await collectJobs({statusDir:dir,entries:[job]},'collector-a',{now:at}))?.items[0].status,'unknown');
  await fs.unlink(file);await fs.symlink(path.join(dir,'missing'),file);assert.equal((await collectJobs({statusDir:dir,entries:[job]},'collector-a',{now:at}))?.items[0].status,'unknown');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('collector timeout and disabled native trigger are unknown/unhealthy, not green',async()=>{
 const config={statusDir:os.tmpdir(),entries:[job]};
 const timed=await collectJobs(config,'collector-a',{now:at,timeoutMs:20,read:async()=>new Promise(()=>{})});
 assert.equal(timed?.items[0].reasonCode,'snapshot_unreadable');
 const disabled=await collectJobs(config,'collector-a',{now:at,read:async()=>snapshot(),native:async()=> 'disabled'});
 assert.equal(disabled?.items[0].reasonCode,'native_disabled');
});
test('job transitions alert once, on changed reason/revision, and recover',()=>{
 assert.ok(DEFAULT_ALERT_KINDS.includes('job'));
 const tracker=createTracker({graceMs:0,restartLoop:{restarts:0,windowMs:60000}});
 const bad=classifyJob(snapshot({outcome:'timeout_uncertain',reason_code:'process_group_unreaped'}),job,'collector-a',at);
 assert.equal(tracker.online('collector-a',jobAttention({status:'ok',items:[bad]}),at).filter(e=>e.type==='attention').length,1,'uncertainty on first activation must alert');
 assert.equal(tracker.online('collector-a',jobAttention({status:'ok',items:[bad]}),at+1).length,0);
 const changed={...bad,reasonCode:'last_success_sla'};
 const events=tracker.online('collector-a',jobAttention({status:'ok',items:[changed]}),at+2);assert.equal(events.filter(e=>e.type==='attention').length,1);assert.equal(events.filter(e=>e.type==='recovered').length,0,'changed unhealthy reason is not recovery');
 assert.equal(tracker.online('collector-a',[],at+3).filter(e=>e.type==='recovered').length,1);
});

test('malformed and inconsistent inventories cannot become silently healthy',()=>{
 assert.throws(()=>projectJobs({status:'ok',items:'bad'}),/invalid-job-inventory/);
 assert.throws(()=>projectJobs({status:'ok',items:[classifyJob(null,job,'collector-a',at)]}),/inconsistent-job-inventory/);
 const record=snapshot();delete (record as Record<string,unknown>).lease_identity;
 assert.equal(classifyJob(record,job,'collector-a',at).status,'unknown');
});

test('native adapters require the configured enabled trigger without treating idle as failed',async()=>{
 const service={name:'job-a',scope:'user',health:'inactive' as const,manager:'launchd',installed:'loaded',active:'inactive',triggers:'interval'};
 assert.equal(await nativeJobState(job,'darwin',[service],async()=>{throw Error('unexpected command');}),'ready');
 assert.equal(await nativeJobState(job,'darwin',[{...service,triggers:''}],async()=>''),'disabled');
 assert.equal(await nativeJobState(job,'darwin',[],async()=>''),'missing');
 const linux={...service,name:'job-a.service',manager:'systemd'};
 const calls:string[][]=[];
 assert.equal(await nativeJobState(job,'linux',[linux],async(bin,args)=>{assert.equal(bin,'systemctl');calls.push(args);return 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n';}),'ready');
 assert.deepEqual(calls[0],['--user','show','--property=LoadState,UnitFileState,ActiveState','--','job-a.timer']);
});

test('expired reads cannot begin native work, and native work receives cancellation',async()=>{
 const config={statusDir:os.tmpdir(),entries:[job]};let nativeCalls=0;
 await collectJobs(config,'collector-a',{now:at,timeoutMs:10,read:async()=>{await new Promise(resolve=>setTimeout(resolve,40));return snapshot();},native:async()=>{nativeCalls++;return 'ready';}});
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(nativeCalls,0);
 let cancelled=false;
 await collectJobs(config,'collector-a',{now:at,timeoutMs:10,read:async()=>snapshot(),native:async(_,signal)=>new Promise(resolve=>{signal.addEventListener('abort',()=>{cancelled=true;resolve('unknown');},{once:true});})});
 assert.equal(cancelled,true);
});

test('filesystem helper timeout kills and reaps a pending reader',async()=>{
 const {readJobInventory}=await import('../src/jobs.ts');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'scheduled-reader-'));
 try{
  const pidFile=path.join(dir,'pid'),previous=process.env.JOB_READER_PID_FILE;
  process.env.JOB_READER_PID_FILE=pidFile;
  try{
   const result=await readJobInventory({statusDir:dir,entries:[job]},'collector-a',at,300,new URL('./fixtures/job-reader-pending.mjs',import.meta.url));
   assert.equal(result.items[0].reasonCode,'snapshot_unreadable');
   const pid=Number(await fs.readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }finally{if(previous===undefined)delete process.env.JOB_READER_PID_FILE;else process.env.JOB_READER_PID_FILE=previous;}

 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('server rejects contradictory healthy job reasons; native read failures stay unknown',async()=>{
 for(const reasonCode of ['timeout_uncertain','native_missing','snapshot_missing'])assert.throws(()=>projectJobs({status:'ok',items:[{...classifyJob(snapshot(),job,'collector-a',at),reasonCode}]}),/inconsistent-job-health/);
 assert.equal(await nativeJobState(job,'linux',[],async()=>'',false),'unknown');
 const service={name:'job-a',scope:'user',health:'inactive' as const,manager:'launchd',installed:'loaded',active:'inactive',triggers:'unknown'};
 assert.equal(await nativeJobState(job,'darwin',[service],async()=>''),'unknown');
});

test('a retained helper pipe cannot hold the collector event loop after the reap fallback',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'scheduled-pipe-'));let descendant=0;
 try{
  const pidFile=path.join(dir,'descendant'),inputFile=path.join(dir,'input.json');
  await fs.writeFile(inputFile,JSON.stringify({config:{statusDir:dir,entries:[job]},host:'collector-a',now:at,timeoutMs:300,helper:new URL('./fixtures/job-reader-retained-pipe.mjs',import.meta.url).href}));
  try{
   await exec(process.execPath,[new URL('./fixtures/job-reader-collector.mjs',import.meta.url).pathname,inputFile],{timeout:1500,env:{...process.env,JOB_READER_PID_FILE:pidFile}});
  }finally{descendant=Number(await fs.readFile(pidFile,'utf8').catch(()=> '0'));}
 }finally{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await fs.rm(dir,{recursive:true,force:true});}
});

test('contradictory failure reasons invalidate only the affected job',async()=>{
 const dir=await fs.mkdtemp(path.join(os.homedir(),'.scheduled-isolation-'));
 const other={...job,id:'job-b',label:'job-b'};
 try{
  await fs.writeFile(path.join(dir,'job-b.json'),JSON.stringify(snapshot({job_id:'job-b'})));
  for(const [outcome,reason_code] of [['delivery_pending','success'],['timeout','success'],['auth_required','running'],['success','auth_required'],['skipped_window','permission_required'],['running','auth_required']]){
   await fs.writeFile(path.join(dir,'job-a.json'),JSON.stringify(snapshot({outcome,reason_code})));
   const result=await collectJobs({statusDir:dir,entries:[job,other]},'collector-a',{now:at});
   assert.equal(result?.items[0].reasonCode,'snapshot_invalid');assert.equal(result?.items[1].status,'healthy');
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('collect wires scheduled launchd jobs and keeps failed native reads unknown; API recomputes attention',async()=>{
 const {collect}=await import('../src/collector.ts');const {projectSnapshot}=await import('../src/schema.ts');
 const dir=await fs.mkdtemp(path.join(os.homedir(),'.scheduled-collect-'));
 const expected={...job,label:'com.example.sync'};let failDetail=false,failInventory=false;
 const fixture=async(name:string)=>fs.readFile(new URL('./fixtures/darwin/'+name,import.meta.url),'utf8');
 const run=async(bin:string,args:string[])=>{
  if(bin!=='launchctl')throw Error('unavailable');
  if(args[1]==='system')return fixture('launchctl-print-system.txt');
  if(args[1]==='gui/501'||args[1]==='user/501'){if(failInventory)throw Error('unavailable');return fixture('launchctl-print-gui.txt');}
  if(args[1].endsWith('/com.example.sync')){if(failDetail)throw Error('unavailable');return fixture('launchctl-print-sync.txt');}
  throw Error('unexpected native command');
 };
 try{
  const current=Date.now();await fs.writeFile(path.join(dir,'job-a.json'),JSON.stringify(snapshot({started_at_utc:new Date(current-10000).toISOString(),finished_at_utc:new Date(current-1000).toISOString(),updated_at_utc:new Date(current).toISOString(),last_success_utc:new Date(current-1000).toISOString(),next_due_utc:new Date(current+50000).toISOString()})));
  const config={name:'collector-a',jobs:{statusDir:dir,entries:[expected]}};
  const options={platform:'darwin' as const,hostname:'collector-a',uid:501,run,stream:async()=>{}};
  const healthy=await collect(config,options);assert.equal(healthy.jobs?.items[0].status,'healthy');assert.equal(healthy.attention.some(item=>item.kind==='job'),false);
  failDetail=true;const detail=await collect(config,options);assert.equal(detail.jobs?.items[0].reasonCode,'native_unknown');assert.equal(detail.attention.filter(item=>item.kind==='job').length,1);
  failDetail=false;failInventory=true;const inventory=await collect(config,options);assert.equal(inventory.jobs?.items[0].reasonCode,'native_unknown');
  const projected=projectSnapshot({...detail,attention:[]});assert.equal(projected.attention.filter(item=>item.kind==='job').length,1,'caller cannot suppress job attention');
  const repaired=projectSnapshot({...healthy,attention:detail.attention});assert.equal(repaired.attention.some(item=>item.kind==='job'),false,'caller cannot forge stale job attention');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
