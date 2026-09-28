import type {Snapshot} from './model.ts';
type Convert<T>=(value:unknown)=>T;
type Shape=Record<string,Convert<unknown>>;
type Projected<S extends Shape>={[K in keyof S]?:Exclude<ReturnType<S[K]>,undefined>};
const text=(v:unknown,max=512)=>typeof v==='string'&&v.length<=max?v:undefined;
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
const boolean=(v:unknown)=>typeof v==='boolean'?v:undefined;
function object<S extends Shape>(value:unknown,shape:S):Projected<S>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid-snapshot-object');const source=value as Record<string,unknown>,out:Record<string,unknown>={};for(const [key,convert]of Object.entries(shape)){const v=convert(source[key]);if(v!==undefined)out[key]=v;}return out as Projected<S>;}
const list=<T>(convert:Convert<T>,max=5000)=>(value:unknown):T[]=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>max)throw Error('invalid-snapshot-array');return value.map(convert);};
const record=<S extends Shape>(shape:S)=>(value:unknown)=>object(value,shape);
const str=(value:unknown)=>text(value);
const name=(value:unknown)=>text(value,256);
const numericList=list(number,16);
// Keeps only allowlisted, well-typed fields. The result is typed as a Snapshot: its header and services are validated
// here, and consumers must tolerate any other field being absent.
export function projectSnapshot(value:unknown):Snapshot{
 const snapshot=object(value,{
  schemaVersion:number,host:name,collectedAt:name,platform:name,resources:(value:unknown)=>value==='collected'||value==='external'?value:undefined,
  hardware:record({cpuCount:number,cpuModel:str,cpuBusy:number,load:numericList,uptime:number,kernel:name}),
  memory:(value:unknown)=>value===undefined?undefined:object(value,{total:number,available:number,used:number,swapTotal:number,swapUsed:number}),
  disks:list(record({source:str,type:name,total:number,used:number,available:number,percent:number,mount:str}),256),
  services:list(record({name,scope:name,manager:name,description:str,installed:name,active:name,sub:name,type:name,result:name,exitCode:number,memoryBytes:number,lastExit:str,lastStarted:str,triggers:str,required:boolean,health:name})),
  failedUnits:list(record({scope:name,name,active:name,sub:name})),
  containers:list(record({name,image:str,state:name,status:str,health:name}),2000),
  journalErrors:list(record({unit:name,scope:name,process:name,count:number,lastAt:name}),2000),
  collectionIssues:list(str,64),probes:list(record({name,ok:boolean,status:number}),100),
  gpus:list(record({name:str,busy:number,memoryTotal:number,memoryUsed:number,temperature:number}),32),
  attention:list(record({severity:name,kind:name,title:str,detail:str}),10000),
 });
 if(snapshot.schemaVersion!==1||!snapshot.host||!Number.isFinite(Date.parse(snapshot.collectedAt??''))||!snapshot.hardware?.cpuCount||!Array.isArray(snapshot.hardware.load))throw Error('invalid-snapshot-header');
 for(const s of snapshot.services??[])if(!s.name||!['user','system'].includes(s.scope??'')||!['ok','error','idle','inactive','transition','unknown'].includes(s.health??''))throw Error('invalid-service-snapshot');
 return snapshot as unknown as Snapshot;
}
