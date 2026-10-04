import {loadOrder,saveOrder,clearOrder,moveHost,mergeVisibleOrder} from './order.js';
import {DEFAULT_TAB_ORDER,loadTabState,saveTabState,clearTabState,moveTab,moveVisibleTab} from './tabs.js';
// Types for the read-only JSON API this page renders; the server's projection keeps only these fields.
interface Attention{severity:string;kind:string;title:string;detail?:string}
interface Service{name:string;scope:string;health:string;manager?:string;description?:string;installed?:string;active?:string;sub?:string;type?:string;result?:string;required?:boolean}
interface Container{name:string;image?:string;state?:string;status?:string;health?:string}
interface Disk{source:string;type:string;total:number;used:number;available:number;percent:number;mount:string}
interface AgentSession{agent:string;status:string;phase:string;title?:string;repoName?:string;label?:string;role?:string;createdAt?:string;updatedAt?:string;lastActivityAt?:string;phaseChangedAt?:string;account?:string;selectedAccount?:string;accountState?:string;unreadMessageCount?:number;mode?:string;coordinationMode?:string;resumable?:boolean;lineageDepth?:number}
interface SessionInventory{status:string;sessions:AgentSession[]}
interface Snapshot{agentSessions?:SessionInventory;platform?:string;resources?:string;agentless?:boolean;hardware:{cpuCount:number;cpuBusy?:number;load:number[];uptime:number;kernel:string};memory?:{total:number;available:number;used:number};disks?:Disk[];services:Service[];containers?:Container[];journalErrors?:{unit:string;scope:string;process?:string;count:number;lastAt?:string}[];probes?:{name:string;ok:boolean;status?:number}[];gpus?:{name:string;busy:number;memoryTotal:number;memoryUsed:number;temperature:number}[];android?:Android;attention:Attention[]}
interface Android{model?:string;release?:string;battery?:{level:number;health:string;temperature:number;status:string;power:string};protection?:boolean|null;thermal?:{status:number;sensors:{name:string;temperature:number}[]}}
interface BeszelView{status:'ok'|'stale'|'unavailable';lastSuccess:string|null;recordedAt:string|null;disks:Disk[];cpuBusy?:number;memory?:{total:number;used:number;available:number};gpus?:{name:string;busy:number}[]}
interface Reachability{lastSeen:string|null;nextCheck:string;checks:number}
interface HostView{name:string;reachability?:Reachability;status:string;stale:boolean;beszel?:BeszelView;importantServices?:string[];logUnits?:{name:string;scope:string}[];snapshot:Snapshot|null;lastSuccess:string|null}
interface Fleet{serverTime:string;refreshSeconds:number;defaultOrder?:string[];hosts:HostView[]}
interface HostEvent{at:string;host:string;type:string;kind:string;title:string;severity:string;detail?:string}
interface Row{name:string;scope?:string;description?:string;health:string;source:string;details?:string;required?:boolean;active?:string;state?:string}
let events:HostEvent[]=[],fleet:Fleet|undefined,selected:string|undefined=location.hash.slice(1),fetching=false,logRequest=0,dragging=false,openedLog:{host:string;unit:string}|undefined,preferredTab='agents',draggedTab:string|undefined,fleetFilter='all';
const $=(id:string)=>document.getElementById(id) as HTMLElement;
const input=(id:string)=>$(id) as HTMLInputElement;
const storage=()=>{try{return localStorage;}catch{return {getItem:()=>null,setItem:()=>{throw Error();},removeItem:()=>{throw Error();}};}};
let tabState=loadTabState(storage(),DEFAULT_TAB_ORDER);
preferredTab=tabState.selected;
const sectionFilter=new Map<string,string>();
function selectedFilter(key:string){return sectionFilter.get(key)??'all';}
function drawFilterTabs(id:string,label:string,items:{id:string;label:string;count:number}[],selected:string,onSelect:(id:string)=>void,always=false){
 const root=$(id);root.replaceChildren();const categories=items.filter(item=>item.id!=='all'&&item.count>0);root.hidden=!always&&categories.length<2;if(root.hidden)return;
 root.setAttribute('role','tablist');root.setAttribute('aria-label',label);
 for(const item of (always?items:items.filter(option=>option.id==='all'||option.count>0))){const button=el('button',undefined,'filter-tab') as HTMLButtonElement;button.type='button';button.dataset.filter=item.id;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(item.id===selected));button.tabIndex=item.id===selected?0:-1;button.append(document.createTextNode(item.label));const count=el('span',String(item.count),'filter-count');count.setAttribute('aria-hidden','true');button.append(count);button.setAttribute('aria-label',`${item.label} ${item.count}`);button.addEventListener('click',()=>onSelect(item.id));button.addEventListener('keydown',event=>{
  const tabs=[...root.querySelectorAll<HTMLButtonElement>('[role=tab]')],index=tabs.indexOf(button),next=event.key==='ArrowRight'?index+1:event.key==='ArrowLeft'?index-1:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
  if(next<0)return;event.preventDefault();const target=tabs[(next+tabs.length)%tabs.length],targetId=target.dataset.filter;target.focus();target.click();
  const replacement=[...root.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(tab=>tab.dataset.filter===targetId)??root.querySelector<HTMLButtonElement>('[role=tab][aria-selected="true"]');replacement?.focus();
 });root.append(button);}
}
const el=(tag:string,text?:string,className?:string)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const bytes=(n:number|undefined)=>n!==undefined&&Number.isFinite(n)?n>=2**30?(n/2**30).toFixed(1)+' GiB':n>=2**20?(n/2**20).toFixed(0)+' MiB':(n/1024).toFixed(0)+' KiB':'無資料';
const percent=(n:number|undefined)=>n!==undefined&&Number.isFinite(n)?n.toFixed(1)+'%':'無資料';
const pill=(text:string,kind:string)=>el('span',text,'pill '+kind);
const time=(s:string|null|undefined)=>s?new Date(s).toLocaleTimeString('zh-TW',{hour12:false}):'尚未取得';
const bar=(n:number|undefined)=>{const div=el('div',undefined,'bar '+((n??0)>=95?'error':(n??0)>=85?'warn':''));const span=el('span');span.style.width=Math.max(0,Math.min(100,n||0))+'%';div.append(span);return div;};
const healthLabel:Record<string,string>={ok:'正常',healthy:'健康',error:'異常',unhealthy:'異常',idle:'待命',inactive:'未啟動',transition:'狀態變更中',unknown:'無法確認'};
// Beszel readings have their own freshness; expired or failed readings never render as current.
const externalResources=(s:Snapshot|null|undefined)=>s?.resources==='external';
// Android devices are read over adb by the server (fleet-infra decision 0003): battery and thermal state replace CPU and GPU.
const isAndroid=(s:Snapshot|null|undefined)=>s?.platform==='android';
const batteryHealth:Record<string,string>={good:'良好',overheat:'過熱',dead:'損壞','over-voltage':'過電壓',failure:'故障',cold:'過冷',unknown:'無法確認'};
const powerLabel:Record<string,string>={ac:'AC 供電',usb:'USB 供電',wireless:'無線充電',dock:'底座供電',none:'未接電源'};
const thermalLabel=['正常','輕微','中等','嚴重','危急','緊急','關機'];
const celsius=(n:number)=>n.toFixed(1)+'°C';
function beszelReason(host:HostView){
 const b=host.beszel;
 return !b?'Beszel 未設定':b.status==='stale'?'Beszel 資料已過期':b.status==='unavailable'?'Beszel 暫時讀不到':'Beszel 未提供此指標';
}
function hostSummary(host:HostView){
 const s=host.snapshot!;
 if(externalResources(s)){
  const b=host.beszel;if(b?.status!=='ok')return '資源無資料 · '+beszelReason(host);
  const disk=b.disks.find(d=>d.mount==='/'),gpu=b.gpus?.[0];
  return `Beszel · CPU ${percent(b.cpuBusy)} · 記憶體可用 ${bytes(b.memory?.available)} · 磁碟 ${disk?disk.percent+'%':'無資料'}`+(gpu?` · GPU ${percent(gpu.busy)}`:'')+(b.cpuBusy===undefined||!b.memory||!disk?' · Beszel 未提供此指標':'');
 }
 if(s.agentless)return '僅 ssh 基本資訊';
 if(isAndroid(s)){const b=s.android?.battery;return b?`電池 ${b.level}% · ${celsius(b.temperature)}`:'電池資料無法確認';}
 return `CPU ${percent(s.hardware.cpuBusy)} · 記憶體可用 ${bytes(s.memory?.available)}`;
}
function age(value:string|undefined){if(!value||!Number.isFinite(Date.parse(value)))return '無法確認';const seconds=Math.max(0,Math.floor((Date.parse(fleet?.serverTime??'')-Date.parse(value))/1000));return seconds<60?seconds+' 秒前':seconds<3600?Math.floor(seconds/60)+' 分鐘前':seconds<86400?Math.floor(seconds/3600)+' 小時前':Math.floor(seconds/86400)+' 天前';}
function sessionSummary(host:HostView){
 const inventory=host.snapshot?.agentSessions;
 if(inventory?.status==='disabled')return 'Agents 未啟用';
 if(inventory?.status!=='ok')return 'Agents 無法確認';
 const sessions=inventory.sessions,working=sessions.filter(s=>s.phase==='working').length,waiting=sessions.filter(s=>['waiting','idle'].includes(s.phase)).length,needsInput=sessions.filter(s=>s.phase==='needs_input').length,unknown=sessions.length-working-waiting-needsInput;
 return (host.status!=='online'||host.stale?'最後已知 ':'')+`Agents ${sessions.length} · 工作 ${working} · 等待 / 待命 ${waiting}`+(needsInput?` · 需輸入 ${needsInput}`:'')+(unknown?` · 未知 ${unknown}`:'');
}
const phaseLabel:Record<string,string>={working:'工作中 · working',waiting:'等待 · waiting',idle:'待命 · idle',needs_input:'需要輸入 · needs_input',unknown:'無法確認'};
const phaseRank:Record<string,number>={working:0,needs_input:1,waiting:2,idle:3,unknown:4};
function roleTone(label:string|undefined,role:string|undefined){
 const value=(label||role||'other').trim().toLowerCase();
 if(value.includes('project coordinator'))return 'coordinator-primary';if(value.includes('coordinator'))return 'coordinator-secondary';
 if(value.includes('dispatch')||value.includes('worker'))return 'worker';if(value.includes('tester')||value.includes('test'))return 'tester';
 if(value.includes('analyst')||value.includes('analysis'))return 'analyst';if(value.includes('review'))return 'reviewer';
 if(value.includes('idea'))return 'ideas';return 'other';
}
const agentLabels:Record<string,string>={claude:'Claude',codex:'Codex',dsh:'DSH'};
function agentMark(name:string){
 const kind=name.toLowerCase(),label=agentLabels[kind]??(name.trim()||'Unknown agent'),mark=el('span',undefined,'agent-mark '+(agentLabels[kind]?'agent-'+kind:'agent-other'));
 mark.setAttribute('role','img');mark.setAttribute('aria-label',label);mark.title=label;
 if(kind==='claude')mark.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
 else if(kind==='dsh')mark.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.0 15.2 C1.9 12.0 4.6 8.2 9.6 7.6 C14.4 7.0 17.7 9.2 19.0 12.0 C19.2 12.5 19.2 13.1 18.9 13.6 C17.3 16.0 14.3 17.3 10.8 17.3 C7.6 17.3 4.7 16.6 3.3 15.6 C3.1 15.5 3.0 15.4 3.0 15.2 Z"/><path d="M18.4 12.6 C19.7 11.4 20.7 10.0 21.4 8.5 C21.6 8.0 22.4 8.2 22.3 8.8 C22.1 10.6 21.6 12.2 20.9 13.3 C21.6 14.2 22.1 15.2 22.4 16.3 C22.5 16.9 21.7 17.2 21.4 16.7 C20.6 15.3 19.6 14.2 18.3 13.3 Z"/><path d="M8.4 6.0 C8.2 4.8 8.8 3.8 9.8 3.2 C10.2 3.0 10.6 3.5 10.3 3.9 C9.7 4.6 9.4 5.4 9.5 6.2 C9.5 6.7 8.5 6.7 8.4 6.0 Z"/></svg>';
 else if(kind==='codex')mark.innerHTML='<svg viewBox="0 0 41 41" fill="currentColor" aria-hidden="true"><path d="M37.5324 16.8707C37.9808 15.5241 38.1363 14.0974 37.9886 12.6859C37.8409 11.2744 37.3934 9.91076 36.676 8.68622C35.6126 6.83404 33.9882 5.3676 32.0373 4.4985C30.0864 3.62941 27.9098 3.40259 25.8215 3.85078C24.8796 2.7893 23.7219 1.94125 22.4257 1.36341C21.1295 0.785575 19.7249 0.491269 18.3058 0.500197C16.1708 0.495044 14.0893 1.16803 12.3614 2.42214C10.6335 3.67624 9.34853 5.44666 8.6917 7.47815C7.30085 7.76286 5.98686 8.3414 4.8377 9.17505C3.68854 10.0087 2.73073 11.0782 2.02839 12.312C0.956464 14.1594 0.498905 16.2988 0.721698 18.4228C0.944492 20.5468 1.83612 22.5449 3.268 24.1293C2.81966 25.4759 2.66413 26.9026 2.81182 28.3141C2.95951 29.7256 3.40701 31.0892 4.12437 32.3138C5.18791 34.1659 6.8123 35.6322 8.76321 36.5013C10.7141 37.3704 12.8907 37.5972 14.9789 37.1492C15.9209 38.2108 17.0786 39.0589 18.3747 39.6368C19.6709 40.2148 21.0755 40.5091 22.4946 40.5C24.6308 40.5055 26.7131 39.8326 28.4412 38.5783C30.1694 37.324 31.4545 35.5534 32.1103 33.5212C33.5013 33.2363 34.8152 32.6575 35.9642 31.8236C37.1132 30.9896 38.0707 29.9194 38.7728 28.6854C39.8435 26.8381 40.2994 24.6981 40.0759 22.5746C39.8524 20.4511 38.9614 18.4537 37.5324 16.8707ZM22.4978 37.8849C20.7443 37.8874 19.0459 37.2733 17.6994 36.1501C17.7601 36.117 17.8666 36.0586 17.936 36.0161L25.9004 31.4156C26.1003 31.3019 26.2663 31.137 26.3813 30.9378C26.4964 30.7386 26.5563 30.5124 26.5549 30.2825V19.0542L29.9213 20.998C29.9389 21.0068 29.9541 21.0198 29.9656 21.0359C29.977 21.052 29.9842 21.0707 29.9867 21.0902V30.3889C29.9842 32.375 29.1946 34.2791 27.7909 35.6841C26.3872 37.0892 24.4838 37.8806 22.4978 37.8849ZM6.39227 31.0064C5.51397 29.4888 5.19742 27.7107 5.49804 25.9832C5.55718 26.0187 5.66048 26.0818 5.73461 26.1244L13.699 30.7248C13.8975 30.8408 14.1233 30.902 14.3532 30.902C14.583 30.902 14.8088 30.8408 15.0073 30.7248L24.731 25.1103V28.9979C24.7321 29.0177 24.7283 29.0376 24.7199 29.0556C24.7115 29.0736 24.6988 29.0893 24.6829 29.1012L16.6317 33.7497C14.9096 34.7419 12.8643 35.0104 10.944 34.496C9.02364 33.9816 7.38648 32.7254 6.39227 31.0064ZM4.29707 13.6194C5.17156 12.0998 6.55279 10.9364 8.19885 10.3327C8.19885 10.4013 8.19491 10.5228 8.19491 10.6071V19.808C8.19351 20.0378 8.25334 20.2638 8.36823 20.4629C8.48312 20.6619 8.64893 20.8267 8.84863 20.9404L18.5723 26.5542L15.206 28.4979C15.1894 28.5089 15.1703 28.5155 15.1505 28.5173C15.1307 28.5191 15.1107 28.516 15.0924 28.5082L7.04046 23.8557C5.32135 22.8604 4.06716 21.2236 3.55289 19.3049C3.03862 17.3862 3.30624 15.3416 4.29707 13.6194ZM31.955 20.0556L22.2312 14.4411L25.5976 12.4981C25.6142 12.4872 25.6333 12.4805 25.6531 12.4787C25.6729 12.4769 25.6928 12.4801 25.7111 12.4879L33.7631 17.1364C34.9967 17.849 36.0017 18.8982 36.6606 20.1613C37.3194 21.4244 37.6047 22.849 37.4832 24.2684C37.3617 25.6878 36.8382 27.0432 35.9743 28.1759C35.1103 29.3086 33.9415 30.1717 32.6047 30.6641C32.6047 30.5947 32.6047 30.4733 32.6047 30.3889V21.188C32.6066 20.9586 32.5474 20.7328 32.4332 20.5338C32.319 20.3348 32.154 20.1698 31.955 20.0556ZM35.3055 15.0128C35.2464 14.9765 35.1431 14.9142 35.069 14.8717L27.1045 10.2712C26.906 10.1554 26.6803 10.0943 26.4504 10.0943C26.2206 10.0943 25.9948 10.1554 25.7963 10.2712L16.0726 15.8858V11.9982C16.0715 11.9783 16.0753 11.9585 16.0837 11.9405C16.0921 11.9225 16.1048 11.9068 16.1207 11.8949L24.1719 7.25025C25.4053 6.53903 26.8158 6.19376 28.2383 6.25482C29.6608 6.31589 31.0364 6.78077 32.2044 7.59508C33.3723 8.40939 34.2842 9.53945 34.8334 10.8531C35.3826 12.1667 35.5464 13.6095 35.3055 15.0128ZM14.2424 21.9419L10.8752 19.9981C10.8576 19.9893 10.8423 19.9763 10.8309 19.9602C10.8195 19.9441 10.8122 19.9254 10.8098 19.9058V10.6071C10.8107 9.18295 11.2173 7.78848 11.9819 6.58696C12.7466 5.38544 13.8377 4.42659 15.1275 3.82264C16.4173 3.21869 17.8524 2.99464 19.2649 3.1767C20.6775 3.35876 22.0089 3.93941 23.1034 4.85067C23.0427 4.88379 22.937 4.94215 22.8668 4.98473L14.9024 9.58517C14.7025 9.69878 14.5366 9.86356 14.4215 10.0626C14.3064 10.2618 14.2465 10.4879 14.2477 10.7178L14.2424 21.9419ZM16.071 17.9991L20.4018 15.4978L24.7325 17.9975V22.9985L20.4018 25.4983L16.071 22.9985V17.9991Z"/></svg>';
 else mark.textContent=label.slice(0,1).toUpperCase();
 return mark;
}
const sessionDisclosure=new Map<string,boolean>(),sessionDefaults=new Map<string,boolean>();
function updateSessionToggle(host:string){
 const expanded=[...$('agent-sessions').querySelectorAll<HTMLDetailsElement>('details')].every(d=>d.open);
 const button=$('toggle-session-details');button.textContent=expanded?'全部收合':'全部展開';
 button.onclick=()=>{
  const open=!expanded;sessionDefaults.set(host,open);
  for(const row of $('agent-sessions').querySelectorAll<HTMLElement>('.agent-session')){
   const details=row.querySelector('details')!;details.open=open;
   if(row.dataset.sessionKey)sessionDisclosure.set(row.dataset.sessionKey,open);
  }
  updateSessionToggle(host);
 };
}
function renderSessions(host:HostView){
 const panel=$('agent-sessions');panel.replaceChildren();$('toggle-session-details').hidden=true;const sessionFilters=$('agent-session-filters');sessionFilters.replaceChildren();sessionFilters.hidden=true;const inventory=host.snapshot?.agentSessions;
 if(inventory?.status==='disabled'){panel.append(el('p','此主機未啟用 agent session 採集','session-note'));return;}
 if(inventory?.status!=='ok'){panel.append(el('p','Agent sessions 無法確認；尚未取得可用的本機清單','session-note'));return;}
 const retained=host.status!=='online'||host.stale;
 panel.append(el('p',sessionSummary(host)+(retained?' · 連線或資料已過期，以下是最後已知清單':''),'session-note'));
 const sessionFilter=selectedFilter('agents');drawFilterTabs('agent-session-filters','Agent session filters',[{id:'all',label:'All',count:inventory.sessions.length},{id:'working',label:'Working',count:inventory.sessions.filter(session=>session.phase==='working').length},{id:'waiting',label:'Waiting / idle',count:inventory.sessions.filter(session=>['waiting','idle'].includes(session.phase)).length}],sessionFilter,id=>{sectionFilter.set('agents',id);renderSessions(host);},true);
 if(!inventory.sessions.length){panel.append(el('p',retained?'最後已知清單沒有執行中的 agent；目前無法確認':'目前沒有執行中的 agent','session-note'));return;}
 const sorted=[...inventory.sessions].sort((a,b)=>(phaseRank[a.phase]??4)-(phaseRank[b.phase]??4)||(Date.parse(b.lastActivityAt??'')||0)-(Date.parse(a.lastActivityAt??'')||0)||(a.title??'').localeCompare(b.title??''));
 for(const session of sorted){
  const row=el('article',undefined,'agent-session'),header=el('div',undefined,'session-header'),phase=el('span',(retained?'最後已知 · ':'')+(phaseLabel[session.phase]??phaseLabel.unknown),'session-phase phase-'+(retained?'stale':session.phase in phaseLabel?session.phase:'unknown'));
  row.dataset.sessionKey=JSON.stringify([host.name,session.agent,session.createdAt??'',session.title??'',session.repoName??'']);
  header.append(phase);
  if(session.label||session.role){const label=session.label||session.role||'Other',badge=el('span',label,'session-role role-'+roleTone(session.label,session.role));badge.title=label;header.append(badge);}
 header.append(agentMark(session.agent));row.dataset.phase=session.phase;row.hidden=sessionFilter==='working'?session.phase!=='working':sessionFilter==='waiting'?!['waiting','idle'].includes(session.phase):false;row.append(header,el('div',session.title??'未命名 session','session-title'),el('div',session.repoName??'Repo 無法確認','session-repo'),el('div','活動 '+age(session.lastActivityAt),'session-activity'));
  const details=el('details',undefined,'session-extra') as HTMLDetailsElement,summary=el('summary','更多資訊'),detailRows=el('div',undefined,'session-details');
  for(const value of [`建立 ${age(session.createdAt)}`,`帳號 ${session.account??'無法確認'}${session.accountState?' · '+session.accountState:''}`,`未讀 ${session.unreadMessageCount??'無法確認'}`])detailRows.append(el('span',value));
  if(session.selectedAccount&&session.selectedAccount!==session.account)detailRows.append(el('span','選定帳號 '+session.selectedAccount));
  const metadata=[session.role,session.mode,session.coordinationMode,session.lineageDepth!==undefined?'lineage depth '+session.lineageDepth:'',session.resumable!==undefined?'resumable '+session.resumable:'',session.updatedAt?'更新 '+age(session.updatedAt):''].filter(Boolean);
  details.open=sessionDisclosure.get(row.dataset.sessionKey)??sessionDefaults.get(host.name)??true;
  // Initialization and bulk changes already match the retained state. Their queued native
  // toggle events must not rescan the whole list; only a changed user choice needs an update.
  details.addEventListener('toggle',()=>{
   if(!details.isConnected||details.open===(sessionDisclosure.get(row.dataset.sessionKey!)??sessionDefaults.get(host.name)??true))return;
   sessionDisclosure.set(row.dataset.sessionKey!,details.open);updateSessionToggle(host.name);
  });details.append(summary,detailRows);if(metadata.length)details.append(el('small',metadata.join(' · '),'session-meta'));row.append(details);panel.append(row);
 }
 $('toggle-session-details').hidden=false;updateSessionToggle(host.name);
}
function important(s:Row,markers:string[]=[]){return s.required||markers.some(m=>s.name.includes(m))||s.health==='error';}
function closeLog(){logRequest++;openedLog=undefined;$('log-panel').hidden=true;$('log-body').textContent='';}
async function openLog(host:string,unit:string){
 const request=++logRequest;openedLog={host,unit};$('log-panel').hidden=false;$('log-title').textContent=unit;
 ($('log-refresh') as HTMLButtonElement).disabled=true;
 $('log-body').textContent='讀取最近 120 行日誌中…';
 $('log-panel').scrollIntoView({block:'nearest'});
 try{const params=new URLSearchParams({host,unit}),response=await fetch('/api/logs?'+params,{cache:'no-store'});
  if(!response.ok)throw Error();const data=await response.json() as {text:string};
  if(request===logRequest)$('log-body').textContent=data.text||'目前沒有日誌';
 }catch{if(request===logRequest)$('log-body').textContent='日誌目前無法讀取，請稍後重試。';}
 finally{if(request===logRequest)($('log-refresh') as HTMLButtonElement).disabled=false;}
}
function serviceCategory(health:string){return health==='error'||health==='unhealthy'?'attention':health==='ok'||health==='healthy'?'healthy':health==='idle'||health==='inactive'?'inactive':'unknown';}
function rows(){if(!fleet)return;const host=fleet.hosts.find(h=>h.name===selected),s=host?.snapshot;if(!s)return;const query=input('search').value.trim().toLowerCase(),filter=input('filter').value;
 const units:Row[]=s.services.map(u=>({...u,source:u.manager==='termux'?'Termux':u.manager==='android'?'Android app':u.manager==='launchd'?(u.scope==='user'?'launchd agent':'launchd daemon'):u.scope==='user'?'使用者 service':'系統 service',details:[u.installed,u.type,u.active,u.sub,u.result&&u.result!=='success'?u.result:''].filter(Boolean).join(' · ')}));
 for(const c of s.containers??[])units.push({...c,source:'Docker',description:c.image,health:c.health==='unhealthy'||['restarting','dead'].includes(c.state??'')?'error':c.state==='running'?(c.health==='healthy'?'ok':'unknown'):'inactive',details:c.status,required:true});
 const counts={attention:0,healthy:0,inactive:0,unknown:0};for(const unit of units)counts[serviceCategory(unit.health)]++;
 let serviceFilter=selectedFilter('services');if(serviceFilter!=='all'&&!counts[serviceFilter as keyof typeof counts]){serviceFilter='all';sectionFilter.set('services','all');}drawFilterTabs('service-filters','Service health filters',[{id:'all',label:'All',count:units.length},{id:'attention',label:'Needs attention',count:counts.attention},{id:'healthy',label:'Healthy',count:counts.healthy},{id:'inactive',label:'Inactive',count:counts.inactive},{id:'unknown',label:'Unknown',count:counts.unknown}],serviceFilter,id=>{sectionFilter.set('services',id);rows();});
 const list=units.filter(u=>(serviceFilter==='all'||serviceCategory(u.health)===serviceFilter)&&(!query||(u.name+' '+(u.description??'')).toLowerCase().includes(query))&&(filter==='all'||filter==='important'&&important(u,host?.importantServices)||filter==='attention'&&u.health==='error'||filter==='running'&&(u.active==='active'||u.state==='running'))).sort((a,b)=>(a.health==='error'?-1:0)-(b.health==='error'?-1:0)||a.name.localeCompare(b.name));
 const tbody=$('services');tbody.replaceChildren();for(const u of list){const tr=el('tr'),name=el('td',u.name);name.append(el('small',u.description));
  if(host?.status==='online'&&!host.stale&&s.platform==='linux'&&host.logUnits?.some(v=>v.name===u.name&&v.scope===u.scope)){
   const button=el('button','查看日誌','log-link');button.setAttribute('type','button');button.setAttribute('aria-label',`查看 ${u.name} 日誌`);
   button.addEventListener('click',()=>void openLog(host.name,u.name));name.append(button);
  }
  const state=el('td');state.append(pill(healthLabel[u.health]||'無法確認',u.health));if(u.health==='unknown'&&u.state==='running')state.append(el('small','執行中 · 未設定健康檢查'));tr.append(name,state,el('td',u.source),el('td',u.details));tbody.append(tr);}$('empty').hidden=list.length>0;$('service-count').textContent=`已安裝 ${s.services.length} 個 service · ${s.containers?.length??0} 個容器 · 顯示 ${list.length} 項`;
}
// The default order comes from the server; a viewer's order is saved in this browser only. Storage can be unavailable.
const hostOrder=(defaults:string[])=>loadOrder(storage(),defaults);
const slots=()=>[...$('hosts').children] as HTMLElement[];
const currentOrder=()=>slots().map(n=>n.dataset.host as string);
function reorder(defaults:string[],order:string[]){const complete=mergeVisibleOrder(hostOrder(defaults),order);if(complete.join()===defaults.join())clearOrder(storage());else saveOrder(storage(),complete);render();}
const tabLabels:Record<string,string>={disks:'磁碟容量',checks:'功能檢查與最近錯誤',events:'最近事件',agents:'工作階段',services:'服務'};
const tabPanels:Record<string,string>={disks:'disk-panel',checks:'checks-panel',events:'events-panel',agents:'agents-panel',services:'services-panel'};
function visibleTabs(host:HostView){
 const snapshot=host.snapshot,ids=['events'];
 if(snapshot&&(externalResources(snapshot)||(!snapshot.agentless&&Boolean(snapshot.disks?.length))))ids.push('disks');
 if(snapshot&&((snapshot.probes?.length??0)>0||(snapshot.journalErrors?.length??0)>0||isAndroid(snapshot)))ids.push('checks');
 if(snapshot?.agentSessions)ids.push('agents');
 if(snapshot&&!snapshot.agentless&&((snapshot.services?.length??0)>0||(snapshot.containers?.length??0)>0))ids.push('services');
 return DEFAULT_TAB_ORDER.filter(id=>ids.includes(id));
}
function saveTabs(){saveTabState(storage(),{order:tabState.order,selected:preferredTab});}
function renderTabs(host:HostView){
 const focusedTab=(document.activeElement as HTMLElement|null)?.closest<HTMLElement>('#host-tabs [role=tab]')?.dataset.tab,visible=visibleTabs(host),ordered=tabState.order.filter(id=>visible.includes(id)),active=visible.includes(preferredTab)?preferredTab:ordered[0]??'agents',root=$('host-tabs');root.replaceChildren();
 for(const id of ordered){const tab=el('button',tabLabels[id],'host-tab') as HTMLButtonElement;tab.id='tab-'+id;tab.type='button';tab.setAttribute('role','tab');tab.setAttribute('aria-controls',tabPanels[id]);tab.setAttribute('aria-selected',String(id===active));tab.tabIndex=id===active?0:-1;tab.draggable=true;tab.dataset.tab=id;
  tab.addEventListener('click',()=>{preferredTab=id;tabState.selected=id;saveTabs();renderTabs(host);($('tab-'+id) as HTMLButtonElement).focus();});
  tab.addEventListener('keydown',event=>{const at=ordered.indexOf(id),next=event.key==='ArrowRight'?at+1:event.key==='ArrowLeft'?at-1:event.key==='Home'?0:event.key==='End'?ordered.length-1:-1;if(next<0)return;event.preventDefault();const target=ordered[(next+ordered.length)%ordered.length];preferredTab=target;tabState.selected=target;saveTabs();renderTabs(host);($('tab-'+target) as HTMLButtonElement).focus();});
  tab.addEventListener('dragstart',event=>{draggedTab=id;event.dataTransfer?.setData('text/plain',id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
  tab.addEventListener('dragover',event=>{if(draggedTab){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';}});
  tab.addEventListener('drop',event=>{event.preventDefault();const source=draggedTab??event.dataTransfer?.getData('text/plain');draggedTab=undefined;if(!source||source===id)return;const from=ordered.indexOf(source),to=ordered.indexOf(id),move=moveVisibleTab(tabState.order,ordered,source,to-from);if(move.join()!==tabState.order.join()){tabState.order=move;saveTabs();renderTabs(host);}});
  tab.addEventListener('dragend',()=>{draggedTab=undefined;});root.append(tab);
 }
 for(const id of DEFAULT_TAB_ORDER){const panel=$(tabPanels[id]);panel.hidden=!visible.includes(id)||id!==active;panel.setAttribute('aria-hidden',String(panel.hidden));}
 const menu=document.querySelector('.tab-order-menu') as HTMLDetailsElement,left=$('move-tab-left') as HTMLButtonElement,right=$('move-tab-right') as HTMLButtonElement;menu.hidden=ordered.length<2;left.disabled=ordered.indexOf(active)<=0;right.disabled=ordered.indexOf(active)>=ordered.length-1;
 $('reset-tab-order').hidden=tabState.order.join()===DEFAULT_TAB_ORDER.join();
 if(focusedTab&&ordered.includes(focusedTab))($('tab-'+focusedTab) as HTMLButtonElement).focus({preventScroll:true});
}
function moveSelectedTab(delta:number){const host=fleet?.hosts.find(item=>item.name===selected);if(!host)return;const available=visibleTabs(host),visible=tabState.order.filter(id=>available.includes(id)),active=visible.includes(preferredTab)?preferredTab:visible[0];if(!active)return;const next=moveVisibleTab(tabState.order,visible,active,delta);if(next.join()===tabState.order.join())return;tabState.order=next;preferredTab=active;tabState.selected=active;saveTabs();renderTabs(host);($('tab-'+active) as HTMLButtonElement).focus();}
function renderFleetFilters(hosts:HostView[]){
 const category=(host:HostView):'normal'|'attention'|'offline'=>host.status!=='online'||host.stale?'offline':host.snapshot?.attention.length?'attention':'normal',counts={normal:0,attention:0,offline:0};for(const host of hosts)counts[category(host)]++;
 if(!counts[fleetFilter as keyof typeof counts])fleetFilter='all';
 drawFilterTabs('host-filters','Fleet status filters',[{id:'all',label:'All',count:hosts.length},{id:'normal',label:'正常',count:counts.normal},{id:'attention',label:'需要關注',count:counts.attention},{id:'offline',label:'離線 / 過期',count:counts.offline}],fleetFilter,id=>{fleetFilter=id;render();});
}
const eventLabel:Record<string,string>={attention:'需要關注',recovered:'已恢復',offline:'無法連線',online:'恢復連線'};
function renderEvents(host:string){
 const list=events.filter(event=>event.host===host).slice(0,20),types=[...new Set(list.map(event=>event.type))];let selected=selectedFilter('events');if(selected!=='all'&&!types.includes(selected)){selected='all';sectionFilter.set('events','all');}
 drawFilterTabs('events-filters','Event type filters',[{id:'all',label:'All',count:list.length},...types.map(type=>({id:type,label:eventLabel[type]??type,count:list.filter(event=>event.type===type).length}))],selected,id=>{sectionFilter.set('events',id);renderEvents(host);});
 $('events').replaceChildren();for(const event of list){if(selected!=='all'&&event.type!==selected)continue;const div=el('div',undefined,'event'),main=el('div',event.title,'event-main'),at=el('time',new Date(event.at).toLocaleString('zh-TW',{hour12:false}));at.setAttribute('datetime',event.at);main.append(el('small',event.kind+(event.detail?' · '+event.detail:'')));div.append(pill(eventLabel[event.type]||event.type,event.type==='attention'?(event.severity==='error'?'error':'warning'):event.type==='offline'?'error':'ok'),main,at);$('events').append(div);}if(!$('events').children.length)$('events').append(el('div','目前沒有符合篩選條件的紀錄','event-empty'));
}
function renderChecks(snapshot:Snapshot){
 const rows:{node:HTMLElement;category:string}[]=[];$('checks').replaceChildren();
 for(const probe of snapshot.probes??[]){const node=el('div',probe.name,'check'),category=probe.ok?'passed':'attention';node.append(pill(probe.ok?'通過':'異常',probe.ok?'ok':'error'),el('small',probe.status?`HTTP ${probe.status}`:'無法連線'));rows.push({node,category});}
 for(const item of snapshot.journalErrors??[]){const node=el('div',item.unit,'check');node.append(pill(item.count+' 個錯誤','warning'),el('small',`${item.scope}${item.process?' · '+item.process:''} · 最近 ${time(item.lastAt)}`));rows.push({node,category:'attention'});}
 if(!rows.length){const note=el('div',snapshot.platform==='darwin'?'近一小時沒有採集到必要 launchd 工作的 error 紀錄':isAndroid(snapshot)?'Android 裝置透過 adb 採集，不讀取系統記錄':'近一小時沒有採集到 error 等級的 journal 紀錄','check');$('checks').append(note);drawFilterTabs('checks-filters','Check status filters',[],'all',()=>{});return;}
 const passed=rows.filter(row=>row.category==='passed').length,attention=rows.length-passed;let selected=selectedFilter('checks');if(selected!=='all'&&(selected==='passed'?!passed:!attention)){selected='all';sectionFilter.set('checks','all');}drawFilterTabs('checks-filters','Check status filters',[{id:'all',label:'All',count:rows.length},{id:'passed',label:'Passed',count:passed},{id:'attention',label:'Needs attention',count:attention}],selected,id=>{sectionFilter.set('checks',id);renderChecks(snapshot);});
 for(const row of rows)if(selected==='all'||row.category===selected)$('checks').append(row.node);
}
function renderDisks(host:HostView,snapshot:Snapshot){
 const root=$('disks');root.replaceChildren();const disks=externalResources(snapshot)?(host.beszel?.status==='ok'?host.beszel.disks:[])??[]:snapshot.disks??[];
 if(snapshot.agentless&&!externalResources(snapshot)){root.append(el('div','僅 ssh 基本資訊：不採集磁碟容量','check'));drawFilterTabs('disk-filters','Disk capacity filters',[],'all',()=>{});return;}
 if(externalResources(snapshot)){
  const note=el('div',host.beszel?.status==='ok'?'磁碟容量來自 Beszel':'磁碟無資料 · '+beszelReason(host),'check');
  if(host.beszel?.recordedAt)note.append(el('small',`Beszel 資料時間 ${time(host.beszel.recordedAt)} · ${age(host.beszel.recordedAt)}`));root.append(note);
 }
 if(!disks.length){if(!root.children.length)root.append(el('div','目前沒有磁碟容量資料','check'));drawFilterTabs('disk-filters','Disk capacity filters',[],'all',()=>{});return;}
 const state=(value:number):'normal'|'warning'|'critical'=>value>=95?'critical':value>=85?'warning':'normal',counts={normal:0,warning:0,critical:0};for(const disk of disks)counts[state(disk.percent)]++;let selected=selectedFilter('disks');if(selected!=='all'&&!counts[selected as keyof typeof counts]){selected='all';sectionFilter.set('disks','all');}
 drawFilterTabs('disk-filters','Disk capacity filters',[{id:'all',label:'All',count:disks.length},{id:'normal',label:'Normal',count:counts.normal},{id:'warning',label:'Warning',count:counts.warning},{id:'critical',label:'Critical',count:counts.critical}],selected,id=>{sectionFilter.set('disks',id);renderDisks(host,snapshot);});
 for(const disk of disks){if(selected!=='all'&&state(disk.percent)!==selected)continue;const row=el('div',undefined,'disk'),name=el('div',disk.mount);name.append(el('small',[disk.source,disk.type].filter(Boolean).join(' · ')));const usage=el('div',disk.percent+'%');usage.append(bar(disk.percent));const remaining=el('div',`可用 ${bytes(disk.available)}`,'disk-space');remaining.append(el('small',`使用 ${bytes(disk.used)} / ${bytes(disk.total)}`));row.append(name,usage,remaining);root.append(row);}
}
// Each card has a grip: drag it with a mouse or finger, or focus it and press an arrow key to move the card one place.
function grip(name:string,defaults:string[]){
 const handle=el('button','⋮⋮','host-grip');handle.setAttribute('type','button');handle.setAttribute('aria-label',`移動 ${name} 卡片（拖曳，或用方向鍵）`);handle.title='拖曳以調整順序';
 handle.addEventListener('keydown',e=>{const delta=['ArrowLeft','ArrowUp'].includes(e.key)?-1:['ArrowRight','ArrowDown'].includes(e.key)?1:0;if(!delta)return;e.preventDefault();
  const order=currentOrder();reorder(defaults,moveHost(order,name,order.indexOf(name)+delta));($('hosts').querySelector(`[data-host="${CSS.escape(name)}"] .host-grip`) as HTMLElement|null)?.focus();});
 handle.addEventListener('pointerdown',e=>{if(e.button!==0&&e.pointerType==='mouse')return;e.preventDefault();dragging=true;
  const slot=handle.parentElement as HTMLElement;slot.classList.add('dragging');
  const move=(ev:PointerEvent)=>{const others=slots().filter(n=>n!==slot);let index=others.length;
   for(let i=0;i<others.length;i++){const r=others[i].getBoundingClientRect();if(ev.clientY<r.top||ev.clientY<=r.bottom&&ev.clientX<r.left+r.width/2){index=i;break;}}
   const after=others[index]??null;if(slot.nextElementSibling!==after)$('hosts').insertBefore(slot,after);};
  const done=(ev:PointerEvent)=>{removeEventListener('pointermove',move);removeEventListener('pointerup',done);removeEventListener('pointercancel',done);dragging=false;slot.classList.remove('dragging');
   if(ev.type==='pointerup')reorder(defaults,currentOrder());else render();};
  addEventListener('pointermove',move);addEventListener('pointerup',done);addEventListener('pointercancel',done);});
 return handle;
}
function render(){
 if(!fleet)return;
 if(!fleet.hosts.some(host=>host.name===selected))selected=fleet.hosts[0]?.name;
 const focused=(document.activeElement as HTMLElement|null)?.classList.contains('host-grip')?(document.activeElement as HTMLElement).parentElement?.dataset.host:undefined;
 const defaults=fleet.defaultOrder??fleet.hosts.map(host=>host.name),order=hostOrder(defaults);
 $('reset-order').hidden=order.join()===defaults.join();renderFleetFilters(fleet.hosts);$('hosts').replaceChildren();
 const category=(host:HostView)=>host.status!=='online'||host.stale?'offline':host.snapshot?.attention.length?'attention':'normal';
 for(const host of [...fleet.hosts].filter(item=>fleetFilter==='all'||category(item)===fleetFilter).sort((a,b)=>order.indexOf(a.name)-order.indexOf(b.name))){
  const slot=el('div',undefined,'host-slot');slot.dataset.host=host.name;
  const good=host.status==='online'&&!host.stale,tone=!good?'warning':host.snapshot?.attention.some(item=>item.severity==='error')?'error':host.snapshot?.attention.length?'warning':'ok';
  const button=el('button',undefined,'host tone-'+tone+(host.name===selected?' selected':''));button.setAttribute('aria-pressed',String(host.name===selected));
  const top=el('div',undefined,'host-top');top.append(el('span',host.name,'host-name'),pill(host.status==='loading'?'讀取中':!good?'離線 / 資料過期':host.snapshot?.attention.length?'需要關注':'正常',tone));
  button.append(top,el('div',host.snapshot?hostSummary(host):'等待主機回應','host-detail'),el('div',host.reachability?`最後看到 ${time(host.reachability.lastSeen)} · 下次檢查 ${time(host.reachability.nextCheck)}`:`最近成功更新 ${time(host.lastSuccess)}`,'host-detail'));
  button.append(el('div',sessionSummary(host),'host-detail host-agents'));
  button.addEventListener('click',()=>{closeLog();selected=host.name;location.hash=selected;render();});slot.append(button,grip(host.name,defaults));$('hosts').append(slot);
 }
 if(focused)($('hosts').querySelector(`[data-host="${CSS.escape(focused)}"] .host-grip`) as HTMLElement|null)?.focus();
 const host=fleet.hosts.find(item=>item.name===selected);if(!host)return;const snapshot=host.snapshot;
 if(openedLog&&(openedLog.host!==host.name||host.status!=='online'||host.stale))closeLog();
 $('host-title').textContent=host.name;$('connection').textContent=host.status!=='online'||host.stale?(host.reachability?`主機目前無法連線（最後看到 ${time(host.reachability.lastSeen)}，下次檢查 ${time(host.reachability.nextCheck)}）。`:'無法取得即時資料。')+(snapshot?'下方保留最後一次成功的快照，請留意更新時間。':'正在等待 collector 回應。'):'';
 $('updated').textContent=`網頁更新 ${time(fleet.serverTime)} · 每 ${fleet.refreshSeconds} 秒採集`;
 const summary=$('summary');summary.textContent=snapshot?`${snapshot.attention.length} 項需要關注`:'等待資料';summary.className='pill '+(!snapshot?'warning':snapshot.attention.some(item=>item.severity==='error')?'error':snapshot.attention.length?'warning':'ok');
 $('attention').replaceChildren();$('resources').replaceChildren();$('disks').replaceChildren();$('checks').replaceChildren();$('services').replaceChildren();renderEvents(host.name);renderSessions(host);
 if(!snapshot){$('attention').append(el('div','等待主機快照','notice warning'));renderTabs(host);return;}
 for(const attention of snapshot.attention){const notice=el('div',attention.title,'notice '+attention.severity);if(attention.detail)notice.append(el('span',attention.detail));$('attention').append(notice);}
 if(!snapshot.attention.length)$('attention').append(el('div',host.status==='online'&&!host.stale?'目前沒有偵測到需要處理的異常':'最後一次快照沒有異常；目前連線狀態待確認','notice '+(host.status==='online'&&!host.stale?'ok':'warning')));
 function metric(label:string,value:string,detail:string,n?:number){const div=el('div',undefined,'metric');div.append(el('div',label,'metric-label'),el('div',value,'metric-value'));if(n!==undefined)div.append(bar(n));div.append(el('div',detail,'metric-sub'));$('resources').append(div);}
 const uptime=`${Math.floor(snapshot.hardware.uptime/86400)} 天 ${Math.floor(snapshot.hardware.uptime%86400/3600)} 小時`;
 if(externalResources(snapshot)){
  const b=host.beszel,current=b?.status==='ok'?b:undefined,source=current?`Beszel · 資料時間 ${time(b?.recordedAt)} · ${age(b?.recordedAt??undefined)}`:beszelReason(host);
  metric('CPU 使用率',percent(current?.cpuBusy),current?.cpuBusy!==undefined?source:beszelReason(host),current?.cpuBusy);
  const memory=current?.memory,memoryPercent=memory?memory.used/memory.total*100:undefined;
  metric('記憶體使用率',percent(memoryPercent),memory?`${source} · 使用 ${bytes(memory.used)} / ${bytes(memory.total)} · 可用 ${bytes(memory.available)}`:beszelReason(host),memoryPercent);
  const disk=current?.disks.find(d=>d.mount==='/');
  metric('系統磁碟',disk?disk.percent+'%':'無資料',disk?`${source} · 使用 ${bytes(disk.used)} · 可用 ${bytes(disk.available)}`:beszelReason(host),disk?.percent);
  if(current?.gpus?.length)for(const gpu of current.gpus)metric('GPU 使用率',percent(gpu.busy),`${source} · ${gpu.name}`,gpu.busy);
  else metric('主機運作時間',uptime,`${snapshot.hardware.cpuCount} CPU · 核心 ${snapshot.hardware.kernel}`);
 }
 else if(snapshot.agentless){metric('資源指標','未安裝 collector','僅 ssh 基本資訊：不採集 CPU、記憶體、磁碟與服務');metric('主機運作時間',uptime,`${snapshot.hardware.cpuCount} CPU · 核心 ${snapshot.hardware.kernel}`);} else if(isAndroid(snapshot)){const battery=snapshot.android?.battery,thermal=snapshot.android?.thermal,protection=snapshot.android?.protection,memory=snapshot.memory,memoryPercent=memory?memory.used/memory.total*100:undefined,data=snapshot.disks?.find(disk=>disk.mount==='/data');
  metric('電池電量',battery?battery.level+'%':'無資料',battery?`健康 ${batteryHealth[battery.health]??battery.health} · ${powerLabel[battery.power]??battery.power} · 電池保護 ${protection==null?'無資料':protection?'開啟':'關閉'}`:'採集無法確認');
  metric('電池溫度',battery?celsius(battery.temperature):'無資料',thermal?[`熱狀態 ${thermalLabel[thermal.status]??thermal.status}`,...thermal.sensors.map(sensor=>`${sensor.name} ${celsius(sensor.temperature)}`)].join(' · '):'熱感測無法確認');
  metric('記憶體使用率',percent(memoryPercent),memory?`使用 ${bytes(memory.used)} / ${bytes(memory.total)} · 可用 ${bytes(memory.available)}`:'採集無法確認',memoryPercent);
  metric('/data 儲存空間',data?data.percent+'%':'無資料',data?`使用 ${bytes(data.used)} · 可用 ${bytes(data.available)}`:'採集無法確認',data?.percent);
 }else{
  metric('CPU 使用率',percent(snapshot.hardware.cpuBusy),`${snapshot.hardware.cpuCount} CPU · Load ${snapshot.hardware.load.map(value=>value.toFixed(2)).join(' / ')}`,snapshot.hardware.cpuBusy);
  const memory=snapshot.memory,memoryPercent=memory?memory.used/memory.total*100:undefined;metric('記憶體使用率',percent(memoryPercent),memory?`使用 ${bytes(memory.used)} / ${bytes(memory.total)} · 可用 ${bytes(memory.available)}`:'採集無法確認',memoryPercent);
  const disk=snapshot.disks?.find(item=>item.mount==='/');metric('系統磁碟',disk?disk.percent+'%':'無資料',disk?`使用 ${bytes(disk.used)} · 可用 ${bytes(disk.available)}`:'採集無法確認',disk?.percent);
  const gpu=snapshot.gpus?.[0];metric(gpu?'GPU 使用率':'主機運作時間',gpu?percent(gpu.busy):Math.floor(snapshot.hardware.uptime/86400)+' 天',gpu?`${gpu.name} · ${gpu.temperature}°C · ${bytes(gpu.memoryUsed)} / ${bytes(gpu.memoryTotal)}`:`${Math.floor(snapshot.hardware.uptime%86400/3600)} 小時 · 核心 ${snapshot.hardware.kernel}`,gpu?.busy);
 }
 renderDisks(host,snapshot);renderChecks(snapshot);rows();renderTabs(host);
}
async function refresh(){if(fetching||dragging)return;fetching=true;try{const r=await fetch('/api/fleet',{cache:'no-store'});if(!r.ok)throw Error();fleet=await r.json();document.body.dataset.link='ok';if(dragging)return;try{const e=await fetch('/api/events?limit=200',{cache:'no-store'});if(e.ok)events=(await e.json()).events;}catch{}if(!dragging)render();}catch{document.body.dataset.link='down';$('connection').textContent='監控 server 暫時無法連線；目前頁面資料可能已過期。';}finally{fetching=false;}}
$('refresh').addEventListener('click',refresh);$('reset-order').addEventListener('click',()=>{clearOrder(storage());render();});$('search').addEventListener('input',rows);$('filter').addEventListener('change',rows);
$('move-tab-left').addEventListener('click',()=>moveSelectedTab(-1));$('move-tab-right').addEventListener('click',()=>moveSelectedTab(1));
$('reset-tab-order').addEventListener('click',()=>{tabState.order=[...DEFAULT_TAB_ORDER];saveTabs();const host=fleet?.hosts.find(item=>item.name===selected);if(host)renderTabs(host);});
$('log-close').addEventListener('click',closeLog);$('log-refresh').addEventListener('click',()=>{if(openedLog)void openLog(openedLog.host,openedLog.unit);});
void refresh();setInterval(refresh,5000);
