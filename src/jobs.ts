// Scheduled-job snapshots are local, bounded metadata; collection never invokes an entrypoint.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Attention,Service} from './model.ts';
export interface JobExpectation{id:string;label:string;deadlineSeconds:number;lastSuccessSlaSeconds:number;staleAfterSeconds:number;registryRevision:string;sourceRevision:string;runtimeRevision:string;entrypointRevision:string}
export interface JobConfig{statusDir:string;entries:JobExpectation[]}
export interface JobStatus{id:string;label:string;status:'healthy'|'unhealthy'|'unknown';reasonCode:string;registryRevision:string;sourceRevision?:string;runtimeRevision?:string;entrypointRevision?:string;outcome?:string;startedAt?:string|null;finishedAt?:string|null;lastSuccess?:string|null;nextDue?:string|null;ageSeconds?:number;durationSeconds?:number;deadlineSeconds?:number;retryCount?:number;retryBudget?:number;pendingDeliveryCount?:number;lastFailure?:{outcome:string;reasonCode:string;at:string}|null}
export interface JobInventory{status:'ok'|'unknown';items:JobStatus[]}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9._-]{0,95}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40,64}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=32&&v.endsWith('Z')&&Number.isFinite(Date.parse(v));
const bounded=(v:unknown,max=2678400):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max;
const outcomes=new Set(['running','success','skipped_no_change','skipped_window','skipped_overlap','transient_network','config_ambiguous','auth_required','permission_required','invalid_input','timeout','timeout_uncertain','delivery_pending']);
const reasons=new Set([...outcomes,'started','unclassified_exit','entrypoint_failed','entrypoint_unavailable','whole_run_deadline','process_group_unreaped','previous_run_unreaped','supervisor_interrupted']);
const statusReasons=new Set([...reasons,'snapshot_missing','snapshot_invalid','snapshot_unreadable','snapshot_stale','snapshot_clock_invalid','last_success_unknown','last_success_sla','running_past_deadline','revision_drift','native_missing','native_disabled','native_unknown']);
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const forbidden=(value:string)=>value.startsWith('/Volumes/')||value==='/Volumes'||value.startsWith('/mnt/')||value.startsWith('/media/')||value.startsWith('/data/')||value.split(path.sep).some(part=>['Desktop','Documents','Downloads','CloudStorage','Mobile Documents'].includes(part));
export function validateJobConfig(value:JobConfig|undefined):void{
 if(value===undefined)return;
 if(!object(value)||Object.keys(value).some(k=>!['statusDir','entries'].includes(k))||typeof value.statusDir!=='string'||!path.isAbsolute(value.statusDir)||forbidden(value.statusDir)||!Array.isArray(value.entries)||value.entries.length>128)throw Error('invalid-job-config');
 const seen=new Set<string>();
 for(const job of value.entries){
  if(!object(job)||Object.keys(job).length!==9||!id(job.id)||!id(job.label)||seen.has(job.id)||!revision(job.registryRevision)||!revision(job.sourceRevision)||!digest(job.runtimeRevision)||!digest(job.entrypointRevision)||![job.deadlineSeconds,job.lastSuccessSlaSeconds,job.staleAfterSeconds].every(v=>bounded(v)&&v>0))throw Error('invalid-job-config');
  seen.add(job.id);
 }
}
const recordKeys=['schema_version','job_id','host','registry_revision','source_revision','runtime_revision','entrypoint_revision','started_at_utc','finished_at_utc','last_success_utc','updated_at_utc','duration_seconds','outcome','reason_code','retry_count','retry_budget','retry_day_utc','retry_day_count','next_due_utc','deadline_seconds','lease_identity','status_age_seconds','pending_delivery_count','last_failure','recovery_confirmed'];
function completeRecord(row:Record<string,unknown>):boolean{
 const lease=object(row.lease_identity),failure=object(row.last_failure);
 return Object.keys(row).length===recordKeys.length&&recordKeys.every(key=>Object.hasOwn(row,key))&&typeof row.recovery_confirmed==='boolean'&&typeof row.retry_day_utc==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.retry_day_utc)&&['retry_count','retry_budget','retry_day_count','pending_delivery_count'].every(key=>Number.isInteger(row[key])&&bounded(row[key],1000))&&bounded(row.status_age_seconds)&&!!lease&&Object.keys(lease).length===4&&typeof lease.id==='string'&&/^[a-f0-9-]{36}$/.test(lease.id)&&Number.isInteger(lease.pid)&&bounded(lease.pid,2**31)&&Number.isInteger(lease.process_group)&&bounded(lease.process_group,2**31)&&timestamp(lease.started_at_utc)&&(row.last_failure===null||!!failure&&Object.keys(failure).length===3&&typeof failure.outcome==='string'&&outcomes.has(failure.outcome)&&failure.outcome!=='running'&&typeof failure.reason_code==='string'&&reasons.has(failure.reason_code)&&timestamp(failure.at_utc));
}
const missing=(job:JobExpectation,reasonCode='snapshot_missing'):JobStatus=>({id:job.id,label:job.label,status:'unknown',reasonCode,registryRevision:job.registryRevision});
export function classifyJob(value:unknown,job:JobExpectation,host:string,now=Date.now()):JobStatus{
 if(value===null||value===undefined)return missing(job);
 const row=object(value);
 if(!row||!completeRecord(row)||row.schema_version!=='host-jobs.status.v1'||row.job_id!==job.id||row.host!==host||!revision(row.registry_revision)||!revision(row.source_revision)||!digest(row.runtime_revision)||!digest(row.entrypoint_revision)||typeof row.outcome!=='string'||!outcomes.has(row.outcome)||typeof row.reason_code!=='string'||!reasons.has(row.reason_code)||!timestamp(row.started_at_utc)||!timestamp(row.updated_at_utc)||![row.finished_at_utc,row.last_success_utc,row.next_due_utc].every(v=>v===null||timestamp(v))||![row.duration_seconds,row.deadline_seconds,row.retry_count,row.retry_budget,row.pending_delivery_count].every(v=>bounded(v)))return missing(job,'snapshot_invalid');
 const age=(now-Date.parse(row.updated_at_utc))/1000,started=(now-Date.parse(row.started_at_utc))/1000;
 let reason:string|undefined;
 if(row.outcome==='timeout_uncertain')reason='timeout_uncertain';
 else if(row.registry_revision!==job.registryRevision||row.source_revision!==job.sourceRevision||row.runtime_revision!==job.runtimeRevision||row.entrypoint_revision!==job.entrypointRevision)reason='revision_drift';
 else if(age< -5||started< -5||row.last_success_utc!==null&&Date.parse(row.last_success_utc as string)>now+5000)reason='snapshot_clock_invalid';
 else if(row.outcome==='running'&&started>job.deadlineSeconds)reason='running_past_deadline';
 else if(age>job.staleAfterSeconds)reason='snapshot_stale';
 else if(row.last_success_utc===null)reason='last_success_unknown';
 else if(row.last_success_utc!==null&&(now-Date.parse(row.last_success_utc as string))/1000>job.lastSuccessSlaSeconds)reason='last_success_sla';
 else if(!['running','success','skipped_no_change','skipped_window','skipped_overlap'].includes(row.outcome))reason=row.reason_code;
 const failure=object(row.last_failure),lastFailure=failure&&typeof failure.outcome==='string'&&outcomes.has(failure.outcome)&&failure.outcome!=='running'&&typeof failure.reason_code==='string'&&reasons.has(failure.reason_code)&&timestamp(failure.at_utc)?{outcome:failure.outcome,reasonCode:failure.reason_code,at:failure.at_utc}:null;
 return {id:job.id,label:job.label,status:reason?['revision_drift','snapshot_clock_invalid','snapshot_stale','last_success_unknown'].includes(reason)?'unknown':'unhealthy':'healthy',reasonCode:reason??row.outcome,registryRevision:row.registry_revision,sourceRevision:row.source_revision,runtimeRevision:row.runtime_revision,entrypointRevision:row.entrypoint_revision,outcome:row.outcome,startedAt:row.started_at_utc,finishedAt:row.finished_at_utc as string|null,lastSuccess:row.last_success_utc as string|null,nextDue:row.next_due_utc as string|null,ageSeconds:Math.max(0,age),durationSeconds:row.duration_seconds as number,deadlineSeconds:job.deadlineSeconds,retryCount:row.retry_count as number,retryBudget:row.retry_budget as number,pendingDeliveryCount:row.pending_delivery_count as number,lastFailure};
}
async function internalDirectory(value:string):Promise<string>{
 let resolved=path.parse(value).root,pending=value.slice(resolved.length).split(path.sep).filter(Boolean),links=0;
 while(pending.length){const part=pending.shift()!;if(part==='..'){resolved=path.dirname(resolved);continue;}const candidate=path.join(resolved,part);if(forbidden(candidate))throw Error('invalid-status-path');const info=await fs.lstat(candidate);if(info.isSymbolicLink()){if(++links>40)throw Error('invalid-status-path');const target=path.resolve(resolved,await fs.readlink(candidate));if(forbidden(target))throw Error('invalid-status-path');resolved=path.parse(target).root;pending=[...target.slice(resolved.length).split(path.sep).filter(Boolean),...pending];}else resolved=candidate;}
 return resolved;
}
export async function readRecord(dir:string,id:string):Promise<unknown>{
 const real=await internalDirectory(dir);if(forbidden(real))throw Error('invalid-status-path');
 const [root,home,system]=await Promise.all([fs.stat(real),fs.stat(os.homedir()),fs.stat(path.parse(real).root)]);
 if(root.dev!==home.dev&&root.dev!==system.dev)throw Error('invalid-status-filesystem');
 const file=await fs.open(path.join(real,id+'.json'),constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||info.size>16384)throw Error('invalid-status-file');const buffer=Buffer.alloc(16385);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>16384)throw Error('invalid-status-size');return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}finally{await file.close();}
}
export type NativeState='ready'|'missing'|'disabled'|'unknown';
export async function nativeJobState(job:JobExpectation,platform:string,services:Service[],run:(bin:string,args:string[])=>Promise<string>,inventoryKnown=true):Promise<NativeState>{
 if(!inventoryKnown)return 'unknown';
 const label=platform==='darwin'?job.label:job.label+'.service';
 const service=services.find(s=>s.scope==='user'&&s.name===label);
 if(!service||service.installed==='missing')return 'missing';
 if(platform==='darwin')return service.manager!=='launchd'||service.triggers==='unknown'?'unknown':service.triggers==='interval'?'ready':'disabled';
 try{
  const raw=await run('systemctl',['--user','show','--property=LoadState,UnitFileState,ActiveState','--',job.label+'.timer']);
  const props=Object.fromEntries(raw.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  if(props.LoadState==='not-found')return 'missing';
  if(props.LoadState!=='loaded')return 'unknown';
  return props.ActiveState==='active'&&['enabled','enabled-runtime','static'].includes(props.UnitFileState)?'ready':'disabled';
 }catch{return 'unknown';}
}
let reader:ChildProcess|undefined;
// A single killable process owns filesystem I/O. An unreaped reader prevents another launch.
export async function readJobInventory(config:JobConfig,host:string,now:number,timeoutMs:number,helper=new URL('./jobs-reader.ts',import.meta.url)):Promise<JobInventory>{
 const unavailable=():JobInventory=>({status:'unknown',items:config.entries.map(job=>missing(job,'snapshot_unreadable'))});
 if(reader)return unavailable();
 return await new Promise(resolve=>{
  const child=spawn(process.execPath,[fileURLToPath(helper)],{stdio:['pipe','pipe','ignore']});reader=child;
  let output='',settled=false,timedOut=false,fallback:ReturnType<typeof setTimeout>|undefined;
  const finish=(value:JobInventory)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(fallback);resolve(value);};
  const stop=()=>{timedOut=true;child.kill('SIGKILL');fallback=setTimeout(()=>{child.stdin?.destroy();child.stdout?.destroy();child.unref();finish(unavailable());},100);};
  const timer=setTimeout(stop,Math.max(1,timeoutMs));
  child.stdout!.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>262144)stop();});
  child.on('error',()=>finish(unavailable()));child.stdin!.on('error',()=>{});
  child.on('close',code=>{if(reader===child)reader=undefined;if(timedOut||code!==0)return finish(unavailable());try{finish(projectJobs(JSON.parse(output)));}catch{finish(unavailable());}});
  child.stdin!.end(JSON.stringify({config,host,now}));
 });
}
export async function collectJobs(config:JobConfig|undefined,host:string,{now=Date.now(),timeoutMs=2000,read,native}:{now?:number;timeoutMs?:number;read?:(dir:string,id:string)=>Promise<unknown>;native?:(job:JobExpectation,signal:AbortSignal)=>Promise<NativeState>}={}):Promise<JobInventory|undefined>{
 if(config===undefined)return undefined;
 validateJobConfig(config);
 if(config.entries.length===0)return {status:'ok',items:[]};
 const expires=performance.now()+timeoutMs;
 const base=read?undefined:await readJobInventory(config,host,now,timeoutMs);
 const items=await Promise.all(config.entries.map(async(job,index)=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const unavailable=()=>missing(job,'snapshot_unreadable');
  try{
   if(performance.now()>=expires)return unavailable();
   return await Promise.race([(async()=>{
    const status=read?classifyJob(await read(config.statusDir,job.id),job,host,now):base!.items[index];
    if(controller.signal.aborted)return unavailable();
    if(native&&status.reasonCode!=='snapshot_unreadable'){
     const state=await native(job,controller.signal);if(controller.signal.aborted)return unavailable();
     if(state!=='ready'&&status.reasonCode!=='timeout_uncertain')return {...status,status:state==='unknown'?'unknown' as const:'unhealthy' as const,reasonCode:'native_'+state};
    }
    return status;
   })(),new Promise<JobStatus>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable());},Math.max(1,expires-performance.now()));})]);
  }catch{return unavailable();}finally{clearTimeout(timer);controller.abort();}
 }));
 return {status:items.some(i=>i.status==='unknown')?'unknown':'ok',items};
}
// This projection is repeated at the server boundary; raw runner records never cross it.
export function projectJobs(value:unknown):JobInventory{
 const inventory=object(value);
 if(!inventory||!['ok','unknown'].includes(inventory.status as string)||!Array.isArray(inventory.items)||inventory.items.length>128)throw Error('invalid-job-inventory');
 const items:JobStatus[]=inventory.items.map((value:unknown)=>{
  const row=object(value);
  if(!row||!id(row.id)||!id(row.label)||!['healthy','unhealthy','unknown'].includes(row.status as string)||typeof row.reasonCode!=='string'||!statusReasons.has(row.reasonCode)||!revision(row.registryRevision))throw Error('invalid-job-snapshot');
  const healthyReasons=new Set(['running','success','skipped_no_change','skipped_window','skipped_overlap']);
  const unknownReasons=new Set(['revision_drift','snapshot_clock_invalid','snapshot_stale','last_success_unknown','snapshot_missing','snapshot_invalid','snapshot_unreadable','native_unknown']);
  if(row.status==='healthy'&&!healthyReasons.has(row.reasonCode)||row.status==='unknown'&&!unknownReasons.has(row.reasonCode)||row.status==='unhealthy'&&(healthyReasons.has(row.reasonCode)||unknownReasons.has(row.reasonCode)))throw Error('inconsistent-job-health');
  const out:JobStatus={id:row.id,label:row.label,status:row.status as JobStatus['status'],reasonCode:row.reasonCode,registryRevision:row.registryRevision};
  for(const name of ['sourceRevision','runtimeRevision','entrypointRevision'] as const){const v=row[name];if((name==='sourceRevision'?revision(v):digest(v)))out[name]=v as string;}
  if(typeof row.outcome==='string'&&outcomes.has(row.outcome))out.outcome=row.outcome;
  for(const name of ['startedAt','finishedAt','lastSuccess','nextDue'] as const){const v=row[name];if(v===null||timestamp(v))out[name]=v;}
  for(const name of ['ageSeconds','durationSeconds','deadlineSeconds','retryCount','retryBudget','pendingDeliveryCount'] as const){const v=row[name];if(bounded(v))out[name]=v;}
  const f=object(row.lastFailure);if(f&&typeof f.outcome==='string'&&outcomes.has(f.outcome)&&typeof f.reasonCode==='string'&&reasons.has(f.reasonCode)&&timestamp(f.at))out.lastFailure={outcome:f.outcome,reasonCode:f.reasonCode,at:f.at};
  return out;
 });
 const aggregate=items.some(job=>job.status==='unknown')?'unknown':'ok';
 if(inventory.status!==aggregate)throw Error('inconsistent-job-inventory');
 return {status:aggregate,items};
}
export function jobAttention(inventory:JobInventory|undefined):Attention[]{
 return (inventory?.items??[]).filter(job=>job.status!=='healthy').map(job=>({severity:job.status==='unknown'?'warning':'error',kind:'job',title:job.id,detail:[job.status,job.reasonCode,job.registryRevision,job.sourceRevision??'',job.runtimeRevision??''].join(' · ')}));
}
