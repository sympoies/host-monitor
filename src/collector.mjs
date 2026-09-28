import fs from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {parseMeminfo,cpuBusy,parseDisks,parseProperties,classifyUnit,attentionFor} from './model.mjs';
const exec=promisify(execFile);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function command(bin,args) {return (await exec(bin,args,{timeout:10000,maxBuffer:8*1024*1024,encoding:'utf8',env:{...process.env,LC_ALL:'C'}})).stdout;}
const cpu=async()=> (await fs.readFile('/proc/stat','utf8')).split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
const unitName=name=>typeof name==='string'&&/^[a-zA-Z0-9_.:@\\-]+\.service$/.test(name);
export async function collectSystemd(scope,required=[],run=command) {
 const prefix=scope==='user'?['--user']:[];
 const files=JSON.parse(await run('systemctl',[...prefix,'list-unit-files','--type=service','--no-pager','--output=json']));
 const loaded=JSON.parse(await run('systemctl',[...prefix,'list-units','--all','--type=service','--no-pager','--output=json']));
 const names=[...new Set([...files.map(r=>r.unit_file),...loaded.map(r=>r.unit),...required])].filter(unitName);
 const queryNames=names.filter(name=>!name.endsWith('@.service'));
 const props=queryNames.length?parseProperties(await run('systemctl',[...prefix,'show','--no-pager','--property=Id,Names,Description,ActiveState,SubState,Type,Result,UnitFileState,ExecMainStatus,MemoryCurrent,ExecMainExitTimestamp,ActiveEnterTimestamp,Triggers','--',...queryNames])):[];
 const byId=new Map();for(const p of props)for(const name of [p.Id,...(p.Names||'').split(/\s+/)])if(name)byId.set(name,p);
 const byLoaded=new Map(loaded.map(p=>[p.unit,p]));
 return names.map(name=>{const p=byId.get(name)??(name.endsWith('@.service')?{ActiveState:'inactive',Type:'template'}:{}),r=byLoaded.get(name)??{},f=files.find(r=>r.unit_file===name);
  const unit={name,scope,description:p.Description||r.description||name,installed:f?.state||p.UnitFileState||'generated',active:p.ActiveState||r.active||'unknown',sub:p.SubState||r.sub||'',type:p.Type||'',result:p.Result||'',exitCode:p.ExecMainStatus?Number(p.ExecMainStatus):null,memoryBytes:/^\d+$/.test(p.MemoryCurrent||'')?Number(p.MemoryCurrent):null,lastExit:p.ExecMainExitTimestamp||null,lastStarted:p.ActiveEnterTimestamp||null,triggers:p.Triggers||'',required:required.includes(name)};
  unit.health=classifyUnit(unit,required);return unit;
 });
}
async function failed(scope) {
 const prefix=scope==='user'?['--user']:[];
 return JSON.parse(await command('systemctl',[...prefix,'list-units','--failed','--no-pager','--output=json'])).map(r=>({scope,name:r.unit,active:r.active,sub:r.sub}));
}
export async function journal(scope,run=command) {
 const prefix=scope==='user'?['--user']:['--system'];
 const text=await run('journalctl',[...prefix,'--since=-1h','--priority=err','--no-pager','--output=json','--output-fields=_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT,__REALTIME_TIMESTAMP,PRIORITY','-n','2000']);
 const groups=new Map();for(const line of text.trim().split('\n').filter(Boolean)){const row=JSON.parse(line);const unit=row._SYSTEMD_USER_UNIT||row._SYSTEMD_UNIT||'system';if(typeof unit!=='string')continue;const key=scope+':'+unit;const item=groups.get(key)||{unit,scope,count:0,lastAt:null};item.count++;const time=Number(row.__REALTIME_TIMESTAMP)/1000;if(Number.isFinite(time))item.lastAt=new Date(time).toISOString();groups.set(key,item);}return [...groups.values()];
}
async function containers() {
 const text=await command('docker',['ps','-a','--format','{"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}}}']);
 return text.trim().split('\n').filter(Boolean).map(line=>{const c=JSON.parse(line);return {...c,health:c.status.includes('(unhealthy)')?'unhealthy':c.status.includes('(healthy)')?'healthy':'not-configured'};});
}
async function gpu() {
 const text=await command('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu','--format=csv,noheader,nounits']);
 return text.trim().split('\n').filter(Boolean).map(line=>{const [name,busy,total,used,temp]=line.split(',').map(v=>v.trim());return {name,busy:Number(busy),memoryTotal:Number(total)*1024*1024,memoryUsed:Number(used)*1024*1024,temperature:Number(temp)};});
}
export async function collect(config) {
 if(config.name!==os.hostname())throw new Error('host-identity-mismatch');
 const result={schemaVersion:1,host:config.name,collectedAt:new Date().toISOString(),hardware:{cpuCount:os.cpus().length,cpuModel:os.cpus()[0]?.model,load:os.loadavg(),uptime:os.uptime(),kernel:os.release()},collectionIssues:[],services:[],failedUnits:[],containers:[],journalErrors:[],probes:[]};
 async function part(name,fn,apply){try{apply(await fn());}catch{result.collectionIssues.push(name+' unavailable');}}
 await Promise.all([
  part('CPU',async()=>{const a=await cpu();await delay(1000);return cpuBusy(a,await cpu());},value=>result.hardware.cpuBusy=value),
  part('memory',async()=>parseMeminfo(await fs.readFile('/proc/meminfo','utf8')),value=>result.memory=value),
  part('disks',async()=>parseDisks(await command('df',['-B1','--exclude-type=fuse.portal','--output=source,fstype,size,used,avail,pcent,target'])),value=>result.disks=value),
  ...['system','user'].flatMap(scope=>[
   part(scope+' services',()=>collectSystemd(scope,config.required?.[scope]??[]),v=>result.services.push(...v)),
   part(scope+' failed units',()=>failed(scope),v=>result.failedUnits.push(...v)),
   part(scope+' journal',()=>journal(scope),v=>result.journalErrors.push(...v)),
  ]),
  ...(config.docker?[part('containers',containers,v=>result.containers=v)]:[]),
  ...(config.nvidia?[part('GPU',gpu,v=>result.gpus=v)]:[]),
  ...((config.probes??[]).map(async probe=>{const u=new URL(probe.url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.protocol!=='http:')throw new Error('probe-must-be-loopback');try{const r=await fetch(u,{signal:AbortSignal.timeout(5000),redirect:'error'});result.probes.push({name:probe.name,ok:r.ok,status:r.status});await r.body?.cancel();}catch{result.probes.push({name:probe.name,ok:false,status:null});}})),
 ]);
 for(const name of config.requiredContainers??[]){const c=result.containers.find(c=>c.name===name);if(!c)result.containers.push({name,image:'Configured service',state:'missing',status:'Container missing',health:'unhealthy'});else if(c.state!=='running')c.health='unhealthy';}
 result.services.sort((a,b)=>a.scope.localeCompare(b.scope)||a.name.localeCompare(b.name));result.attention=attentionFor(result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await fs.realpath(process.argv[1]).catch(()=>process.argv[1])).href){const at=process.argv.indexOf('--config');if(at<0)throw new Error('host config is required');const config=JSON.parse(await fs.readFile(process.argv[at+1],'utf8'));try{console.log(JSON.stringify(await collect(config)));}catch(error){console.error(JSON.stringify({code:'collection-failed',reason:error.message==='host-identity-mismatch'?error.message:'configuration-or-runtime-unavailable'}));process.exitCode=1;}}
