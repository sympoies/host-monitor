import {projectSnapshot} from './schema.ts';
import {createTracker,createNotifier,createHistory,webhookUrl,parseQuietHours,DEFAULT_ALERT_KINDS} from './alerts.ts';
import type {AlertEvent,NotifierOptions,TrackerState} from './alerts.ts';
import type {Snapshot} from './model.ts';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export type Runner=(file:string,args:string[],options:{timeout:number;maxBuffer:number;encoding:'utf8'})=>Promise<{stdout:string}>;
export interface HostEntry{name:string;ssh?:string;node:string;collector:string;config:string;importantServices?:unknown;refreshSeconds?:unknown;timeoutSeconds?:unknown}
export interface ServerConfig{hosts:HostEntry[];port?:number;refreshSeconds?:number;importantServices?:unknown;stateDir?:unknown;historyMaxBytes?:number;alerts?:unknown}
interface Host extends HostEntry{importantServices:string[];refreshSeconds:number;timeoutSeconds:number}
interface HostState{name:string;importantServices:string[];refreshSeconds:number;status:string;snapshot:Snapshot|null;lastAttempt:string|null;lastSuccess:string|null;error?:string}
const exec=promisify(execFile) as Runner,root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const assets=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
// Service-name substrings that the dashboard lists under its default "important services" filter.
function serviceMarkers(value:unknown=[]):string[]{if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!/^[a-zA-Z0-9_.:@-]{1,128}$/.test(v)))throw new Error('invalid-important-services');return [...value];}
const seconds=(value:unknown,fallback:unknown,min:number,max:number)=>{const v=value??fallback;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('invalid-hosts');return v;};
function alertOptions(value:unknown) {
 if(value===undefined)return null;
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('shape');
  const alerts=value as {webhookUrl?:unknown;authEnv?:unknown;kinds?:unknown;offlineAfterSeconds?:unknown;quietHours?:unknown};
  if(alerts.authEnv!==undefined&&(typeof alerts.authEnv!=='string'||!/^[A-Z_][A-Z0-9_]{0,63}$/.test(alerts.authEnv)))throw new Error('auth-env');
  if(alerts.kinds!==undefined&&(!Array.isArray(alerts.kinds)||alerts.kinds.length>32||alerts.kinds.some(k=>typeof k!=='string'||!/^[a-z]{1,32}$/.test(k))))throw new Error('kinds');
  const offlineAfterSeconds=alerts.offlineAfterSeconds??300;if(typeof offlineAfterSeconds!=='number'||!(offlineAfterSeconds>=0))throw new Error('offline');
  webhookUrl(alerts.webhookUrl);parseQuietHours(alerts.quietHours);
  return {webhookUrl:alerts.webhookUrl,authEnv:alerts.authEnv as string|undefined,kinds:(alerts.kinds as string[]|undefined)??DEFAULT_ALERT_KINDS,quietHours:alerts.quietHours,offlineAfterMs:offlineAfterSeconds*1000};
 }catch(error){throw new Error('invalid-alerts: '+(error as Error).message);}
}
export interface MonitorOptions{run?:Runner;now?:()=>number;fetch?:NotifierOptions['fetchImpl'];sleep?:NotifierOptions['sleep'];env?:Record<string,string|undefined>;log?:(message:string)=>void}
export function createMonitor(config:ServerConfig,{run=exec,now=()=>Date.now(),fetch:fetchImpl=fetch,sleep,env=process.env,log=message=>console.error(message)}:MonitorOptions={}) {
 const defaultRefresh=config.refreshSeconds??20;
 const hosts:Host[]=config.hosts.map(h=>({...h,importantServices:serviceMarkers(h.importantServices??config.importantServices),refreshSeconds:seconds(h.refreshSeconds,defaultRefresh,1,86400),timeoutSeconds:seconds(h.timeoutSeconds,30,0.001,600)}));
 if(!hosts.length||hosts.some(h=>!/^[-a-zA-Z0-9]+$/.test(h.name)))throw new Error('invalid-hosts');
 if(config.stateDir!==undefined&&(typeof config.stateDir!=='string'||!path.isAbsolute(config.stateDir)))throw new Error('invalid-state-dir');
 const stateDir=config.stateDir as string|undefined;
 const alerts=alertOptions(config.alerts);
 const state=new Map<string,HostState>(hosts.map(h=>[h.name,{name:h.name,importantServices:h.importantServices,refreshSeconds:h.refreshSeconds,status:'loading',snapshot:null,lastAttempt:null,lastSuccess:null}]));
 const history=createHistory({dir:stateDir,maxBytes:config.historyMaxBytes,log});
 const notifier=alerts&&createNotifier({url:alerts.webhookUrl,authEnv:alerts.authEnv,env,kinds:alerts.kinds,quietHours:alerts.quietHours,fetchImpl,...(sleep?{sleep}:{}),log});
 const stateFile=stateDir&&path.join(stateDir,'alert-state.json');
 let tracker=createTracker({offlineAfterMs:alerts?.offlineAfterMs??300000}),saving=Promise.resolve();
 // Saved attention state keeps a restart from re-announcing items that were already notified.
 const ready=(async()=>{try{await history.load();if(stateFile){const saved:unknown=JSON.parse(await fs.readFile(stateFile,'utf8').catch(()=>'{}'));tracker=createTracker({offlineAfterMs:alerts?.offlineAfterMs??300000,state:saved&&typeof saved==='object'?saved as TrackerState:{}});}}catch{log('host-monitor: state unavailable; starting without history');}})();
 function record(events:AlertEvent[]) {
  if(!events.length)return;for(const e of events)history.add(e);notifier?.submit(events,now());
  if(stateFile){const data=JSON.stringify(tracker.snapshot());saving=saving.then(async()=>{await fs.writeFile(stateFile+'.tmp',data,{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);}).catch(()=>log('host-monitor: alert state not saved'));}
 }
 const inflight=new Map<string,Promise<void>>(),timers=new Map<string,NodeJS.Timeout>();let stopped=false;
 async function collectHost(h:Host):Promise<Snapshot> {
  const args=h.ssh?['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',h.ssh,h.node,h.collector,'--config',h.config]:[h.collector,'--config',h.config];
  if(h.ssh && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(h.ssh) || [h.node,h.collector,h.config].some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_./-]+$/.test(x))))throw new Error('invalid-remote-command');
  const timeout=Math.ceil(h.timeoutSeconds*1000);let timer:NodeJS.Timeout|undefined;
  // The race bounds a runner that ignores its own timeout, so one hung host can only hold its own schedule.
  const output=await Promise.race([run(h.ssh?'ssh':h.node,args,{timeout,maxBuffer:8*1024*1024,encoding:'utf8'}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('collector-timeout')),timeout);})]).finally(()=>clearTimeout(timer));
  const snapshot=projectSnapshot(JSON.parse(output.stdout));if(snapshot.schemaVersion!==1||snapshot.host!==h.name||!Array.isArray(snapshot.services)||!Array.isArray(snapshot.attention)||!Number.isFinite(Date.parse(snapshot.collectedAt)))throw new Error('invalid-snapshot');
  return snapshot;
 }
 function refreshHost(name:string):Promise<void> {
  const h=hosts.find(h=>h.name===name);if(!h)return Promise.reject(new Error('unknown-host'));
  const pending=inflight.get(name);if(pending)return pending;
  const attempt=(async()=>{await ready;const old=state.get(name)!,at=new Date(now()).toISOString();
   try{const snapshot=await collectHost(h);state.set(name,{name,importantServices:h.importantServices,refreshSeconds:h.refreshSeconds,status:'online',snapshot,lastAttempt:at,lastSuccess:new Date(now()).toISOString()});record(tracker.online(name,snapshot.attention,now()));}
   catch{state.set(name,{...old,status:'offline',lastAttempt:at,error:'collector-unavailable'});record(tracker.offline(name,now()));}
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
  else if(url.pathname==='/api/fleet'){body=JSON.stringify({schemaVersion:1,serverTime:new Date(now()).toISOString(),refreshSeconds:defaultRefresh,hosts:[...state.values()].map(h=>({...h,stale:stale(h)}))});type='application/json';}
  else if(url.pathname==='/api/events'){
   const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100,host=url.searchParams.get('host')??undefined;
   if(!Number.isInteger(limit)||limit<1||limit>500||host!==undefined&&!state.has(host)){res.writeHead(400);res.end();return;}
   await ready;body=JSON.stringify({schemaVersion:1,events:history.recent({limit,host})});type='application/json';
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
