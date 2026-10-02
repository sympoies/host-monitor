// A macOS host that runs no collector (nothing may be installed on it). The server runs AGENTLESS_SCRIPT over ssh as one
// fixed, read-only command and builds the snapshot here. Only the boot time, CPU count and model, and kernel are read.
import type {Snapshot} from './model.ts';
export const AGENTLESS_SCRIPT=[
 "echo host-monitor-agentless-v1",
 "sysctl -n kern.boottime 2>/dev/null||echo",
 "sysctl -n hw.ncpu 2>/dev/null||echo",
 "sysctl -n machdep.cpu.brand_string 2>/dev/null||echo",
 "uname -r",
 "echo host-monitor-agentless-end",
].join(';');
const bad=()=>new Error('invalid-agentless-output');
export function agentlessSnapshot(host:string,text:string,nowMs:number):Snapshot {
 const lines=text.split('\n');
 if(text.length>4096||lines[0]!=='host-monitor-agentless-v1'||lines[5]!=='host-monitor-agentless-end')throw bad();
 const boot=/^\{ sec = (\d{9,11}),/.exec(lines[1]),cpus=/^\d{1,4}$/.test(lines[2])?Number(lines[2]):0,kernel=/^\d+(\.\d+){0,3}$/.test(lines[4])?lines[4]:'';
 if(!boot||!(cpus>0)||!kernel)throw bad();
 const uptime=Math.floor(nowMs/1000)-Number(boot[1]);if(!(uptime>=0))throw bad();
 const model=/^[\x20-\x7e]{1,128}$/.test(lines[3])?lines[3]:undefined;
 return {schemaVersion:1,host,platform:'darwin',resources:'external',agentless:true,collectedAt:new Date(nowMs).toISOString(),
  hardware:{cpuCount:cpus,...(model?{cpuModel:model}:{}),load:[],uptime,kernel},collectionIssues:[],services:[],failedUnits:[],containers:[],journalErrors:[],probes:[],attention:[]};
}
