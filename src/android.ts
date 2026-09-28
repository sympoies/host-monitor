// Android devices attached to the server over USB adb (fleet-infra decision 0003). Nothing is installed on the device:
// the server runs ADB_SCRIPT with one `adb -s <serial> shell` call per refresh and builds the snapshot here.
// Every command is read-only, and only allowlisted values leave these parsers.
import {parseMeminfo,attentionFor} from './model.ts';
import type {Snapshot,Service,Attention,Disk,AndroidBattery,AndroidInfo,AndroidSensor,AttentionInput} from './model.ts';

export const ADB_SCRIPT=[
 "echo @@battery","dumpsys battery|sed -n '1,/^$/p'",
 "echo @@protect","settings get global protect_battery",
 "echo @@thermal","dumpsys thermalservice",
 "echo @@meminfo","cat /proc/meminfo",
 "echo @@df","df -k /data",
 "echo @@uptime","cat /proc/uptime /proc/loadavg","nproc","uname -r",
 "echo @@ps","ps -A -o USER,NAME|grep -E ' (sshd|com[.]termux|com[.]tailscale[.]ipn)$'",
 "echo @@props","getprop ro.product.model","getprop ro.build.version.release",
 "echo @@end",
].join(';');
// A USB serial, or host:port for an adb-over-TCP device. A leading '-' would be read as an adb option.
export const adbSerial=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v);
export const adbBinary=(v:unknown):v is string=>v==='adb'||typeof v==='string'&&/^\/[A-Za-z0-9_./-]{1,255}$/.test(v);

export const BATTERY_HOT_CELSIUS=45;
export const DATA_WARNING_PERCENT=90;
export const DATA_ERROR_PERCENT=95;
const HEALTH=['','unknown','good','overheat','dead','over-voltage','failure','cold'];
const STATUS=['','unknown','charging','discharging','not-charging','full'];
const POWER:[string,string][]=[['AC powered','ac'],['USB powered','usb'],['Wireless powered','wireless'],['Dock powered','dock']];

/** Splits the script output into its sections. Output without the end marker is incomplete and rejected as a whole. */
export function adbSections(text:string):Record<string,string> {
 const sections:Record<string,string>={};let current:string|undefined,complete=false;
 for(const line of text.split('\n')){
  const marker=/^@@([a-z]+)\s*$/.exec(line);
  if(marker){if(marker[1]==='end'){complete=true;break;}current=marker[1];sections[current]='';continue;}
  if(current!==undefined)sections[current]+=line+'\n';
 }
 if(!complete)throw new Error('incomplete-adb-output');
 return sections;
}
function fields(text:string):Record<string,string> {
 const out:Record<string,string>={};for(const line of text.split('\n')){const m=/^\s*([A-Za-z][A-Za-z ]*): (.*)$/.exec(line);if(m&&!(m[1] in out))out[m[1]]=m[2].trim();}return out;
}
export function parseBattery(text:string):AndroidBattery {
 const f=fields(text),level=Number(f.level),scale=Number(f.scale||100),tenths=Number(f.temperature);
 if(!/^\d+$/.test(f.level??'')||!(scale>0)||!/^-?\d+$/.test(f.temperature??''))throw new Error('invalid-battery');
 return {level:Math.round(level/scale*100),health:HEALTH[Number(f.health)]||'unknown',temperature:tenths/10,status:STATUS[Number(f.status)]||'unknown',power:POWER.find(([k])=>f[k]==='true')?.[1]??'none'};
}
export function parseProtection(text:string):boolean|null {
 const v=text.trim();if(v==='null'||v==='')return null;if(!/^\d+$/.test(v))throw new Error('invalid-protection');return v!=='0';
}
// Reads the HAL's current temperatures; a sensor that reads exactly 0 is not fitted (such as a second battery).
export function parseThermal(text:string):{status:number;sensors:AndroidSensor[]} {
 const status=/^Thermal Status: (\d)\s*$/m.exec(text);if(!status)throw new Error('invalid-thermal');
 const sensors:AndroidSensor[]=[];let inside=false;
 for(const line of text.split('\n')){
  if(line.startsWith('Current temperatures from HAL:')){inside=true;continue;}
  if(!inside)continue;if(!line.startsWith('\t'))break;
  const m=/mValue=(-?\d+(?:\.\d+)?), mType=\d+, mName=([A-Za-z0-9_]{1,16}),/.exec(line);
  if(m&&Number(m[1])!==0&&sensors.length<16)sensors.push({name:m[2],temperature:Number(m[1])});
 }
 return {status:Number(status[1]),sensors:sensors.sort((a,b)=>a.name.localeCompare(b.name))};
}
// `df /data` names the mount it resolves to (often an emulated-storage bind mount); the row is reported as /data.
export function parseDataDisk(text:string):Disk {
 const row=text.trim().split('\n').slice(1).pop()?.trim().split(/\s+/)??[];const [source,size,used,available,percent]=row;
 const n=[size,used,available].map(Number);if(row.length<6||n.some(v=>!Number.isFinite(v))||!(n[0]>0)||!/^\d+%$/.test(percent))throw new Error('invalid-df');
 return {source,type:'',total:n[0]*1024,used:n[1]*1024,available:n[2]*1024,percent:Number(percent.slice(0,-1)),mount:'/data'};
}
export function parseHardware(text:string):Snapshot['hardware'] {
 const [uptime,loadavg,nproc,kernel]=text.trim().split('\n').map(l=>l.trim());
 const up=Number(uptime?.split(/\s+/)[0]),load=(loadavg??'').split(/\s+/).slice(0,3).map(Number),cpus=Number(nproc);
 if(!(up>=0)||load.length!==3||load.some(v=>!Number.isFinite(v))||!Number.isInteger(cpus)||cpus<1||!/^[A-Za-z0-9._+-]{1,128}$/.test(kernel??''))throw new Error('invalid-android-hardware');
 return {cpuCount:cpus,load,uptime:up,kernel};
}
// sshd must belong to the Termux app's user; any other sshd is not the one agents reach.
function services(text:string):Service[] {
 const rows=text.trim().split('\n').map(l=>l.trim().split(/\s+/)).filter(r=>r.length===2);
 const termux=rows.find(([,name])=>name==='com.termux')?.[0];
 const sshd=!!termux&&rows.some(([user,name])=>name==='sshd'&&user===termux),tailscale=rows.some(([,name])=>name==='com.tailscale.ipn');
 const row=(name:string,manager:string,description:string,running:boolean,required:boolean):Service=>({name,scope:'user',manager,description,installed:manager,active:running?'active':'inactive',sub:running?'running':'not running',type:'',result:'',required,health:running?'ok':required?'error':'inactive'});
 return [row('sshd','termux','Termux sshd',sshd,true),row('tailscale','android','Tailscale app',tailscale,false)];
}
const text=(v:string|undefined,re:RegExp)=>{const s=v?.trim();return s&&re.test(s)?s:undefined;};

/** Attention for an Android device: collection issues, the required sshd, and the device rules of decision 0003. */
export function androidAttention(s:AttentionInput&{android?:AndroidInfo;disks?:Pick<Disk,'mount'|'percent'>[]}):Attention[] {
 const events=attentionFor({collectionIssues:s.collectionIssues,services:s.services});
 const battery=s.android?.battery;
 if(battery&&battery.temperature>=BATTERY_HOT_CELSIUS)events.push({severity:'error',kind:'device',title:'Battery temperature',detail:`${battery.temperature.toFixed(1)} °C`});
 if(battery&&battery.health!=='good')events.push({severity:battery.health==='unknown'?'warning':'error',kind:'device',title:'Battery health',detail:battery.health});
 const data=s.disks?.find(d=>d.mount==='/data');
 if(data&&data.percent>=DATA_WARNING_PERCENT)events.push({severity:data.percent>=DATA_ERROR_PERCENT?'error':'warning',kind:'device',title:'/data storage',detail:`${data.percent}% used`});
 if(s.android?.protection===false&&battery&&battery.power!=='none')events.push({severity:'warning',kind:'device',title:'Battery protection off',detail:`on ${battery.power} power`});
 return events;
}
export function androidSnapshot(name:string,output:string,at:number):Snapshot {
 const sections=adbSections(output),issues:string[]=[],android:AndroidInfo={};
 const part=<T>(label:string,parse:()=>T):T|undefined=>{try{return parse();}catch{issues.push(label+' unavailable');return undefined;}};
 const hardware=parseHardware(sections.uptime??'');
 android.battery=part('battery',()=>parseBattery(sections.battery??''));
 android.protection=part('battery protection',()=>parseProtection(sections.protect??''));
 android.thermal=part('thermal',()=>parseThermal(sections.thermal??''));
 const props=(sections.props??'').split('\n');android.model=text(props[0],/^[A-Za-z0-9 ._+-]{1,64}$/);android.release=text(props[1],/^[A-Za-z0-9._-]{1,16}$/);
 for(const k of Object.keys(android) as (keyof AndroidInfo)[])if(android[k]===undefined)delete android[k];
 const memory=part('memory',()=>parseMeminfo(sections.meminfo??'')),data=part('storage',()=>parseDataDisk(sections.df??''));
 const snapshot:Snapshot={schemaVersion:1,host:name,platform:'android',resources:'collected',collectedAt:new Date(at).toISOString(),hardware,...(memory?{memory}:{}),disks:data?[data]:[],
  services:services(sections.ps??''),failedUnits:[],containers:[],journalErrors:[],collectionIssues:issues,probes:[],android,attention:[]};
 snapshot.attention=androidAttention(snapshot);
 return snapshot;
}
