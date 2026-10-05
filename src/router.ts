// Read-only Merlin wire protocol. Infra owns the fixed forced-command script and its key binding.
import type {Attention,Snapshot} from './model.ts';
export const ROUTER_COMMAND='host-monitor-router-v1';
export interface RouterInfo {wanState:number|null;bootAt:string;scheduledBoot:boolean|null;firmwareInstalled:string;firmwareAvailable:string|null;connmon:{at:string;latencyMs:number;lossPercent:number}|null;watchdogCount:number|null;radio0:number|null;radio1:number|null;clients0:number|null;clients1:number|null;adguard:{process:boolean|null;listener:boolean|null;dns:boolean|null;blocked:boolean|null;querylogBytes:number|null;versionInstalled:string|null;versionAvailable:string|null}}
const fields=['epoch','uptime','cpu_count','kernel','firmware','wan_state','reboot_schedule','utc_offset','ntp_ready','webs_state_flag','webs_state_info','connmon','watchdog_count','radio0','radio1','clients0','clients1','agh_process','agh_listener','agh_dns','agh_blocked','agh_querylog_bytes','agh_version'];
function version(v:string):number[]|null {return /^\d{4}\.\d{1,3}\.\d{1,3}_\d{1,3}$/.test(v)?v.split(/[._]/).map(Number):null;}
export function routerSnapshot(host:string,text:string,nowMs:number,adguardLatest?:string|null):Snapshot {
 const bad=()=>new Error('invalid-router-output');
 const lines=text.trimEnd().split('\n');if(text.length>4096||lines.shift()!==ROUTER_COMMAND||lines.pop()!=='host-monitor-router-end'||lines.length!==fields.length)throw bad();
 const data:Record<string,string>={};for(const line of lines){const match=/^([a-z0-9_]+)=([\x20-\x7e]*)$/.exec(line);if(!match||!fields.includes(match[1])||Object.hasOwn(data,match[1]))throw bad();data[match[1]]=match[2];}
 const num=(key:string,min:number,max:number)=>/^\d+(\.\d+)?$/.test(data[key])&&Number(data[key])>=min&&Number(data[key])<=max?Number(data[key]):null;
 const epoch=num('epoch',1e9,1e11),uptime=num('uptime',0,1e9),cpuCount=num('cpu_count',1,1024),installed=version(data.firmware);
 if(epoch===null||uptime===null||cpuCount===null||!Number.isInteger(cpuCount)||!installed||!/^\d+(\.\d+){1,3}([a-zA-Z0-9._-]*)$/.test(data.kernel))throw bad();
 const attention:Attention[]=[];const add=(title:string,detail:string,severity='warning')=>attention.push({kind:'probe',title,detail,severity});
 const clockOK=data.ntp_ready==='1'&&Math.abs(epoch-nowMs/1000)<=300;
 const boot=epoch-uptime,bootAt=new Date(boot*1000).toISOString();let scheduledBoot:boolean|null=null;
 if(clockOK&&/^[01]{7}([01]\d|2[0-3])[0-5]\d$/.test(data.reboot_schedule)&&/^[+-]([01]\d|2[0-3])[0-5]\d$/.test(data.utc_offset)){
  // reboot_schedule is Sunday-first; compare boot time against each selected local weekday.
  const local=new Date(boot*1000+(data.utc_offset[0]==='-'?-1:1)*(Number(data.utc_offset.slice(1,3))*60+Number(data.utc_offset.slice(3)))*60000),day=local.getUTCDay(),minute=local.getUTCHours()*60+local.getUTCMinutes(),target=Number(data.reboot_schedule.slice(7,9))*60+Number(data.reboot_schedule.slice(9));
  scheduledBoot=false;for(let offset=-1;offset<=1;offset++){if(data.reboot_schedule[(day+offset+7)%7]==='1'&&Math.abs(minute-(target+offset*1440))<=5)scheduledBoot=true;}
  if(!scheduledBoot)add('Unscheduled reboot',`Boot ${bootAt}; outside router reboot_schedule (5 min tolerance)`);
 }else add('Reboot schedule unknown','Router time/NTP or reboot schedule unavailable');
 const wanState=num('wan_state',0,9);if(wanState===null)add('WAN state unknown','wan0_state_t unavailable');else if(wanState!==2)add('WAN disconnected',`wan0_state_t=${wanState}`,'error');
 const available=data.webs_state_info.replace(/^(\d{4})_(\d+)_/,'$1.$2.').replace(/_(\d+)_/,'.$1_'),candidate=version(available);
 let firmwareAvailable:string|null=null;
 if(data.webs_state_flag==='1'&&candidate){firmwareAvailable=available;const differing=candidate.findIndex((v,i)=>v!==installed[i]);if(differing>=0&&candidate[differing]>installed[differing])add(`Merlin firmware update ${available}`,`${data.firmware} installed; ${available} available (router check; verify official Merlin release and changelog before scheduling)`,'notice');}
 else if(!['0','1'].includes(data.webs_state_flag)||data.webs_state_flag==='1'&&!candidate)add('Firmware check unavailable','Router update check has no valid release');
 const row=/^(\d{9,11})\|(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)$/.exec(data.connmon);let connmon:RouterInfo['connmon']=null;
 if(clockOK&&row&&epoch-Number(row[1])>=-60&&epoch-Number(row[1])<=900&&Number(row[2])<=60000&&Number(row[3])<=100){
  connmon={at:new Date(Number(row[1])*1000).toISOString(),latencyMs:Number(row[2]),lossPercent:Number(row[3])};
  if(connmon.lossPercent>=20)add('Internet packet loss',`${connmon.lossPercent}% loss (connmon)`,connmon.lossPercent>=80?'error':'warning');
  if(connmon.latencyMs>=100)add('Internet latency',`${connmon.latencyMs} ms (connmon)`);
 }else add('connmon unavailable','Latest sample missing, invalid, or older than 15 min; loss and latency unknown');
 const watchdogCount=num('watchdog_count',0,10000);if(watchdogCount===null)add('Syslog unavailable','Recent watchdog count unknown');else if(watchdogCount>=10)add('ASUS watchdog loop',`${watchdogCount} stop_aae/start_mastiff records in last 10 min (bounded syslog tail)`);
 const radio0=num('radio0',0,1),radio1=num('radio1',0,1);if(radio0===null||radio1===null)add('Wi-Fi radio state unknown','One or more wl radio states unavailable');else if(radio0===0||radio1===0)add('Wi-Fi radio disabled','One or more radios disabled; check configured schedule before changing settings');
 const flag=(key:string):boolean|null=>data[key]==='1'?true:data[key]==='0'?false:null;
 const adguard:RouterInfo['adguard']={process:flag('agh_process'),listener:flag('agh_listener'),dns:flag('agh_dns'),blocked:flag('agh_blocked'),querylogBytes:num('agh_querylog_bytes',0,Number.MAX_SAFE_INTEGER),versionInstalled:/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(data.agh_version)?data.agh_version:null,versionAvailable:adguardLatest??null};
 for(const [key,title,severity] of [['process','AdGuard process stopped','error'],['listener','AdGuard DNS listener missing','error'],['dns','AdGuard DNS resolution failed','error'],['blocked','AdGuard ad blocking failed','warning']] as const){
  if(adguard[key]===false)add(title,key==='dns'?'Normal domain did not resolve through the LAN DNS server':key==='blocked'?'Known ad domain did not resolve to 0.0.0.0':'Read-only AdGuard health check failed',severity);
  else if(adguard[key]===null)add('AdGuard '+key+' check unavailable','Read-only health signal unknown');
 }
 if(adguard.querylogBytes===null)add('AdGuard query log size unavailable','Size could not be read');
 else if(adguard.querylogBytes>=1024**3)add('AdGuard query log size',`${adguard.querylogBytes} bytes across querylog.json* (1 GiB warning threshold; inspect retention and disk capacity)`);
 if(adguard.versionInstalled===null)add('AdGuard version unavailable','Installed binary did not report a valid stable version');
 if(adguardLatest===null)add('AdGuard release check unavailable','Latest stable GitHub release check unavailable; DNS health is independent');
 else if(adguardLatest&&adguard.versionInstalled){const installed=adguard.versionInstalled.split('.').map(Number),available=adguardLatest.split('.').map(Number),differing=available.findIndex((v,i)=>v!==installed[i]);if(differing>=0&&available[differing]>installed[differing])add(`AdGuard update ${adguardLatest}`,`${adguard.versionInstalled} installed; ${adguardLatest} latest stable GitHub release; coordinate upgrade, never auto-update`,'notice');}
 const router:RouterInfo={wanState,bootAt,scheduledBoot,firmwareInstalled:data.firmware,firmwareAvailable,connmon,watchdogCount,radio0,radio1,clients0:num('clients0',0,4096),clients1:num('clients1',0,4096),adguard};
 return {schemaVersion:1,host,collectedAt:new Date(nowMs).toISOString(),platform:'linux',agentless:true,resources:'external',hardware:{cpuCount,uptime,load:[],kernel:data.kernel},router,services:[],failedUnits:[],containers:[],journalErrors:[],collectionIssues:[],probes:[],attention};
}

export const ADGUARD_RELEASE_URL='https://api.github.com/repos/AdguardTeam/AdGuardHome/releases/latest';
export type ReleaseFetch=(url:URL,init:RequestInit)=>Promise<Response>;
// Fixed official endpoint, no credentials, bounded response/time; cache successes and failures for six hours.
export function createAdGuardReleaseCheck({fetchImpl=fetch,now=()=>Date.now()}: {fetchImpl?:ReleaseFetch;now?:()=>number}={}) {
 let expires=0,value:string|null=null,pending:Promise<string|null>|null=null;
 return {read():Promise<string|null>{
  if(pending)return pending;if(now()<expires)return Promise.resolve(value);
  pending=(async()=>{let timer:NodeJS.Timeout|undefined;const controller=new AbortController();
   try{return await Promise.race([(async()=>{
    const response=await fetchImpl(new URL(ADGUARD_RELEASE_URL),{headers:{Accept:'application/vnd.github+json','User-Agent':'host-monitor'},credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||!response.body){await response.body?.cancel();return null;}
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>65536){await reader.cancel();return null;}parts.push(chunk.value);}}finally{reader.releaseLock();}
    const data:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
    if(!data||typeof data!=='object')return null;const release=data as {tag_name?:unknown;draft?:unknown;prerelease?:unknown};
    return typeof release.tag_name==='string'&&/^v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(release.tag_name)&&release.draft===false&&release.prerelease===false?release.tag_name.slice(1):null;
   })(),new Promise<null>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},5000);})]);}
   catch{return null;}finally{clearTimeout(timer);}
  })().then(v=>{value=v;expires=now()+6*3600*1000;return v;}).finally(()=>{pending=null;});return pending;
 }};
}
