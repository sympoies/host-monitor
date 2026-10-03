import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';

export type SessionPhase='working'|'waiting'|'idle'|'needs_input'|'unknown';
export interface AgentSession {
 agent:string;status:'running';phase:SessionPhase;title?:string;repoName?:string;label?:string;role?:string;
 createdAt?:string;updatedAt?:string;lastActivityAt?:string;phaseChangedAt?:string;
 account?:string;selectedAccount?:string;accountState?:string;unreadMessageCount?:number;
 mode?:string;coordinationMode?:string;resumable?:boolean;lineageDepth?:number;
}
export interface SessionInventory {status:'ok'|'unknown'|'disabled';sessions:AgentSession[]}
interface LabelMatch {role?:string;coordinationMode?:string;repoName?:string;titlePrefix?:string;titleContains?:string;cwdPrefix?:string;cwd?:string;root?:boolean}
export interface LabelRule {label:string;match:LabelMatch}
export type SessionConfig=false|{bin?:string;labelRules?:unknown};
export type SessionRunner=(bin:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<string>;
const exec=promisify(execFile),maxBuffer=2*1024*1024;
const unknown=():SessionInventory=>({status:'unknown',sessions:[]});
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max=512)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)?v:undefined;
const date=(v:unknown)=>text(v,64)&&Number.isFinite(Date.parse(v as string))?v as string:undefined;
const count=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0?v as number:undefined;
const phase=(v:unknown):SessionPhase=>['working','waiting','idle','needs_input','unknown'].includes(v as string)?v as SessionPhase:'unknown';

/** Rules are private collector configuration. All selectors must match; first matching rule wins. */
export function labelRules(value:unknown,home=os.homedir()):LabelRule[] {
 if(value===undefined)return [];
 const keys=['role','coordinationMode','repoName','titlePrefix','titleContains','cwdPrefix','cwd','root'];
 if(!Array.isArray(value)||value.length>64)throw Error('invalid-session-label-rules');
 return value.map(value=>{
  const row=obj(value),match=obj(row.match);
  if(!text(row.label,128)||Object.keys(row).some(k=>!['label','match'].includes(k))||!Object.keys(match).length||Object.entries(match).some(([k,v])=>!keys.includes(k)||(k==='root'?typeof v!=='boolean':!text(v,1024))))throw Error('invalid-session-label-rules');
  const normalized={...match};for(const key of ['cwd','cwdPrefix']){const value=normalized[key];if(typeof value==='string'&&value.startsWith('~/'))normalized[key]=path.join(home,value.slice(2));}
  return {label:row.label as string,match:normalized as LabelMatch};
 });
}
function label(row:Record<string,unknown>,rules:LabelRule[]):string|undefined {
 const lineage=obj(row.lineage),root=lineage.depth===0&&lineage.parent===null?true:typeof lineage.depth==='number'&&lineage.depth>0&&lineage.parent!=null?false:undefined;
 return rules.find(({match:m})=>
  (m.root===undefined||root===m.root)&&
  (m.cwd===undefined||row.cwd===m.cwd)&&
  (m.role===undefined||row.role===m.role)&&
  (m.coordinationMode===undefined||row.coordination_mode===m.coordinationMode)&&
  (m.repoName===undefined||row.repo_name===m.repoName)&&
  (m.titlePrefix===undefined||typeof row.title==='string'&&row.title.startsWith(m.titlePrefix))&&
  (m.titleContains===undefined||typeof row.title==='string'&&row.title.includes(m.titleContains))&&
  (m.cwdPrefix===undefined||typeof row.cwd==='string'&&(row.cwd===m.cwdPrefix||row.cwd.startsWith(m.cwdPrefix.replace(/\/$/,'')+'/')))
 )?.label;
}
/** Independent safe intake for both CLI projection and the server's snapshot boundary. */
function session(value:unknown):AgentSession {
 const row=obj(value);
 if(!text(row.agent,64)||row.status!=='running')throw Error('invalid-session');
 const out:AgentSession={agent:row.agent as string,status:'running',phase:phase(row.phase)};
 for(const key of ['title','repoName','label','role','account','selectedAccount','accountState','mode','coordinationMode'] as const){const v=text(row[key],key==='title'?512:128);if(v!==undefined)out[key]=v;}
 for(const key of ['createdAt','updatedAt','lastActivityAt','phaseChangedAt'] as const){const v=date(row[key]);if(v!==undefined)out[key]=v;}
 for(const key of ['unreadMessageCount','lineageDepth'] as const){const v=count(row[key]);if(v!==undefined)out[key]=v;}
 if(typeof row.resumable==='boolean')out.resumable=row.resumable;
 return out;
}
export function projectSessions(value:unknown):SessionInventory {
 const row=obj(value);
 if(row.status==='disabled')return {status:'disabled',sessions:[]};
 if(row.status!=='ok'||!Array.isArray(row.sessions)||row.sessions.length>5000)return unknown();
 try{return {status:'ok',sessions:row.sessions.map(session)};}catch{return unknown();}
}
export function parseSessionList(output:string,rules:LabelRule[]=[]):SessionInventory {
 if(Buffer.byteLength(output)>maxBuffer)throw Error('session-output-limit');
 const envelope=obj(JSON.parse(output));
 if(envelope.schema_version!=='cli.agent-session.list.v1'||envelope.ok!==true||!Array.isArray(envelope.data)||envelope.data.length>5000)throw Error('invalid-session-list');
 const sessions:AgentSession[]=[];
 for(const value of envelope.data){
  const row=obj(value);
  if(!['running','stopped'].includes(row.status as string)||!text(row.agent,64))throw Error('invalid-session-list');
  if(row.status!=='running')continue;
  const turn=obj(row.turn_state),account=obj(row.agent==='claude'?row.claude_account:row.codex_account);
  sessions.push(session({agent:row.agent,status:'running',phase:turn.schema_version==='agent-session.turn-state.v1'?turn.phase:'unknown',
   title:row.title,repoName:row.repo_name,label:label(row,rules),role:row.role,
   createdAt:row.created_at,updatedAt:row.updated_at,lastActivityAt:row.last_terminal_activity_at,phaseChangedAt:turn.phase_changed_at,
   account:row.agent==='claude'&&account.state==='bound'?account.selected_account:account.effective_account,
   selectedAccount:account.selected_account,accountState:account.state,unreadMessageCount:row.unread_message_count,
   mode:row.mode,coordinationMode:row.coordination_mode,resumable:row.resumable,lineageDepth:obj(row.lineage).depth,
  }));
 }
 return {status:'ok',sessions};
}
export async function collectSessions(config:SessionConfig={},run:SessionRunner=async(bin,args,options)=>(await exec(bin,args,{...options,encoding:'utf8',killSignal:'SIGKILL'})).stdout):Promise<SessionInventory> {
 if(config===false)return {status:'disabled',sessions:[]};
 // Bad configuration and command failures both preserve uncertainty without exporting diagnostics.
 try{
  if(!config||typeof config!=='object'||Array.isArray(config)||config.bin!==undefined&&(typeof config.bin!=='string'||!path.isAbsolute(config.bin)))return unknown();
  const rules=labelRules(config.labelRules);
  return parseSessionList(await run(config.bin??'agent-session',['list','--format','json'],{timeout:5000,maxBuffer}),rules);
 }catch{return unknown();}
}
