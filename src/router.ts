// Read-only Merlin wire protocol. Infra owns the fixed forced-command script and its key binding.
import type {Attention,Snapshot} from './model.ts';
export const ROUTER_COMMAND='host-monitor-router-v1';
export interface RouterInfo {wanState:number|null;bootAt:string;scheduledBoot:boolean|null;firmwareInstalled:string;firmwareAvailable:string|null;connmon:{at:string;latencyMs:number;lossPercent:number}|null;watchdogCount:number|null;radio0:number|null;radio1:number|null;clients0:number|null;clients1:number|null}
const fields=['epoch','uptime','cpu_count','kernel','firmware','wan_state','reboot_schedule','utc_offset','ntp_ready','webs_state_flag','webs_state_info','connmon','watchdog_count','radio0','radio1','clients0','clients1'];
function version(v:string):number[]|null {return /^\d{4}\.\d{1,3}\.\d{1,3}_\d{1,3}$/.test(v)?v.split(/[._]/).map(Number):null;}
export function routerSnapshot(host:string,text:string,nowMs:number):Snapshot {
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
 const router:RouterInfo={wanState,bootAt,scheduledBoot,firmwareInstalled:data.firmware,firmwareAvailable,connmon,watchdogCount,radio0,radio1,clients0:num('clients0',0,4096),clients1:num('clients1',0,4096)};
 return {schemaVersion:1,host,collectedAt:new Date(nowMs).toISOString(),platform:'linux',agentless:true,resources:'external',hardware:{cpuCount,uptime,load:[],kernel:data.kernel},router,services:[],failedUnits:[],containers:[],journalErrors:[],collectionIssues:[],probes:[],attention};
}
