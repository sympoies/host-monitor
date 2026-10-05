import type {RouterInfo} from './router.ts';
import type {SessionInventory} from './sessions.ts';
export type Health='ok'|'error'|'idle'|'inactive'|'transition'|'unknown';
export interface MemInfo{total:number;available:number;used:number;swapTotal:number;swapUsed:number}
export interface Disk{source:string;type:string;total:number;used:number;available:number;percent:number;mount:string}
export interface Service{name:string;scope:string;health:Health;manager?:string;description?:string;installed?:string;active?:string;sub?:string;type?:string;result?:string;exitCode?:number|null;memoryBytes?:number|null;lastExit?:string|null;lastStarted?:string|null;triggers?:string;restarts?:number|null;required?:boolean}
export interface FailedUnit{scope:string;name:string;active?:string;sub?:string}
export interface Container{name:string;image:string;state:string;status:string;health:string}
export interface JournalEntry{unit:string;scope:string;process?:string;count:number;lastAt:string|null}
export interface Probe{name:string;ok:boolean;status:number|null}
export interface Gpu{name:string;busy:number;memoryTotal:number;memoryUsed:number;temperature:number}
export interface Attention{severity:string;kind:string;title:string;detail?:string}
export interface Hardware{cpuCount:number;cpuModel?:string;cpuBusy?:number|null;load:number[];uptime:number;kernel:string}
export interface AndroidBattery{level:number;health:string;temperature:number;status:string;power:string}
export interface AndroidSensor{name:string;temperature:number}
/** Device state read over adb (fleet-infra decision 0003). `protection` is Samsung battery protection; null when the device has none. */
export interface AndroidInfo{model?:string;release?:string;battery?:AndroidBattery;protection?:boolean|null;thermal?:{status:number;sensors:AndroidSensor[]}}
export interface Snapshot{schemaVersion:number;host:string;collectedAt:string;platform?:string;resources?:'collected'|'external';agentless?:boolean;router?:RouterInfo;agentSessions?:SessionInventory;hardware:Hardware;memory?:MemInfo;disks?:Disk[];services:Service[];failedUnits:FailedUnit[];containers:Container[];journalErrors:JournalEntry[];collectionIssues:string[];probes:Probe[];gpus?:Gpu[];android?:AndroidInfo;attention:Attention[]}
/** The fields attentionFor reads; tests pass partial snapshots. */
export interface AttentionInput{collectionIssues?:string[];services?:Pick<Service,'name'|'scope'|'health'|'active'|'result'|'sub'>[];failedUnits?:FailedUnit[];containers?:Pick<Container,'name'|'health'|'state'>[];disks?:Pick<Disk,'mount'|'percent'>[];memory?:Pick<MemInfo,'available'|'total'>;probes?:Pick<Probe,'name'|'ok'|'status'>[];journalErrors?:Pick<JournalEntry,'unit'|'count'>[]}
export interface UnitState{name:string;active?:string;result?:string;type?:string}
export function parseMeminfo(text:string):MemInfo {
  const values:Record<string,number> = Object.fromEntries(text.trim().split('\n').map(line => {
    const [key, value] = line.split(':'); return [key, Number.parseInt(value, 10) * 1024];
  }));
  const total = values.MemTotal, available = values.MemAvailable;
  if (!(total > 0 && available >= 0 && available <= total)) throw new Error('invalid-memory-snapshot');
  return { total, available, used: total - available, swapTotal: values.SwapTotal, swapUsed: values.SwapTotal - values.SwapFree };
}
export function cpuBusy(a:number[], b:number[]):number|null {
  const delta = b.map((v, i) => v - a[i]); const total = delta.reduce((a,b) => a+b,0);
  if (delta.some(v=>v<0) || total <= 0) return null;
  return Math.round((1 - (delta[3]+delta[4])/total)*1000)/10;
}
export function parseProperties(text:string):Record<string,string>[] {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => Object.fromEntries(block.split('\n').filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];})));
}
export function classifyUnit(unit:UnitState, required:string[] = []):Health {
  if (unit.active === 'failed' || unit.result && !['success',''].includes(unit.result)) return 'error';
  if (required.includes(unit.name) && unit.active !== 'active' && unit.active !== 'activating') return 'error';
  if (unit.active === 'active') return 'ok';
  if (unit.active === 'activating' || unit.active === 'deactivating') return 'transition';
  if (unit.type === 'oneshot' && unit.result === 'success') return 'idle';
  return 'inactive';
}
export function parseDisks(text:string):Disk[] {
  return text.trim().split('\n').slice(1).map(line=>{
    const [source,type,size,used,available,percent,...mount] = line.trim().split(/\s+/);
    return {source,type,total:Number(size),used:Number(used),available:Number(available),percent:Number(percent.replace('%','')),mount:mount.join(' ')};
  }).filter(d=>d.total>0 && !['tmpfs','devtmpfs','overlay','squashfs','efivarfs'].includes(d.type));
}
export function attentionFor(snapshot:AttentionInput):Attention[] {
  const events:Attention[] = [];
  for (const issue of snapshot.collectionIssues ?? []) events.push({severity:'warning',kind:'collection',title:issue});
  for (const unit of snapshot.services ?? []) if (unit.health==='error') events.push({severity:'error',kind:'service',title:unit.name,detail:`${unit.scope} · ${unit.active} · ${unit.result || unit.sub}`});
  for (const unit of snapshot.failedUnits ?? []) if (!(snapshot.services??[]).some(s=>s.scope===unit.scope&&s.name===unit.name&&s.health==='error')) events.push({severity:'error',kind:'unit',title:unit.name,detail:unit.scope});
  for (const c of snapshot.containers??[]) if(c.health==='unhealthy'||c.state==='restarting'||c.state==='dead') events.push({severity:'error',kind:'container',title:c.name,detail:c.health||c.state});
  for (const d of snapshot.disks ?? []) if(d.percent>=85) events.push({severity:d.percent>=95?'error':'warning',kind:'disk',title:d.mount,detail:`${d.percent}% used`});
  if(snapshot.memory && snapshot.memory.available/snapshot.memory.total < .1) events.push({severity:'warning',kind:'memory',title:'Memory available below 10%'});
  for(const probe of snapshot.probes??[]) if(!probe.ok) events.push({severity:'error',kind:'probe',title:probe.name,detail:probe.status?`HTTP ${probe.status}`:'Endpoint unavailable'});
  for(const entry of snapshot.journalErrors??[]) events.push({severity:'warning',kind:'journal',title:entry.unit,detail:`${entry.count} errors in the last hour`});
  return events;
}
export function parseContainers(text:string):Container[] {
  return text.trim().split('\n').filter(Boolean).map(line=>{const c=JSON.parse(line) as Omit<Container,'health'>;return {...c,health:c.status.includes('(unhealthy)')?'unhealthy':c.status.includes('(healthy)')?'healthy':'not-configured'};});
}
export function parseGpus(text:string):Gpu[] {
  return text.trim().split('\n').filter(Boolean).map(line=>{const [name,busy,total,used,temp]=line.split(',').map(v=>v.trim());return {name,busy:Number(busy),memoryTotal:Number(total)*1024*1024,memoryUsed:Number(used)*1024*1024,temperature:Number(temp)};});
}
export function loopbackProbeUrl(value:string):URL {
  const u=new URL(value);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.protocol!=='http:')throw new Error('probe-must-be-loopback');return u;
}
// launchd (macOS). Only allowlisted top-level fields are read; environment, arguments and paths never leave these parsers.
export const launchdLabel=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:@+-]{1,255}$/.test(v);
export const processName=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9 ._+-]{1,64}$/.test(v);
export interface LaunchdRow{label:string;pid:number;status:number|null;exitReason:boolean}
export interface LaunchdJob{type:string;state:string;process?:string|null;pid?:number|null;runs?:number|null;exitCode:number|null;signal:number|null;periodic:boolean;installed?:string}
export function parseLaunchdServices(text:string):LaunchdRow[] {
  const rows:LaunchdRow[]=[];let inside=false;
  for(const line of text.split('\n')){
    if(line==='\tservices = {'){inside=true;continue;}
    if(!inside)continue;
    if(line.startsWith('\t}'))break;
    const m=/^\s+(\d+)\s+(-|\(pe\)|-?\d+)\s+(\S+)\s*$/.exec(line);
    if(m&&launchdLabel(m[3]))rows.push({label:m[3],pid:Number(m[1]),status:/^-?\d+$/.test(m[2])?Number(m[2]):null,exitReason:m[2]==='(pe)'});
  }
  return rows;
}
export function parseLaunchdJob(text:string):LaunchdJob {
  const fields:Record<string,string>={};let periodic=false;
  for(const line of text.split('\n')){const m=/^\t([a-z][a-z ]*) = (.*)$/.exec(line);if(m&&!(m[1] in fields))fields[m[1]]=m[2];if(line.includes('com.apple.launchd.calendarinterval'))periodic=true;}
  const int=(v:string|undefined)=>/^-?\d+/.test(v??'')?Number.parseInt(v as string,10):null;
  const base=(fields.program??'').split('/').pop();
  return {type:['LaunchAgent','LaunchDaemon'].includes(fields.type)?fields.type:'',state:/^[a-z ]{1,32}$/.test(fields.state??'')?fields.state:'unknown',process:processName(base)?base:null,pid:int(fields.pid),runs:int(fields.runs),exitCode:int(fields['last exit code']),signal:int((fields['last terminating signal']??'').split(': ').pop()),periodic:periodic||'run interval' in fields};
}
// Mirrors classifyUnit: a required job that stops or exits unsuccessfully needs attention; other jobs never do,
// because launchd routinely stops idle agents with signals and non-zero statuses.
export function classifyLaunchdJob(job:Pick<LaunchdJob,'state'|'exitCode'|'signal'|'periodic'|'installed'>, required=false):Health {
  if(job.state==='running')return 'ok';
  const failed=job.signal!=null||job.exitCode!=null&&job.exitCode!==0;
  if(required&&(job.installed==='missing'||failed))return 'error';
  if(job.state==='spawn scheduled')return 'transition';
  if(required)return job.periodic?'idle':'error';
  return job.exitCode===0?'idle':'inactive';
}
// Hosts are compared by short name: macOS reports `name.local`, and a laptop's hostname may differ from its inventory name.
export function hostIdentityMatches(hostname:string|undefined, config:{name:string;identity?:string}):boolean {
  const short=(v:unknown)=>String(v??'').replace(/\.local$/i,'').toLowerCase();
  return !!hostname&&short(hostname)===short(config.identity??config.name);
}
export function logTimestamp(value:unknown):string|null {
  const m=/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(\d\d)$/.exec(typeof value==='string'?value:'');if(!m)return null;
  const time=Date.parse(`${m[1]}T${m[2]}${(m[3]??'').slice(0,4)}${m[4]}:${m[5]}`);return Number.isFinite(time)?new Date(time).toISOString():null;
}
