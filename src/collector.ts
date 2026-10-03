import {collectSessions} from './sessions.ts';
import type {SessionConfig} from './sessions.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {parseMeminfo,cpuBusy,parseDisks,parseProperties,classifyUnit,attentionFor,parseContainers,parseGpus,loopbackProbeUrl,parseLaunchdServices,parseLaunchdJob,classifyLaunchdJob,hostIdentityMatches,logTimestamp,launchdLabel,processName} from './model.ts';
import type {Service,FailedUnit,JournalEntry,Snapshot,LaunchdJob,LaunchdRow} from './model.ts';
export type Run=(bin:string,args:string[])=>Promise<string>;
export type Stream=(bin:string,args:string[],onLine:(line:string)=>void,options?:{timeout?:number;maxLines?:number})=>Promise<void>;
export interface HostConfig{name:string;identity?:string;required?:{user?:string[];system?:string[]};probes?:{name:string;url:string}[];docker?:boolean;requiredContainers?:string[];nvidia?:boolean;agentSessions?:SessionConfig}
type Scope='user'|'system';
interface LogTarget{label:string;scope:string;process:string}
const exec=promisify(execFile);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function command(bin:string,args:string[]):Promise<string> {return (await exec(bin,args,{timeout:10000,maxBuffer:8*1024*1024,encoding:'utf8',env:{...process.env,LC_ALL:'C'}})).stdout;}
const cpu=async()=> (await fs.readFile('/proc/stat','utf8')).split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
const unitName=(name:unknown):name is string=>typeof name==='string'&&/^[a-zA-Z0-9_.:@\\-]+\.service$/.test(name);
interface UnitFileRow{unit_file:string;state?:string}
interface UnitRow{unit:string;description?:string;active?:string;sub?:string}
export async function collectSystemd(scope:string,required:string[]=[],run:Run=command):Promise<Service[]> {
 const prefix=scope==='user'?['--user']:[];
 const files=JSON.parse(await run('systemctl',[...prefix,'list-unit-files','--type=service','--no-pager','--output=json'])) as UnitFileRow[];
 const loaded=JSON.parse(await run('systemctl',[...prefix,'list-units','--all','--type=service','--no-pager','--output=json'])) as UnitRow[];
 const names=[...new Set([...files.map(r=>r.unit_file),...loaded.map(r=>r.unit),...required])].filter(unitName);
 const queryNames=names.filter(name=>!name.endsWith('@.service'));
 const props=queryNames.length?parseProperties(await run('systemctl',[...prefix,'show','--no-pager','--property=Id,Names,Description,ActiveState,SubState,Type,Result,UnitFileState,ExecMainStatus,MemoryCurrent,ExecMainExitTimestamp,ActiveEnterTimestamp,Triggers,NRestarts','--',...queryNames])):[];
 const byId=new Map<string,Record<string,string>>();for(const p of props)for(const name of [p.Id,...(p.Names||'').split(/\s+/)])if(name)byId.set(name,p);
 const byLoaded=new Map(loaded.map(p=>[p.unit,p]));
 return names.map(name=>{const p:Record<string,string|undefined>=byId.get(name)??(name.endsWith('@.service')?{ActiveState:'inactive',Type:'template'}:{}),r:Partial<UnitRow>=byLoaded.get(name)??{},f=files.find(r=>r.unit_file===name);
  const unit={name,scope,description:p.Description||r.description||name,installed:f?.state||p.UnitFileState||'generated',active:p.ActiveState||r.active||'unknown',sub:p.SubState||r.sub||'',type:p.Type||'',result:p.Result||'',exitCode:p.ExecMainStatus?Number(p.ExecMainStatus):null,memoryBytes:/^\d+$/.test(p.MemoryCurrent||'')?Number(p.MemoryCurrent):null,lastExit:p.ExecMainExitTimestamp||null,lastStarted:p.ActiveEnterTimestamp||null,triggers:p.Triggers||'',restarts:/^\d+$/.test(p.NRestarts||'')?Number(p.NRestarts):null,required:required.includes(name)};
  return {...unit,health:classifyUnit(unit,required)};
 });
}
async function failed(scope:string):Promise<FailedUnit[]> {
 const prefix=scope==='user'?['--user']:[];
 return (JSON.parse(await command('systemctl',[...prefix,'list-units','--failed','--no-pager','--output=json'])) as UnitRow[]).map(r=>({scope,name:r.unit,active:r.active,sub:r.sub}));
}
export async function journal(scope:string,run:Run=command):Promise<JournalEntry[]> {
 const prefix=scope==='user'?['--user']:['--system'];
 const text=await run('journalctl',[...prefix,'--since=-1h','--priority=err','--no-pager','--output=json','--output-fields=_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT,__REALTIME_TIMESTAMP,PRIORITY','-n','2000']);
 const groups=new Map<string,JournalEntry>();for(const line of text.trim().split('\n').filter(Boolean)){const row=JSON.parse(line);const unit:unknown=row._SYSTEMD_USER_UNIT||row._SYSTEMD_UNIT||'system';if(typeof unit!=='string')continue;const key=scope+':'+unit;const item=groups.get(key)||{unit,scope,count:0,lastAt:null};item.count++;const time=Number(row.__REALTIME_TIMESTAMP)/1000;if(Number.isFinite(time))item.lastAt=new Date(time).toISOString();groups.set(key,item);}return [...groups.values()];
}
// Streams stdout line by line so a large log never has to fit in memory; a timeout or line cap fails the part.
export const streamLines:Stream=(bin,args,onLine,{timeout=20000,maxLines=500000}={})=>{
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C'}});let rest='',lines=0,done=false;
  const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve();};
  const timer=setTimeout(()=>finish(new Error('command-timeout')),timeout);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{if(done)return;rest+=chunk;let i;while(!done&&(i=rest.indexOf('\n'))>=0){const line=rest.slice(0,i);rest=rest.slice(i+1);if(++lines>maxLines)return finish(new Error('command-output-limit'));onLine(line);}if(rest.length>1048576)finish(new Error('command-output-limit'));});
  child.on('error',finish);child.on('close',code=>{if(!done&&rest)onLine(rest);finish(code===0?undefined:new Error('command-failed'));});
 });
};
// macOS: user agents live in the gui/<uid> domain (user/<uid> without a login session), daemons in the system domain.
// Both are readable without privileges. Detail is read only for required labels; the domain list covers the rest.
export async function collectLaunchd(scope:string,required:string[]=[],{uid=process.getuid?.(),run=command}:{uid?:number;run?:Run}={}):Promise<{services:Service[];logTargets:LogTarget[]}> {
 if(scope==='user'&&!Number.isInteger(uid))throw new Error('uid-unavailable');
 let domain=scope==='user'?'gui/'+uid:'system',text;
 try{text=await run('launchctl',['print',domain]);}catch(error){if(scope!=='user')throw error;domain='user/'+uid;text=await run('launchctl',['print',domain]);}
 const inventory=new Map<string,LaunchdRow>(parseLaunchdServices(text).map(r=>[r.label,r]));
 const wanted=required.filter(launchdLabel);
 const details=new Map<string,LaunchdJob|null>(await Promise.all(wanted.map(async(label):Promise<[string,LaunchdJob|null]>=>{try{return [label,parseLaunchdJob(await run('launchctl',['print',domain+'/'+label]))];}catch{return [label,null];}})));
 const services=[...new Set([...inventory.keys(),...wanted])].map((name):Service=>{
  const r=inventory.get(name),d=details.get(name),isRequired=wanted.includes(name);
  const job:LaunchdJob=d?{...d,installed:'loaded'}:r?{type:scope==='user'?'LaunchAgent':'LaunchDaemon',state:r.pid>0?'running':'not running',exitCode:r.status!==null&&r.status>=0?r.status:null,signal:r.status!==null&&r.status<0?-r.status:null,periodic:false,installed:'loaded'}:{type:'',state:'not loaded',exitCode:null,signal:null,periodic:false,installed:'missing'};
  const result=job.state==='running'?'':job.signal!=null?'signal':job.exitCode===0?'success':job.exitCode!=null?'exit-code':'';
  return {name,scope,manager:'launchd',description:name,installed:job.installed,active:job.state==='running'?'active':job.state==='spawn scheduled'?'activating':'inactive',sub:job.state,type:job.type,result,exitCode:job.exitCode,memoryBytes:null,lastExit:null,lastStarted:null,triggers:job.periodic?'interval':'',required:isRequired,health:classifyLaunchdJob(job,isRequired)};
 });
 return {services,logTargets:wanted.flatMap(label=>{const process=details.get(label)?.process;return process?[{label,scope,process}]:[];})};
}
// Error counts for required jobs, attributed by process name (and uid for user agents). Message text is never read out.
export async function launchdLogErrors(targets:LogTarget[],{uid=process.getuid?.(),stream=streamLines}:{uid?:number;stream?:Stream}={}):Promise<JournalEntry[]> {
 const valid=targets.filter(t=>launchdLabel(t.label)&&processName(t.process));if(!valid.length)return [];
 const names=[...new Set(valid.map(t=>t.process))],byProcess=new Map(names.map(n=>[n,valid.filter(t=>t.process===n)]));
 const counts=new Map<LogTarget,JournalEntry>(valid.map(t=>[t,{unit:t.label,scope:t.scope,process:t.process,count:0,lastAt:null}]));
 await stream('/usr/bin/log',['show','--last','1h','--style','ndjson','--predicate',`messageType == error AND (${names.map(n=>`process == "${n}"`).join(' OR ')})`],line=>{
  let row;try{row=JSON.parse(line);}catch{return;}if(typeof row?.processImagePath!=='string')return;
  for(const t of byProcess.get(row.processImagePath.split('/').pop())??[]){if(t.scope==='user'&&row.userID!==uid)continue;const item=counts.get(t)!;item.count++;const at=logTimestamp(row.timestamp);if(at&&(!item.lastAt||at>item.lastAt))item.lastAt=at;}
 });
 return [...counts.values()].filter(item=>item.count>0);
}
async function containers() {
 const text=await command('docker',['ps','-a','--format','{"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}}}']);
 return parseContainers(text);
}
async function gpu() {
 const text=await command('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu','--format=csv,noheader,nounits']);
 return parseGpus(text);
}
export async function collect(config:HostConfig,{platform=process.platform,hostname=os.hostname(),uid=process.getuid?.(),run=command,stream=streamLines}:{platform?:string;hostname?:string;uid?:number;run?:Run;stream?:Stream}={}):Promise<Snapshot> {
 if(!hostIdentityMatches(hostname,config))throw new Error('host-identity-mismatch');
 const darwin=platform==='darwin';
 // Resource metrics on macOS come from Beszel by design, so they are marked external rather than reported as failures.
 const result:Snapshot={schemaVersion:1,host:config.name,platform,resources:darwin?'external':'collected',collectedAt:new Date().toISOString(),hardware:{cpuCount:os.cpus().length,cpuModel:os.cpus()[0]?.model,load:os.loadavg(),uptime:os.uptime(),kernel:os.release()},collectionIssues:[],services:[],failedUnits:[],containers:[],journalErrors:[],probes:[],attention:[]};
 async function part<T>(name:string,fn:()=>Promise<T>,apply:(value:T)=>void){try{apply(await fn());}catch{result.collectionIssues.push(name+' unavailable');}}
 const probes=()=>(config.probes??[]).map(async probe=>{const u=loopbackProbeUrl(probe.url);try{const r=await fetch(u,{signal:AbortSignal.timeout(5000),redirect:'error'});result.probes.push({name:probe.name,ok:r.ok,status:r.status});await r.body?.cancel();}catch{result.probes.push({name:probe.name,ok:false,status:null});}});
 const sessions=collectSessions(config.agentSessions,run===command?undefined:async(bin,args)=>run(bin,args));
 const scopes:Scope[]=['system','user'];
 await Promise.all(darwin?[
  (async()=>{const byScope:Partial<Record<Scope,LogTarget[]>>={};await Promise.all((['user','system'] as Scope[]).map(scope=>part(scope+' services',()=>collectLaunchd(scope,config.required?.[scope]??[],{uid,run}),v=>{result.services.push(...v.services);byScope[scope]=v.logTargets;})));
   await part('error log',()=>launchdLogErrors([...byScope.user??[],...byScope.system??[]],{uid,stream}),v=>result.journalErrors.push(...v));})(),
  ...(config.docker?[part('containers',containers,v=>result.containers=v)]:[]),
  ...probes(),
 ]:[
  part('CPU',async()=>{const a=await cpu();await delay(1000);return cpuBusy(a,await cpu());},value=>result.hardware.cpuBusy=value),
  part('memory',async()=>parseMeminfo(await fs.readFile('/proc/meminfo','utf8')),value=>result.memory=value),
  part('disks',async()=>parseDisks(await command('df',['-B1','--exclude-type=fuse.portal','--output=source,fstype,size,used,avail,pcent,target'])),value=>result.disks=value),
  ...scopes.flatMap(scope=>[
   part(scope+' services',()=>collectSystemd(scope,config.required?.[scope]??[]),v=>result.services.push(...v)),
   part(scope+' failed units',()=>failed(scope),v=>result.failedUnits.push(...v)),
   part(scope+' journal',()=>journal(scope),v=>result.journalErrors.push(...v)),
  ]),
  ...(config.docker?[part('containers',containers,v=>result.containers=v)]:[]),
  ...(config.nvidia?[part('GPU',gpu,v=>result.gpus=v)]:[]),
  ...probes(),
 ]);
 result.agentSessions=await sessions;
 for(const name of config.requiredContainers??[]){const c=result.containers.find(c=>c.name===name);if(!c)result.containers.push({name,image:'Configured service',state:'missing',status:'Container missing',health:'unhealthy'});else if(c.state!=='running')c.health='unhealthy';}
 result.services.sort((a,b)=>a.scope.localeCompare(b.scope)||a.name.localeCompare(b.name));result.attention=attentionFor(result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await fs.realpath(process.argv[1]).catch(()=>process.argv[1])).href){const at=process.argv.indexOf('--config');if(at<0)throw new Error('host config is required');const config=JSON.parse(await fs.readFile(process.argv[at+1],'utf8')) as HostConfig;try{console.log(JSON.stringify(await collect(config)));}catch(error){console.error(JSON.stringify({code:'collection-failed',reason:error instanceof Error&&error.message==='host-identity-mismatch'?error.message:'configuration-or-runtime-unavailable'}));process.exitCode=1;}}
