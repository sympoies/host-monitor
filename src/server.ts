import {projectSnapshot} from './schema.ts';
import {ADB_SCRIPT,adbSerial,adbBinary,androidSnapshot} from './android.ts';
import {createTracker,createNotifier,createHistory,webhookUrl,parseQuietHours,DEFAULT_ALERT_KINDS,DEFAULT_GRACE_MS,DEFAULT_RESTART_LOOP} from './alerts.ts';
import type {AlertEvent,NotifierOptions,TrackerState} from './alerts.ts';
import {createBeszelHub,hubUrl,hubSystemName} from './beszel.ts';
import type {HubFetch} from './beszel.ts';
import type {Attention,Disk,Snapshot} from './model.ts';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export type Runner=(file:string,args:string[],options:{timeout:number;maxBuffer:number;encoding:'utf8'})=>Promise<{stdout:string}>;
// A host is collected locally (node/collector/config), over SSH (ssh plus remote paths), or, for an Android device on the
// server's USB, over adb ({serial, bin?}); an adb host runs nothing on the device (fleet-infra decision 0003).
interface LogUnit{name:string;scope:'user'|'system'}
export interface HostEntry{name:string;ssh?:string;node?:string;collector?:string;config?:string;adb?:unknown;importantServices?:unknown;logUnits?:unknown;beszelName?:unknown;refreshSeconds?:unknown;timeoutSeconds?:unknown;offlineAfterSeconds?:unknown}
export interface ServerConfig{hosts:HostEntry[];hostOrder?:unknown;beszel?:unknown;port?:number;refreshSeconds?:number;importantServices?:unknown;stateDir?:unknown;historyMaxBytes?:number;alerts?:unknown}
interface Host extends HostEntry{importantServices:string[];logUnits:LogUnit[];refreshSeconds:number;timeoutSeconds:number;offlineAfterMs?:number}
// Disk capacity of a host whose resource metrics Beszel owns, read from the hub: `stale` is a record older than ten minutes,
// `unavailable` a failed read, which keeps the last disks and times so the dashboard can say how old they are.
interface BeszelState{status:'ok'|'stale'|'unavailable';lastSuccess:string|null;recordedAt:string|null;disks:Disk[]}
const BESZEL_STALE_MS=10*60*1000;
interface HostState{name:string;importantServices:string[];logUnits:LogUnit[];refreshSeconds:number;status:string;snapshot:Snapshot|null;lastAttempt:string|null;lastSuccess:string|null;error?:string}
// systemd NRestarts counters by service name; a name present in both scopes adds both counters.
function restartCounts(snapshot:Snapshot):Record<string,number> {
 const counts:Record<string,number>={};for(const s of snapshot.services)if(typeof s.restarts==='number'&&s.manager!=='launchd')counts[s.name]=(counts[s.name]??0)+s.restarts;return counts;
}
const exec=promisify(execFile) as Runner,root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const assets=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/order.js',['order.js','text/javascript']],['/style.css',['style.css','text/css']]]);
// Service-name substrings that the dashboard lists under its default "important services" filter.
function serviceMarkers(value:unknown=[]):string[]{if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!/^[a-zA-Z0-9_.:@-]{1,128}$/.test(v)))throw new Error('invalid-important-services');return [...value];}
// Only locally collected Linux units may expose a journal tail. The configured exact names, never a browser value,
// are the command's unit arguments. No messages enter snapshots or persistent event state.
function logUnits(value:unknown=[]):LogUnit[]{
 if(!Array.isArray(value)||value.length>100||value.some(v=>!v||typeof v!=='object'||Array.isArray(v)||
  !['user','system'].includes((v as LogUnit).scope)||typeof (v as LogUnit).name!=='string'||
  !/^[A-Za-z0-9][A-Za-z0-9@._-]{0,126}\.service$/.test((v as LogUnit).name)))throw new Error('invalid-log-units');
 const units=value as LogUnit[];if(new Set(units.map(v=>v.name)).size!==units.length)throw new Error('invalid-log-units');
 return units.map(v=>({scope:v.scope,name:v.name}));
}
const seconds=(value:unknown,fallback:unknown,min:number,max:number)=>{const v=value??fallback;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('invalid-hosts');return v;};
function beszelOptions(value:unknown) {
 if(value===undefined)return null;
 try{
  const b=value as {url?:unknown;emailEnv?:unknown;passwordEnv?:unknown};
  if(!b||typeof b!=='object'||Array.isArray(b))throw new Error('shape');
  for(const env of [b.emailEnv,b.passwordEnv])if(typeof env!=='string'||!/^[A-Z_][A-Z0-9_]{0,63}$/.test(env))throw new Error('env');
  return {url:hubUrl(b.url),emailEnv:b.emailEnv as string,passwordEnv:b.passwordEnv as string};
 }catch(error){throw new Error('invalid-beszel: '+(error as Error).message);}
}
interface GraceOverride{host?:string;kind:string;title:string;graceMs:number}
const graceSeconds=(v:unknown)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>3600)throw new Error('grace');return v*1000;};
// The grace window and restart-loop rule apply to every attention item; overrides match one item by kind and title.
function graceOptions(alerts:{graceSeconds?:unknown;restartLoop?:unknown;graceOverrides?:unknown},hostNames:string[]) {
 const loop=alerts.restartLoop as {restarts?:unknown;windowSeconds?:unknown}|undefined;
 // restarts 0 disables the rule; one restart is never a loop.
 if(loop!==undefined&&(!loop||typeof loop!=='object'||!Number.isInteger(loop.restarts)||loop.restarts!==0&&!((loop.restarts as number)>=2&&(loop.restarts as number)<=100)||typeof loop.windowSeconds!=='number'||!(loop.windowSeconds>=60&&loop.windowSeconds<=86400)))throw new Error('restart-loop');
 const overrides=alerts.graceOverrides??[];
 if(!Array.isArray(overrides)||overrides.length>100)throw new Error('grace-overrides');
 const parsed:GraceOverride[]=overrides.map((o:{host?:unknown;kind?:unknown;title?:unknown;graceSeconds?:unknown})=>{
  if(!o||typeof o!=='object'||o.host!==undefined&&!hostNames.includes(o.host as string)||typeof o.kind!=='string'||!/^[a-z]{1,32}$/.test(o.kind)||typeof o.title!=='string'||!o.title||o.title.length>512)throw new Error('grace-overrides');
  return {...(o.host!==undefined?{host:o.host as string}:{}),kind:o.kind,title:o.title,graceMs:graceSeconds(o.graceSeconds)};
 });
 const graceMs=alerts.graceSeconds===undefined?DEFAULT_GRACE_MS:graceSeconds(alerts.graceSeconds);
 return {graceMs:(host:string,a:Attention)=>parsed.find(o=>(o.host===undefined||o.host===host)&&o.kind===a.kind&&o.title===a.title)?.graceMs??graceMs,
  restartLoop:loop?{restarts:loop.restarts as number,windowMs:(loop.windowSeconds as number)*1000}:DEFAULT_RESTART_LOOP};
}
function alertOptions(value:unknown,hostNames:string[]) {
 if(value===undefined)return null;
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('shape');
  const alerts=value as {webhookUrl?:unknown;authEnv?:unknown;kinds?:unknown;offlineAfterSeconds?:unknown;quietHours?:unknown;graceSeconds?:unknown;restartLoop?:unknown;graceOverrides?:unknown};
  if(alerts.authEnv!==undefined&&(typeof alerts.authEnv!=='string'||!/^[A-Z_][A-Z0-9_]{0,63}$/.test(alerts.authEnv)))throw new Error('auth-env');
  if(alerts.kinds!==undefined&&(!Array.isArray(alerts.kinds)||alerts.kinds.length>32||alerts.kinds.some(k=>typeof k!=='string'||!/^[a-z]{1,32}$/.test(k))))throw new Error('kinds');
  const offlineAfterSeconds=alerts.offlineAfterSeconds??300;if(typeof offlineAfterSeconds!=='number'||!(offlineAfterSeconds>=0))throw new Error('offline');
  webhookUrl(alerts.webhookUrl);parseQuietHours(alerts.quietHours);
  return {webhookUrl:alerts.webhookUrl,authEnv:alerts.authEnv as string|undefined,kinds:(alerts.kinds as string[]|undefined)??DEFAULT_ALERT_KINDS,quietHours:alerts.quietHours,offlineAfterMs:offlineAfterSeconds*1000,...graceOptions(alerts,hostNames)};
 }catch(error){throw new Error('invalid-alerts: '+(error as Error).message);}
}
export interface MonitorOptions{run?:Runner;now?:()=>number;fetch?:NotifierOptions['fetchImpl'];sleep?:NotifierOptions['sleep'];env?:Record<string,string|undefined>;log?:(message:string)=>void}
export function createMonitor(config:ServerConfig,{run=exec,now=()=>Date.now(),fetch:fetchImpl=fetch,sleep,env=process.env,log=message=>console.error(message)}:MonitorOptions={}) {
 const defaultRefresh=config.refreshSeconds??20;
 const hosts:Host[]=config.hosts.map(h=>({...h,importantServices:serviceMarkers(h.importantServices??config.importantServices),logUnits:logUnits(h.logUnits),refreshSeconds:seconds(h.refreshSeconds,defaultRefresh,1,86400),timeoutSeconds:seconds(h.timeoutSeconds,30,0.001,600),...(h.offlineAfterSeconds===undefined?{}:{offlineAfterMs:seconds(h.offlineAfterSeconds,0,0,31536000)*1000})}));
 if(!hosts.length||hosts.some(h=>!/^[-a-zA-Z0-9]+$/.test(h.name)))throw new Error('invalid-hosts');
 if(hosts.some(h=>h.beszelName!==undefined&&!hubSystemName(h.beszelName)))throw new Error('invalid-hosts');
 if(hosts.some(h=>h.logUnits.length>0&&(h.ssh!==undefined||h.adb!==undefined)))throw new Error('invalid-log-units');
 if(config.stateDir!==undefined&&(typeof config.stateDir!=='string'||!path.isAbsolute(config.stateDir)))throw new Error('invalid-state-dir');
 const stateDir=config.stateDir as string|undefined;
 const alerts=alertOptions(config.alerts,hosts.map(h=>h.name));
 const state=new Map<string,HostState>(hosts.map(h=>[h.name,{name:h.name,importantServices:h.importantServices,logUnits:h.logUnits,refreshSeconds:h.refreshSeconds,status:'loading',snapshot:null,lastAttempt:null,lastSuccess:null}]));
 // The default dashboard order: the listed hosts first, then the rest in configuration order. Viewers may override it per browser.
 const hostOrder=config.hostOrder??[];
 if(!Array.isArray(hostOrder)||hostOrder.length>100||hostOrder.some(n=>!hosts.some(h=>h.name===n))||new Set(hostOrder).size!==hostOrder.length)throw new Error('invalid-host-order');
 const defaultOrder=[...(hostOrder as string[]),...hosts.map(h=>h.name).filter(n=>!hostOrder.includes(n))];
 const beszelConfig=beszelOptions(config.beszel);
 const hub=beszelConfig&&createBeszelHub({url:beszelConfig.url,email:()=>env[beszelConfig.emailEnv],password:()=>env[beszelConfig.passwordEnv],fetchImpl:fetchImpl as unknown as HubFetch});
 const beszel=new Map<string,BeszelState>();
 const history=createHistory({dir:stateDir,maxBytes:config.historyMaxBytes,log});
 const notifier=alerts&&createNotifier({url:alerts.webhookUrl,authEnv:alerts.authEnv,env,kinds:alerts.kinds,quietHours:alerts.quietHours,fetchImpl,...(sleep?{sleep}:{}),log});
 const stateFile=stateDir&&path.join(stateDir,'alert-state.json');
 const trackerOptions={offlineAfterMs:alerts?.offlineAfterMs??300000,...(alerts?{graceMs:alerts.graceMs,restartLoop:alerts.restartLoop}:{})};
 let tracker=createTracker(trackerOptions),savedState='',saving=Promise.resolve(),activeLogReads=0;
 // Saved attention state keeps a restart from re-announcing items that were already notified.
 const ready=(async()=>{try{await history.load();if(stateFile){const saved:unknown=JSON.parse(await fs.readFile(stateFile,'utf8').catch(()=>'{}'));tracker=createTracker({...trackerOptions,state:saved&&typeof saved==='object'?saved as TrackerState:{}});}}catch{log('host-monitor: state unavailable; starting without history');}})();
 function record(events:AlertEvent[]) {
  for(const e of events)history.add(e);if(events.length)notifier?.submit(events,now());
  // A baseline item can clear without an event, so the state is saved whenever it changes.
  const data=JSON.stringify(tracker.snapshot());if(data===savedState)return;savedState=data;
  if(stateFile){saving=saving.then(async()=>{await fs.writeFile(stateFile+'.tmp',data,{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);}).catch(()=>log('host-monitor: alert state not saved'));}
 }
 const inflight=new Map<string,Promise<void>>(),timers=new Map<string,NodeJS.Timeout>();let stopped=false;
 async function execute(h:Host,file:string,args:string[]) {
  const timeout=Math.ceil(h.timeoutSeconds*1000);let timer:NodeJS.Timeout|undefined;
  // The race bounds a runner that ignores its own timeout, so one hung host can only hold its own schedule.
  return (await Promise.race([run(file,args,{timeout,maxBuffer:8*1024*1024,encoding:'utf8'}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('collector-timeout')),timeout);})]).finally(()=>clearTimeout(timer))).stdout;
 }
 async function collectHost(h:Host):Promise<Snapshot> {
  let snapshot:Snapshot;
  if(h.adb!==undefined){
   const adb=h.adb as {serial?:unknown;bin?:unknown}|null;
   // On another host the adb call crosses an ssh command line: the alias is allowlisted, adb must be an absolute path
   // (a non-interactive remote shell has a minimal PATH), and the script is passed as one single-quoted word.
   const remote=h.ssh!==undefined;
   if(!adb||typeof adb!=='object'||!adbSerial(adb.serial)||adb.bin!==undefined&&!adbBinary(adb.bin)||
    remote&&(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(h.ssh!)||typeof adb.bin!=='string'||!adb.bin.startsWith('/')))throw new Error('invalid-adb-command');
   const bin=(adb.bin as string|undefined)??'adb';
   const output=remote?await execute(h,'ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',h.ssh!,bin,'-s',adb.serial,'shell',"'"+ADB_SCRIPT.replaceAll("'","'\\''")+"'"]):await execute(h,bin,['-s',adb.serial,'shell',ADB_SCRIPT]);
   snapshot=projectSnapshot(androidSnapshot(h.name,output,now()));
  }else{
   const {node,collector,config}=h;
   // Remote arguments cross an ssh command line, so they are allowlisted; local paths only need to be present.
   if(h.ssh!==undefined?!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(h.ssh)||[node,collector,config].some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_./-]+$/.test(x)):[node,collector,config].some(x=>typeof x!=='string'))throw new Error('invalid-remote-command');
   const args=h.ssh?['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',h.ssh,node!,collector!,'--config',config!]:[collector!,'--config',config!];
   snapshot=projectSnapshot(JSON.parse(await execute(h,h.ssh?'ssh':node!,args)));
  }
  if(snapshot.schemaVersion!==1||snapshot.host!==h.name||!Array.isArray(snapshot.services)||!Array.isArray(snapshot.attention)||!Number.isFinite(Date.parse(snapshot.collectedAt)))throw new Error('invalid-snapshot');
  return snapshot;
 }
 // A hub failure never changes the host's own status: the card says Beszel is unavailable and keeps the last disks.
 // A reading ages while the hub is not read again, so staleness is decided when the fleet is served.
 const beszelView=(b:BeszelState):BeszelState=>b.status==='ok'&&b.recordedAt&&now()-Date.parse(b.recordedAt)>BESZEL_STALE_MS?{...b,status:'stale'}:b;
 async function readBeszel(h:Host) {
  const previous=beszel.get(h.name);
  try{const read=await hub!.read(typeof h.beszelName==='string'?h.beszelName:h.name),at=now();
   beszel.set(h.name,{status:'ok',lastSuccess:new Date(at).toISOString(),recordedAt:read.recordedAt,disks:read.disks});}
  catch{beszel.set(h.name,{status:'unavailable',lastSuccess:previous?.lastSuccess??null,recordedAt:previous?.recordedAt??null,disks:previous?.disks??[]});}
 }
 function refreshHost(name:string):Promise<void> {
  const h=hosts.find(h=>h.name===name);if(!h)return Promise.reject(new Error('unknown-host'));
  const pending=inflight.get(name);if(pending)return pending;
  const attempt=(async()=>{await ready;const old=state.get(name)!,at=new Date(now()).toISOString();
   try{const snapshot=await collectHost(h);state.set(name,{name,importantServices:h.importantServices,logUnits:h.logUnits,refreshSeconds:h.refreshSeconds,status:'online',snapshot,lastAttempt:at,lastSuccess:new Date(now()).toISOString()});record(tracker.online(name,snapshot.attention,now(),restartCounts(snapshot)));
    if(hub&&snapshot.resources==='external')await readBeszel(h);}
   catch{state.set(name,{...old,status:'offline',lastAttempt:at,error:'collector-unavailable'});
    // A detached adb device is an expected state, like a sleeping laptop: it raises an offline alert only when its host
    // entry sets its own offlineAfterSeconds, which catches a broken collection path that outlasts any unplugged spell.
    if(h.adb===undefined||h.offlineAfterMs!==undefined)record(tracker.offline(name,now(),h.offlineAfterMs));}
   notifier?.tick(now());
  })().finally(()=>inflight.delete(name));
  inflight.set(name,attempt);return attempt;
 }
 const refresh=async()=>{await Promise.all(hosts.map(h=>refreshHost(h.name)));};
 // Each host runs its own loop: the next collection is scheduled only after that host's previous one settles.
 function schedule(h:Host){if(stopped)return;void refreshHost(h.name).finally(()=>{if(!stopped)timers.set(h.name,setTimeout(()=>schedule(h),Math.max(5,h.refreshSeconds)*1000));});}
 // A snapshot is stale after three missed refresh intervals of its host, or when it claims to be from the future.
 const stale=(h:HostState)=>!h.lastSuccess||!h.snapshot||now()-Date.parse(h.snapshot.collectedAt)>3*h.refreshSeconds*1000||Date.parse(h.snapshot.collectedAt)-now()>30000;
 async function handle(req:http.IncomingMessage,res:http.ServerResponse){res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  let url:URL,body:string|Buffer,type:string;try{url=new URL(req.url??'','http://localhost');}catch{res.writeHead(400);res.end();return;}
  if(url.pathname==='/healthz'){body=JSON.stringify({ok:true,service:'host-monitor'});type='application/json';}
  else if(url.pathname==='/api/fleet'){body=JSON.stringify({schemaVersion:1,serverTime:new Date(now()).toISOString(),refreshSeconds:defaultRefresh,defaultOrder,hosts:[...state.values()].map(h=>({...h,stale:stale(h),...(beszel.has(h.name)?{beszel:beszelView(beszel.get(h.name)!)}:{})}))});type='application/json';}
  else if(url.pathname==='/api/events'){
   const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100,host=url.searchParams.get('host')??undefined;
   if(!Number.isInteger(limit)||limit<1||limit>500||host!==undefined&&!state.has(host)){res.writeHead(400);res.end();return;}
   await ready;body=JSON.stringify({schemaVersion:1,events:history.recent({limit,host})});type='application/json';
  }
  else if(url.pathname==='/api/logs'){
   if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end();return;}
   const hostNames=url.searchParams.getAll('host'),unitNames=url.searchParams.getAll('unit');
   if(hostNames.length!==1||unitNames.length!==1||[...url.searchParams.keys()].some(k=>k!=='host'&&k!=='unit')){res.writeHead(400);res.end();return;}
   const host=hosts.find(h=>h.name===hostNames[0]),unit=host?.logUnits.find(u=>u.name===unitNames[0]);
   if(!host||!unit){res.writeHead(404);res.end();return;}
   const current=state.get(host.name)!;
   if(current.status!=='online'||stale(current)||current.snapshot?.platform!=='linux'||
    !current.snapshot.services.some(s=>s.name===unit.name&&s.scope===unit.scope)){
    res.writeHead(503);res.end();return;
   }
   if(activeLogReads>=2){res.writeHead(429);res.end();return;}
   activeLogReads++;
   try{
    const args=[unit.scope==='user'?'--user':'--system','--unit',unit.name,'--lines','120','--no-pager','--output=short-iso','--quiet'];
    const text=(await run('journalctl',args,{timeout:5000,maxBuffer:256*1024,encoding:'utf8'})).stdout;
    if(Buffer.byteLength(text)>256*1024)throw new Error('oversized-journal');
    body=JSON.stringify({schemaVersion:1,host:host.name,unit:unit.name,text});type='application/json';
   }catch{res.writeHead(502);res.end();return;}
   finally{activeLogReads--;}
  }
  else if(assets.has(url.pathname)){const [file,mime]=assets.get(url.pathname)!;try{body=await fs.readFile(path.join(root,file));type=mime;}catch{res.writeHead(503);res.end();return;}}
  else{res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:body);
 }
 // A handler failure answers 500; it must never become an unhandled rejection that stops the server.
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 return {server,refresh,refreshHost,start:()=>{stopped=false;for(const h of hosts)schedule(h);},stop:()=>{stopped=true;for(const t of timers.values())clearTimeout(t);timers.clear();},
  idle:async()=>{await Promise.all([...inflight.values()]);await notifier?.idle();await history.flush();await saving;}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await fs.realpath(process.argv[1]).catch(()=>process.argv[1])).href){const at=process.argv.indexOf('--config'),file=at<0?undefined:process.argv[at+1];if(!file){console.error('usage: node src/server.ts --config <server-config.json>');process.exit(64);}const config=JSON.parse(await fs.readFile(file,'utf8')) as ServerConfig;const monitor=createMonitor(config);monitor.server.listen(config.port??9105,'127.0.0.1',()=>{monitor.start();console.log('host-monitor listening on loopback');});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{monitor.stop();monitor.server.close(()=>process.exit(0));});}
