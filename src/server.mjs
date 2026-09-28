import {projectSnapshot} from './schema.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const assets=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
// Service-name substrings that the dashboard lists under its default "important services" filter.
function serviceMarkers(value=[]){if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!/^[a-zA-Z0-9_.:@-]{1,128}$/.test(v)))throw new Error('invalid-important-services');return [...value];}
export function createMonitor(config,{run=exec,now=()=>Date.now()}={}) {
 const hosts=config.hosts.map(h=>({...h,importantServices:serviceMarkers(h.importantServices??config.importantServices)}));if(!hosts.length||hosts.some(h=>!/^[-a-zA-Z0-9]+$/.test(h.name)))throw new Error('invalid-hosts');
 const state=new Map(hosts.map(h=>[h.name,{name:h.name,importantServices:h.importantServices,status:'loading',snapshot:null,lastAttempt:null,lastSuccess:null}]));
 let refreshing=false,timer;
 async function refresh(){if(refreshing)return;refreshing=true;try{await Promise.all(hosts.map(async h=>{const old=state.get(h.name);const attempt=new Date(now()).toISOString();try{
  const args=h.ssh?['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',h.ssh,h.node,h.collector,'--config',h.config]:[h.collector,'--config',h.config];
  if(h.ssh && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(h.ssh) || [h.node,h.collector,h.config].some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_./-]+$/.test(x))))throw new Error('invalid-remote-command');
  const output=await run(h.ssh?'ssh':h.node,args,{timeout:30000,maxBuffer:8*1024*1024,encoding:'utf8'});const snapshot=projectSnapshot(JSON.parse(output.stdout));if(snapshot.schemaVersion!==1||snapshot.host!==h.name||!Array.isArray(snapshot.services)||!Array.isArray(snapshot.attention)||!Number.isFinite(Date.parse(snapshot.collectedAt)))throw new Error('invalid-snapshot');
  state.set(h.name,{name:h.name,importantServices:h.importantServices,status:'online',snapshot,lastAttempt:attempt,lastSuccess:new Date(now()).toISOString()});
 }catch{state.set(h.name,{...old,status:'offline',lastAttempt:attempt,error:'collector-unavailable'});}}));}finally{refreshing=false;}}
 async function handle(req,res){res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  let url,body,type;try{url=new URL(req.url,'http://localhost');}catch{res.writeHead(400);res.end();return;}
  if(url.pathname==='/healthz'){body=JSON.stringify({ok:true,service:'host-monitor'});type='application/json';}
  else if(url.pathname==='/api/fleet'){body=JSON.stringify({schemaVersion:1,serverTime:new Date(now()).toISOString(),refreshSeconds:config.refreshSeconds??20,hosts:[...state.values()].map(h=>({...h,stale:!h.lastSuccess||!h.snapshot||now()-Date.parse(h.snapshot.collectedAt)>60000||Date.parse(h.snapshot.collectedAt)-now()>30000}))});type='application/json';}
  else if(assets.has(url.pathname)){const [file,mime]=assets.get(url.pathname);try{body=await fs.readFile(path.join(root,file));type=mime;}catch{res.writeHead(503);res.end();return;}}
  else{res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:body);
 }
 // A handler failure answers 500; it must never become an unhandled rejection that stops the server.
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 return {server,refresh,start:()=>{void refresh();timer=setInterval(()=>void refresh(),Math.max(5,config.refreshSeconds??20)*1000);},stop:()=>clearInterval(timer)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const at=process.argv.indexOf('--config');if(at<0)throw new Error('server config required');const config=JSON.parse(await fs.readFile(process.argv[at+1],'utf8'));const monitor=createMonitor(config);monitor.server.listen(config.port??9105,'127.0.0.1',()=>{monitor.start();console.log('host-monitor listening on loopback');});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{monitor.stop();monitor.server.close(()=>process.exit(0));});}
