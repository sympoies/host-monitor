// Attention transitions, their bounded history, and delivery to the fleet's notification relay.
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Attention} from './model.ts';

export type EventType='attention'|'recovered'|'offline'|'online';
export interface AlertEvent{at:string;host:string;type:EventType;kind:string;title:string;severity:string;detail?:string}
export interface QuietHours{start:number;end:number;timeZone:string}
export interface TrackerState{[host:string]:{active?:Attention[];baseline?:Attention[];offlineAlerted?:boolean}}
export interface Message{title:string;body:string;type:string;format?:string}
type Fetch=(input:URL,init:RequestInit)=>Promise<Pick<Response,'ok'|'status'>&{body?:{cancel?:()=>Promise<void>}|null}>;
type Log=(message:string)=>void;

// Beszel owns resource thresholds; by default host-monitor notifies for service-semantic attention and for Android
// device attention, which Beszel cannot collect (fleet-infra decision 0003).
export const DEFAULT_ALERT_KINDS=['service','unit','container','probe','device'];
export const MESSAGE_PREFIX='[host-monitor]';
const key=(kind:string,title:string)=>kind+'\0'+title;
const bounded=(v:unknown,max=512)=>typeof v==='string'&&v.length<=max?v:undefined;
const errorCode=(error:unknown)=>(error as {code?:unknown}|null)?.code;

// Loopback or tailnet (MagicDNS *.ts.net or 100.64.0.0/10) only; credentials and query strings are refused
// so no token can live in configuration.
export function webhookUrl(value:unknown):URL {
 let u;try{u=new URL(value as string);}catch{throw new Error('invalid-alerts-webhook');}
 const octets=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname)?.slice(1).map(Number);
 const tailnetIp=octets?.every(n=>n<=255)&&octets[0]===100&&octets[1]>=64&&octets[1]<=127;
 const allowed=['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.hostname.endsWith('.ts.net')||tailnetIp;
 if(!['http:','https:'].includes(u.protocol)||!allowed||u.username||u.password||u.search)throw new Error('invalid-alerts-webhook');
 return u;
}
export function parseQuietHours(value:unknown):QuietHours|null {
 if(value===undefined||value===null)return null;
 const hm=/^([01]\d|2[0-3]):([0-5]\d)$/,minutes=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3));
 const v=value as {start?:unknown;end?:unknown;timeZone?:unknown};
 if(typeof value!=='object'||typeof v.start!=='string'||typeof v.end!=='string'||!hm.test(v.start)||!hm.test(v.end))throw new Error('invalid-quiet-hours');
 const timeZone=v.timeZone??'UTC';try{new Intl.DateTimeFormat('en-GB',{timeZone:timeZone as string});}catch{throw new Error('invalid-quiet-hours');}
 return {start:minutes(v.start),end:minutes(v.end),timeZone:timeZone as string};
}
export function inQuietHours(quiet:QuietHours|null,ms:number):boolean {
 if(!quiet||quiet.start===quiet.end)return false;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:quiet.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
 const now=Number(parts.hour)*60+Number(parts.minute);
 return quiet.start<quiet.end?now>=quiet.start&&now<quiet.end:now>=quiet.start||now<quiet.end;
}

export interface RestartLoop{restarts:number;windowMs:number}
type Grace=number|((host:string,item:Attention)=>number);
interface Seen{item:Attention;since:number}
interface HostTrack{known:boolean;seen:Map<string,Seen>;alerted:Map<string,Attention>;loops:Set<string>;baseline:Map<string,Attention>;episodes:Map<string,number[]>;restarts:Map<string,number>;lastOnline:number|null;offlineAlerted:boolean;offlineSince:number|null}
// A self-healing restart (a binary replacement exits 75 and systemd restarts it; a model takes seconds to load) is
// over well within a minute, while host refresh intervals are 20 s to 5 min. 90 s therefore spans the observed
// restarts with margin, and a real outage still alerts on the first collection at least 90 s after it was first seen.
export const DEFAULT_GRACE_MS=90000;
export const DEFAULT_RESTART_LOOP:RestartLoop={restarts:3,windowMs:600000};
// Tracks attention items per host. An item alerts once it has stayed unhealthy for its grace window, or when it starts
// `restarts` times within `windowMs` (systemd NRestarts steps, or new failures of items without a counter). Only alerted
// items send a recovery; a loop recovers only after a full window without restarts, so a steady loop stays one incident.
// The first observation is silent except notices and explicitly selected critical failures.
export function createTracker({offlineAfterMs=300000,state={},graceMs=DEFAULT_GRACE_MS,restartLoop=DEFAULT_RESTART_LOOP,initialAlert=()=>false}:{offlineAfterMs?:number;state?:TrackerState;graceMs?:Grace;restartLoop?:RestartLoop;initialAlert?:(host:string,item:Attention)=>boolean}={}) {
 const items=(list:Attention[]|undefined)=>new Map((list??[]).map(a=>[key(a.kind,a.title),a]));
 const blank=():HostTrack=>({known:false,seen:new Map(),alerted:new Map(),loops:new Set(),baseline:new Map(),episodes:new Map(),restarts:new Map(),lastOnline:null,offlineAlerted:false,offlineSince:null});
 const hosts=new Map<string,HostTrack>(Object.entries(state).map(([name,s])=>[name,{...blank(),known:true,alerted:items(s.active),baseline:items(s.baseline),offlineAlerted:!!s.offlineAlerted}]));
 const get=(name:string)=>{let s=hosts.get(name);if(!s){s=blank();hosts.set(name,s);}return s;};
 const grace=(host:string,a:Attention)=>typeof graceMs==='function'?graceMs(host,a):graceMs;
 const event=(at:number,host:string,type:EventType,{kind,title,severity,detail}:Attention):AlertEvent=>({at:new Date(at).toISOString(),host,type,kind,title,severity,...(detail?{detail}:{})});
 const looping=(times:number[]|undefined)=>restartLoop.restarts>0&&(times?.length??0)>=restartLoop.restarts;
 // restarts maps a systemd service name to its NRestarts counter. A lower value means the counter was reset (a manual
 // restart); the first value seen, and the first after a gap longer than the window, is a baseline, because the time of
 // those restarts is unknown. Services with a counter count restarts only from it, so a crash seen as a failed unit and
 // then as the counter step that restarted it counts once.
 function online(host:string,attention:Attention[],at:number,restarts:Record<string,number>={}):AlertEvent[] {
  const s=get(host),events:AlertEvent[]=[];s.offlineSince=null;
  if(s.offlineAlerted){s.offlineAlerted=false;events.push(event(at,host,'online',{kind:'host',title:host,severity:'ok'}));}
  const next=new Map<string,Attention>();for(const a of attention)next.set(key(a.kind,a.title),{kind:a.kind,title:a.title,severity:a.severity,...(a.detail?{detail:a.detail}:{})});
  if(!s.known){s.known=true;s.baseline=new Map([...next].filter(([,a])=>a.severity!=='notice'&&!initialAlert(host,a)));}
  const started=(k:string,count:number)=>{const times=s.episodes.get(k)??[];for(let i=0;i<Math.min(count,100);i++)times.push(at);s.episodes.set(k,times);};
  const counted=new Set<string>(),recent=s.lastOnline!==null&&at-s.lastOnline<=restartLoop.windowMs;s.lastOnline=at;
  for(const [name,count] of Object.entries(restarts)){const k=key('service',name),last=s.restarts.get(name);counted.add(k);s.restarts.set(name,count);if(last!==undefined&&recent)started(k,count>=last?count-last:count);}
  for(const [k,a] of next){const seen=s.seen.get(k);if(seen){seen.item=a;continue;}s.seen.set(k,{item:a,since:at});if(!counted.has(k)&&!s.baseline.has(k)&&a.severity!=='notice')started(k,1);}
  for(const k of [...s.seen.keys()])if(!next.has(k))s.seen.delete(k);
  for(const [k,times] of s.episodes){const recent=times.filter(t=>at-t<restartLoop.windowMs);if(recent.length)s.episodes.set(k,recent);else s.episodes.delete(k);}
  for(const k of [...s.baseline.keys()])if(!next.has(k))s.baseline.delete(k);
  for(const [k,{item,since}] of s.seen)if(!s.alerted.has(k)&&!s.baseline.has(k)&&at-since>=grace(host,item)){s.alerted.set(k,item);events.push(event(at,host,'attention',item));}
  for(const [k,times] of s.episodes)if(looping(times)&&!s.alerted.has(k)&&!s.baseline.has(k)){
   const [kind,title]=k.split('\0'),minutes=Math.round(restartLoop.windowMs/60000);
   s.loops.add(k);const item={kind,title,severity:'error',detail:counted.has(k)?`restart loop · ${times.length} restarts in ${minutes} min`:`flapping · ${times.length} failures in ${minutes} min`};
   s.alerted.set(k,item);events.push(event(at,host,'attention',item));
  }
  for(const [k,a] of s.alerted){
   if(next.has(k))continue;if(looping(s.episodes.get(k)))s.loops.add(k);
   if(s.loops.has(k)&&s.episodes.has(k))continue;
   s.alerted.delete(k);s.loops.delete(k);events.push(event(at,host,'recovered',{kind:a.kind,title:a.title,severity:'ok'}));
  }
  return events;
 }
 function offline(host:string,at:number,afterMs:number=offlineAfterMs):AlertEvent[] {
  const s=get(host);const since=s.offlineSince??=at;
  if(s.offlineAlerted||!(afterMs>0)||at-since<afterMs)return [];
  s.offlineAlerted=true;return [event(at,host,'offline',{kind:'host',title:host,severity:'error',detail:`no successful collection for ${Math.round((at-since)/60000)} min`})];
 }
 const snapshot=():TrackerState=>Object.fromEntries([...hosts].filter(([,s])=>s.known).map(([name,s])=>[name,{active:[...s.alerted.values()],...(s.baseline.size?{baseline:[...s.baseline.values()]}:{}),offlineAlerted:s.offlineAlerted}]));
 return {online,offline,snapshot};
}

export interface NotifierOptions{url:unknown;authEnv?:string;env?:Record<string,string|undefined>;kinds?:string[];quietHours?:unknown;fetchImpl?:Fetch;sleep?:(ms:number)=>Promise<unknown>;retries?:number;backoffMs?:number[];timeoutMs?:number;maxQueue?:number;log?:Log}
// Posts Apprise-style JSON ({title, body, type, format}) to the relay. Delivery runs on its own queue with bounded
// retries, so collection never waits for it. During quiet hours alerts are held and sent as one summary afterwards.
export function createNotifier({url,authEnv,env=process.env,kinds=DEFAULT_ALERT_KINDS,quietHours,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),retries=3,backoffMs=[2000,10000,30000],timeoutMs=5000,maxQueue=100,log=()=>{}}:NotifierOptions) {
 const target=webhookUrl(url),quiet=parseQuietHours(quietHours),queue:Message[]=[],deferred=new Map<string,AlertEvent>(),stats={sent:0,failed:0,dropped:0};let running:Promise<void>|null=null;
 const alertable=(e:AlertEvent)=>e.type==='offline'||e.type==='online'||kinds.includes(e.kind);
 const clip=(s:string)=>s.length>3500?s.slice(0,3499)+'…':s;
 function format(e:AlertEvent):Message {
  const title=`${MESSAGE_PREFIX} ${e.host}: `;
  if(e.type==='attention')return {title:title+`${e.kind} needs attention`,body:e.title+(e.detail?` — ${e.detail}`:''),type:e.severity==='error'?'failure':e.severity==='notice'?'info':'warning'};
  if(e.type==='recovered')return {title:title+`${e.kind} recovered`,body:e.title,type:'success'};
  if(e.type==='offline')return {title:title+'collector unreachable',body:e.detail??'no successful collection',type:'failure'};
  return {title:title+'collector reachable again',body:'collection succeeded',type:'success'};
 }
 const describe=(e:AlertEvent)=>e.type==='offline'?`${e.host} collector unreachable`:e.type==='online'?`${e.host} collector reachable again`:`${e.host} ${e.kind} ${e.title} ${e.type==='attention'?'needs attention':'recovered'}`;
 function enqueue(message:Message) {
  queue.push({...message,body:clip(message.body),format:'text'});
  while(queue.length>maxQueue){queue.shift();stats.dropped++;}
  running??=Promise.resolve().then(drain).finally(()=>{running=null;});
 }
 async function send(message:Message) {
  const headers:Record<string,string>={'content-type':'application/json'},token=authEnv?env[authEnv]:undefined;if(token)headers.authorization='Bearer '+token;
  const response=await fetchImpl(target,{method:'POST',headers,body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  await response.body?.cancel?.();if(!response.ok)throw new Error('relay-status-'+response.status);
 }
 async function drain() {
  while(queue.length){const message=queue.shift()!;
   for(let attempt=1;;attempt++){try{await send(message);stats.sent++;break;}catch{if(attempt>=retries){stats.failed++;log('alert-delivery-failed');break;}await sleep(backoffMs[Math.min(attempt,backoffMs.length)-1]);}}
  }
 }
 function tick(at:number) {
  if(!deferred.size||inQuietHours(quiet,at))return;
  const lines=[...deferred.values()].map(e=>'- '+describe(e));deferred.clear();
  enqueue({title:`${MESSAGE_PREFIX} quiet hours summary`,body:lines.join('\n'),type:'info'});
 }
 function submit(events:AlertEvent[],at:number) {
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
// Each write re-reads the current file size, so a file removed or truncated outside the server is recreated instead of
// wedging rotation. Failures are reported once per streak with fixed strings that never carry paths or error text.
export function createHistory({dir,maxBytes=1048576,keep=500,log=()=>{}}:{dir?:string;maxBytes?:number;keep?:number;log?:Log}={}) {
 const file=dir?path.join(dir,'events.jsonl'):'',previous=dir?path.join(dir,'events.1.jsonl'):'';let events:AlertEvent[]=[],size=0,chain=Promise.resolve(),warned:string|null=null;
 const warn=(message:string)=>{if(warned!==message){warned=message;log(message);}};
 async function write(line:string,bytes:number) {
  const current=await fs.stat(file).catch((error:unknown)=>{if(errorCode(error)==='ENOENT')return null;throw error;});
  if(!current&&size>0)warn('host-monitor: history file missing; recreated');
  size=current?.size??0;
  if(size>0&&size+bytes>maxBytes){await fs.rename(file,previous).catch((error:unknown)=>{if(errorCode(error)!=='ENOENT')throw error;});size=0;}
  await fs.appendFile(file,line,{mode:0o600});size+=bytes;warned=null;
 }
 const project=(e:unknown):AlertEvent|null=>{if(!e||typeof e!=='object')return null;const r=e as Record<string,unknown>;const out={at:bounded(r.at,64),host:bounded(r.host,256),type:bounded(r.type,32),kind:bounded(r.kind,64),title:bounded(r.title),severity:bounded(r.severity,32),detail:bounded(r.detail)};
  if(!out.at||!Number.isFinite(Date.parse(out.at))||!out.host||!['attention','recovered','offline','online'].includes(out.type??'')||!out.kind||!out.title)return null;if(out.detail===undefined)delete out.detail;return out as AlertEvent;};
 async function load() {
  if(!dir)return;await fs.mkdir(dir,{recursive:true,mode:0o700});const lines:string[]=[];
  for(const f of [previous,file]){let text;try{text=await fs.readFile(f,'utf8');}catch{continue;}if(f===file)size=Buffer.byteLength(text);lines.push(...text.split('\n').filter(Boolean));}
  events=lines.flatMap(line=>{try{const e=project(JSON.parse(line));return e?[e]:[];}catch{return [];}}).slice(-keep);
 }
 function add(event:unknown) {
  const e=project(event);if(!e)return;events.push(e);if(events.length>keep)events.shift();if(!dir)return;
  const line=JSON.stringify(e)+'\n',bytes=Buffer.byteLength(line);
  chain=chain.then(()=>write(line,bytes)).catch(()=>warn('host-monitor: history write failed'));
 }
 const recent=({limit=100,host}:{limit?:number;host?:string}={})=>events.filter(e=>!host||e.host===host).slice(-limit).reverse();
 return {load,add,recent,flush:()=>chain};
}
