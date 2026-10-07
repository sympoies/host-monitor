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
 for(const [extra,reason] of [[{updated_at_utc:timestamp(-181)},'snapshot_stale'],[{last_success_utc:timestamp(-121)},'last_success_sla'],[{outcome:'running',started_at_utc:timestamp(-46)},'running_past_deadline'],[{outcome:'timeout_uncertain',reason_code:'process_group_unreaped'},'timeout_uncertain'],[{runtime_revision:'sha256:'+'0'.repeat(64)},'revision_drift'],[{host:'other'},'snapshot_invalid'],[{last_success_utc:null},'last_success_unknown']] as const){
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
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'scheduled-status-'));
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
  const script=path.join(dir,'pending.mjs'),pidFile=path.join(dir,'pid');
  await fs.writeFile(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const result=await readJobInventory({statusDir:dir,entries:[job]},'collector-a',at,200,new URL('file://'+script));
  assert.equal(result.items[0].reasonCode,'snapshot_unreadable');
  const pid=Number(await fs.readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
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
  const helper=path.join(dir,'helper.mjs'),pidFile=path.join(dir,'descendant'),collector=path.join(dir,'collector.mjs');
  await fs.writeFile(helper,`import {spawn} from 'node:child_process';import fs from 'node:fs';const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,'ignore']});fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},1000);`);
  await fs.writeFile(collector,`import {readJobInventory} from ${JSON.stringify(new URL('../src/jobs.ts',import.meta.url).href)};await readJobInventory(${JSON.stringify({statusDir:dir,entries:[job]})},'collector-a',${at},300,new URL(${JSON.stringify(new URL('file://'+helper).href)}));`);
  await exec(process.execPath,[collector],{timeout:1500});
  descendant=Number(await fs.readFile(pidFile,'utf8'));
 }finally{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await fs.rm(dir,{recursive:true,force:true});}
});
