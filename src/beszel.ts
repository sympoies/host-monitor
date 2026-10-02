import {webhookUrl} from './alerts.ts';
import type {Disk} from './model.ts';
// Read-only client for a Beszel hub (PocketBase API). Beszel stays the single source for resource metrics of the hosts
// that delegate them; this module only reads the latest stats record to show their disk capacity.
export type HubFetch=(input:URL,init:RequestInit)=>Promise<Pick<Response,'ok'|'status'|'json'>>;
export interface HubDisks{recordedAt:string;disks:Disk[]}
const GIB=2**30,tenth=(n:number)=>Math.round(n*10)/10;
const entry=(mount:string,type:string,v:unknown):Disk|null=>{
 const e=v as {d?:unknown;du?:unknown}|null;
 if(!e||typeof e!=='object'||typeof e.d!=='number'||typeof e.du!=='number'||!(e.d>0)||!(e.du>=0)||e.du>e.d)return null;
 const total=Math.round(e.d*GIB),used=Math.round(e.du*GIB);
 return {source:'Beszel',type,mount,total,used,available:total-used,percent:tenth(used/total*100)};
};
// Beszel reports sizes in GiB: `d`/`du` for the root disk and `efs` for each extra filesystem, keyed by display name.
export function parseBeszelStats(stats:unknown):Disk[] {
 const s=(stats&&typeof stats==='object'?stats:{}) as {efs?:unknown};
 const extra=s.efs&&typeof s.efs==='object'?Object.entries(s.efs).sort(([a],[b])=>a.localeCompare(b)):[];
 return [entry('/','root',s),...extra.map(([name,v])=>entry(name,'extra',v))].filter((d):d is Disk=>d!==null);
}
export function hubUrl(value:unknown):URL {
 const u=webhookUrl(value);if(u.pathname!=='/'||u.hash)throw new Error('invalid-beszel-url');return u;
}
export const hubSystemName=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(v);
export interface HubOptions{url:URL;email:()=>string|undefined;password:()=>string|undefined;fetchImpl?:HubFetch;timeoutMs?:number}
export function createBeszelHub({url,email,password,fetchImpl=fetch as HubFetch,timeoutMs=5000}:HubOptions) {
 let token:string|undefined;const ids=new Map<string,string>();
 const send=(path:string,init:RequestInit)=>fetchImpl(new URL(path,url),{...init,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 async function login() {
  const identity=email(),secret=password();if(!identity||!secret)throw new Error('beszel-credentials');
  const response=await send('/api/collections/users/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity,password:secret})});
  const body=await response.json() as {token?:unknown};if(!response.ok||typeof body.token!=='string'||!body.token)throw new Error('beszel-auth');
  return token=body.token;
 }
 // A rejected session token is replaced once; any other failure is the caller's to report as unavailable.
 async function get(path:string):Promise<{items?:unknown}> {
  for(const retry of [true,false]){
   const response=await send(path,{method:'GET',headers:{Authorization:token??await login()}});
   if(response.status===401||response.status===403){token=undefined;if(retry)continue;}
   if(!response.ok)throw new Error('beszel-request');
   return await response.json() as {items?:unknown};
  }
  throw new Error('beszel-request');
 }
 const query=(params:Record<string,string>)=>'?'+new URLSearchParams(params);
 async function systemId(name:string) {
  const known=ids.get(name);if(known)return known;
  const items=(await get('/api/collections/systems/records'+query({filter:`name~'${name}'`,perPage:'50',fields:'id,name'}))).items;
  const match=(Array.isArray(items)?items:[]).find((i:{id?:unknown;name?:unknown})=>typeof i?.name==='string'&&i.name.toLowerCase()===name.toLowerCase()&&typeof i.id==='string'&&/^[A-Za-z0-9]{1,32}$/.test(i.id)) as {id:string}|undefined;
  if(!match)throw new Error('beszel-unknown-system');
  ids.set(name,match.id);return match.id;
 }
 return {async read(system:string):Promise<HubDisks> {
  const id=await systemId(system);
  // A system deleted and re-added in the hub gets a new id, so a failed read looks the name up again next time.
  try{return await readStats(id);}catch(error){ids.delete(system);throw error;}
 }};
 async function readStats(id:string):Promise<HubDisks> {
  const items=(await get('/api/collections/system_stats/records'+query({filter:`system='${id}'&&type='1m'`,sort:'-created',perPage:'1',fields:'created,stats'}))).items;
  const record=Array.isArray(items)?items[0] as {created?:unknown;stats?:unknown}|undefined:undefined;
  const at=typeof record?.created==='string'?Date.parse(record.created.replace(' ','T')):NaN;
  const disks=parseBeszelStats(record?.stats);
  if(!Number.isFinite(at)||!disks.length)throw new Error('beszel-no-stats');
  return {recordedAt:new Date(at).toISOString(),disks};
 }
}
