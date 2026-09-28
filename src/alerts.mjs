// Attention transitions, their bounded history, and delivery to the fleet's notification relay.
import fs from 'node:fs/promises';
import path from 'node:path';

// Beszel owns resource thresholds; by default host-monitor notifies only for service-semantic attention.
export const DEFAULT_ALERT_KINDS=['service','unit','container','probe'];
export const MESSAGE_PREFIX='[host-monitor]';
const key=(kind,title)=>kind+'\0'+title;
const bounded=(v,max=512)=>typeof v==='string'&&v.length<=max?v:undefined;

// Loopback or tailnet (MagicDNS *.ts.net or 100.64.0.0/10) only; credentials and query strings are refused
// so no token can live in configuration.
export function webhookUrl(value) {
 let u;try{u=new URL(value);}catch{throw new Error('invalid-alerts-webhook');}
 const octets=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname)?.slice(1).map(Number);
 const tailnetIp=octets?.every(n=>n<=255)&&octets[0]===100&&octets[1]>=64&&octets[1]<=127;
 const allowed=['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.hostname.endsWith('.ts.net')||tailnetIp;
 if(!['http:','https:'].includes(u.protocol)||!allowed||u.username||u.password||u.search)throw new Error('invalid-alerts-webhook');
 return u;
}
export function parseQuietHours(value) {
 if(value===undefined||value===null)return null;
 const hm=/^([01]\d|2[0-3]):([0-5]\d)$/,minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
 if(typeof value!=='object'||!hm.test(value.start)||!hm.test(value.end))throw new Error('invalid-quiet-hours');
 const timeZone=value.timeZone??'UTC';try{new Intl.DateTimeFormat('en-GB',{timeZone});}catch{throw new Error('invalid-quiet-hours');}
 return {start:minutes(value.start),end:minutes(value.end),timeZone};
}
export function inQuietHours(quiet,ms) {
 if(!quiet||quiet.start===quiet.end)return false;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:quiet.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
 const now=Number(parts.hour)*60+Number(parts.minute);
 return quiet.start<quiet.end?now>=quiet.start&&now<quiet.end:now>=quiet.start||now<quiet.end;
}

// Tracks the active attention items per host. The first observation of a host without saved state is a silent baseline.
export function createTracker({offlineAfterMs=300000,state={}}={}) {
 const hosts=new Map(Object.entries(state).map(([name,s])=>[name,{known:true,active:new Map((s.active??[]).map(a=>[key(a.kind,a.title),a])),offlineAlerted:!!s.offlineAlerted,offlineSince:null}]));
 const get=name=>{if(!hosts.has(name))hosts.set(name,{known:false,active:new Map(),offlineAlerted:false,offlineSince:null});return hosts.get(name);};
 const event=(at,host,type,{kind,title,severity,detail})=>({at:new Date(at).toISOString(),host,type,kind,title,severity,...(detail?{detail}:{})});
 function online(host,attention,at) {
  const s=get(host),events=[];s.offlineSince=null;
  if(s.offlineAlerted){s.offlineAlerted=false;events.push(event(at,host,'online',{kind:'host',title:host,severity:'ok'}));}
  const next=new Map();for(const a of attention)next.set(key(a.kind,a.title),{kind:a.kind,title:a.title,severity:a.severity,...(a.detail?{detail:a.detail}:{})});
  if(s.known){
   for(const [k,a] of next)if(!s.active.has(k))events.push(event(at,host,'attention',a));
   for(const [k,a] of s.active)if(!next.has(k))events.push(event(at,host,'recovered',{kind:a.kind,title:a.title,severity:'ok'}));
  }
  s.known=true;s.active=next;return events;
 }
 function offline(host,at) {
  const s=get(host);s.offlineSince??=at;
  if(s.offlineAlerted||!(offlineAfterMs>0)||at-s.offlineSince<offlineAfterMs)return [];
  s.offlineAlerted=true;return [event(at,host,'offline',{kind:'host',title:host,severity:'error',detail:`no successful collection for ${Math.round((at-s.offlineSince)/60000)} min`})];
 }
 const snapshot=()=>Object.fromEntries([...hosts].filter(([,s])=>s.known).map(([name,s])=>[name,{active:[...s.active.values()],offlineAlerted:s.offlineAlerted}]));
 return {online,offline,snapshot};
}

// Posts Apprise-style JSON ({title, body, type, format}) to the relay. Delivery runs on its own queue with bounded
// retries, so collection never waits for it. During quiet hours alerts are held and sent as one summary afterwards.
export function createNotifier({url,authEnv,env=process.env,kinds=DEFAULT_ALERT_KINDS,quietHours,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),retries=3,backoffMs=[2000,10000,30000],timeoutMs=5000,maxQueue=100,log=()=>{}}) {
 const target=webhookUrl(url),quiet=parseQuietHours(quietHours),queue=[],deferred=new Map(),stats={sent:0,failed:0,dropped:0};let running=null;
 const alertable=e=>e.type==='offline'||e.type==='online'||kinds.includes(e.kind);
 const clip=s=>s.length>3500?s.slice(0,3499)+'…':s;
 function format(e) {
  const title=`${MESSAGE_PREFIX} ${e.host}: `;
  if(e.type==='attention')return {title:title+`${e.kind} needs attention`,body:e.title+(e.detail?` — ${e.detail}`:''),type:e.severity==='error'?'failure':'warning'};
  if(e.type==='recovered')return {title:title+`${e.kind} recovered`,body:e.title,type:'success'};
  if(e.type==='offline')return {title:title+'collector unreachable',body:e.detail??'no successful collection',type:'failure'};
  return {title:title+'collector reachable again',body:'collection succeeded',type:'success'};
 }
 const describe=e=>e.type==='offline'?`${e.host} collector unreachable`:e.type==='online'?`${e.host} collector reachable again`:`${e.host} ${e.kind} ${e.title} ${e.type==='attention'?'needs attention':'recovered'}`;
 function enqueue(message) {
  queue.push({...message,body:clip(message.body),format:'text'});
  while(queue.length>maxQueue){queue.shift();stats.dropped++;}
  running??=Promise.resolve().then(drain).finally(()=>{running=null;});
 }
 async function send(message) {
  const headers={'content-type':'application/json'},token=authEnv?env[authEnv]:undefined;if(token)headers.authorization='Bearer '+token;
  const response=await fetchImpl(target,{method:'POST',headers,body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  await response.body?.cancel?.();if(!response.ok)throw new Error('relay-status-'+response.status);
 }
 async function drain() {
  while(queue.length){const message=queue.shift();
   for(let attempt=1;;attempt++){try{await send(message);stats.sent++;break;}catch{if(attempt>=retries){stats.failed++;log('alert-delivery-failed');break;}await sleep(backoffMs[Math.min(attempt,backoffMs.length)-1]);}}
  }
 }
 function tick(at) {
  if(!deferred.size||inQuietHours(quiet,at))return;
  const lines=[...deferred.values()].map(e=>'- '+describe(e));deferred.clear();
  enqueue({title:`${MESSAGE_PREFIX} quiet hours summary`,body:lines.join('\n'),type:'info'});
 }
 function submit(events,at) {
  const list=events.filter(alertable);if(!list.length)return;
  if(inQuietHours(quiet,at)){
   for(const e of list){const k=e.host+'\0'+key(e.kind,e.title),held=deferred.get(k);
    if(held&&(e.type==='recovered'||e.type==='online')&&(held.type==='attention'||held.type==='offline'))deferred.delete(k);else deferred.set(k,e);}
   return;
  }
  tick(at);for(const e of list)enqueue(format(e));
 }
 return {submit,tick,idle:async()=>{while(running)await running;},stats:()=>({...stats})};
}

// Append-only JSONL of transitions, rotated to one previous file once the current file would exceed maxBytes.
export function createHistory({dir,maxBytes=1048576,keep=500}={}) {
 const file=dir&&path.join(dir,'events.jsonl'),previous=dir&&path.join(dir,'events.1.jsonl');let events=[],size=0,chain=Promise.resolve();
 const project=e=>{if(!e||typeof e!=='object')return null;const out={at:bounded(e.at,64),host:bounded(e.host,256),type:bounded(e.type,32),kind:bounded(e.kind,64),title:bounded(e.title),severity:bounded(e.severity,32),detail:bounded(e.detail)};
  if(!out.at||!Number.isFinite(Date.parse(out.at))||!out.host||!['attention','recovered','offline','online'].includes(out.type)||!out.kind||!out.title)return null;if(out.detail===undefined)delete out.detail;return out;};
 async function load() {
  if(!dir)return;await fs.mkdir(dir,{recursive:true,mode:0o700});const lines=[];
  for(const f of [previous,file]){let text;try{text=await fs.readFile(f,'utf8');}catch{continue;}if(f===file)size=Buffer.byteLength(text);lines.push(...text.split('\n').filter(Boolean));}
  events=lines.flatMap(line=>{try{const e=project(JSON.parse(line));return e?[e]:[];}catch{return [];}}).slice(-keep);
 }
 function add(event) {
  const e=project(event);if(!e)return;events.push(e);if(events.length>keep)events.shift();if(!dir)return;
  const line=JSON.stringify(e)+'\n',bytes=Buffer.byteLength(line);
  chain=chain.then(async()=>{if(size>0&&size+bytes>maxBytes){await fs.rename(file,previous);size=0;}await fs.appendFile(file,line,{mode:0o600});size+=bytes;}).catch(()=>{});
 }
 const recent=({limit=100,host}={})=>events.filter(e=>!host||e.host===host).slice(-limit).reverse();
 return {load,add,recent,flush:()=>chain};
}
