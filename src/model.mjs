export function parseMeminfo(text) {
  const values = Object.fromEntries(text.trim().split('\n').map(line => {
    const [key, value] = line.split(':'); return [key, Number.parseInt(value, 10) * 1024];
  }));
  const total = values.MemTotal, available = values.MemAvailable;
  if (!(total > 0 && available >= 0 && available <= total)) throw new Error('invalid-memory-snapshot');
  return { total, available, used: total - available, swapTotal: values.SwapTotal, swapUsed: values.SwapTotal - values.SwapFree };
}
export function cpuBusy(a, b) {
  const delta = b.map((v, i) => v - a[i]); const total = delta.reduce((a,b) => a+b,0);
  if (delta.some(v=>v<0) || total <= 0) return null;
  return Math.round((1 - (delta[3]+delta[4])/total)*1000)/10;
}
export function parseProperties(text) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => Object.fromEntries(block.split('\n').filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];})));
}
export function classifyUnit(unit, required = []) {
  if (unit.active === 'failed' || unit.result && !['success',''].includes(unit.result)) return 'error';
  if (required.includes(unit.name) && unit.active !== 'active' && unit.active !== 'activating') return 'error';
  if (unit.active === 'active') return 'ok';
  if (unit.active === 'activating' || unit.active === 'deactivating') return 'transition';
  if (unit.type === 'oneshot' && unit.result === 'success') return 'idle';
  return 'inactive';
}
export function parseDisks(text) {
  return text.trim().split('\n').slice(1).map(line=>{
    const [source,type,size,used,available,percent,...mount] = line.trim().split(/\s+/);
    return {source,type,total:Number(size),used:Number(used),available:Number(available),percent:Number(percent.replace('%','')),mount:mount.join(' ')};
  }).filter(d=>d.total>0 && !['tmpfs','devtmpfs','overlay','squashfs','efivarfs'].includes(d.type));
}
export function attentionFor(snapshot) {
  const events = [];
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
export function parseContainers(text) {
  return text.trim().split('\n').filter(Boolean).map(line=>{const c=JSON.parse(line);return {...c,health:c.status.includes('(unhealthy)')?'unhealthy':c.status.includes('(healthy)')?'healthy':'not-configured'};});
}
export function parseGpus(text) {
  return text.trim().split('\n').filter(Boolean).map(line=>{const [name,busy,total,used,temp]=line.split(',').map(v=>v.trim());return {name,busy:Number(busy),memoryTotal:Number(total)*1024*1024,memoryUsed:Number(used)*1024*1024,temperature:Number(temp)};});
}
export function loopbackProbeUrl(value) {
  const u=new URL(value);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.protocol!=='http:')throw new Error('probe-must-be-loopback');return u;
}
// launchd (macOS). Only allowlisted top-level fields are read; environment, arguments and paths never leave these parsers.
export const launchdLabel=v=>typeof v==='string'&&/^[A-Za-z0-9_.:@+-]{1,255}$/.test(v);
export const processName=v=>typeof v==='string'&&/^[A-Za-z0-9 ._+-]{1,64}$/.test(v);
export function parseLaunchdServices(text) {
  const rows=[];let inside=false;
  for(const line of text.split('\n')){
    if(line==='\tservices = {'){inside=true;continue;}
    if(!inside)continue;
    if(line.startsWith('\t}'))break;
    const m=/^\s+(\d+)\s+(-|\(pe\)|-?\d+)\s+(\S+)\s*$/.exec(line);
    if(m&&launchdLabel(m[3]))rows.push({label:m[3],pid:Number(m[1]),status:/^-?\d+$/.test(m[2])?Number(m[2]):null,exitReason:m[2]==='(pe)'});
  }
  return rows;
}
export function parseLaunchdJob(text) {
  const fields={};let periodic=false;
  for(const line of text.split('\n')){const m=/^\t([a-z][a-z ]*) = (.*)$/.exec(line);if(m&&!(m[1] in fields))fields[m[1]]=m[2];if(line.includes('com.apple.launchd.calendarinterval'))periodic=true;}
  const int=v=>/^-?\d+/.test(v??'')?Number.parseInt(v,10):null;
  const base=(fields.program??'').split('/').pop();
  return {type:['LaunchAgent','LaunchDaemon'].includes(fields.type)?fields.type:'',state:/^[a-z ]{1,32}$/.test(fields.state??'')?fields.state:'unknown',process:processName(base)?base:null,pid:int(fields.pid),runs:int(fields.runs),exitCode:int(fields['last exit code']),signal:int((fields['last terminating signal']??'').split(': ').pop()),periodic:periodic||'run interval' in fields};
}
// Mirrors classifyUnit: a required job that stops or exits unsuccessfully needs attention; other jobs never do,
// because launchd routinely stops idle agents with signals and non-zero statuses.
export function classifyLaunchdJob(job, required=false) {
  if(job.state==='running')return 'ok';
  const failed=job.signal!=null||job.exitCode!=null&&job.exitCode!==0;
  if(required&&(job.installed==='missing'||failed))return 'error';
  if(job.state==='spawn scheduled')return 'transition';
  if(required)return job.periodic?'idle':'error';
  return job.exitCode===0?'idle':'inactive';
}
// Hosts are compared by short name: macOS reports `name.local`, and a laptop's hostname may differ from its inventory name.
export function hostIdentityMatches(hostname, config) {
  const short=v=>String(v??'').replace(/\.local$/i,'').toLowerCase();
  return !!hostname&&short(hostname)===short(config.identity??config.name);
}
export function logTimestamp(value) {
  const m=/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(\d\d)$/.exec(value??'');if(!m)return null;
  const time=Date.parse(`${m[1]}T${m[2]}${(m[3]??'').slice(0,4)}${m[4]}:${m[5]}`);return Number.isFinite(time)?new Date(time).toISOString():null;
}
