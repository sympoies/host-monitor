// Types for the read-only JSON API this page renders; the server's projection keeps only these fields.
interface Attention{severity:string;kind:string;title:string;detail?:string}
interface Service{name:string;scope:string;health:string;manager?:string;description?:string;installed?:string;active?:string;sub?:string;type?:string;result?:string;required?:boolean}
interface Container{name:string;image?:string;state?:string;status?:string;health?:string}
interface Disk{source:string;type:string;total:number;used:number;available:number;percent:number;mount:string}
interface Snapshot{platform?:string;resources?:string;hardware:{cpuCount:number;cpuBusy?:number;load:number[];uptime:number;kernel:string};memory?:{total:number;available:number;used:number};disks?:Disk[];services:Service[];containers?:Container[];journalErrors?:{unit:string;scope:string;process?:string;count:number;lastAt?:string}[];probes?:{name:string;ok:boolean;status?:number}[];gpus?:{name:string;busy:number;memoryTotal:number;memoryUsed:number;temperature:number}[];android?:Android;attention:Attention[]}
interface Android{model?:string;release?:string;battery?:{level:number;health:string;temperature:number;status:string;power:string};protection?:boolean|null;thermal?:{status:number;sensors:{name:string;temperature:number}[]}}
interface HostView{name:string;status:string;stale:boolean;importantServices?:string[];logUnits?:{name:string;scope:string}[];snapshot:Snapshot|null;lastSuccess:string|null}
interface Fleet{serverTime:string;refreshSeconds:number;hosts:HostView[]}
interface HostEvent{at:string;host:string;type:string;kind:string;title:string;severity:string;detail?:string}
interface Row{name:string;scope?:string;description?:string;health:string;source:string;details?:string;required?:boolean;active?:string;state?:string}
let events:HostEvent[]=[],fleet:Fleet|undefined,selected:string|undefined=location.hash.slice(1),fetching=false,logRequest=0,openedLog:{host:string;unit:string}|undefined;
const $=(id:string)=>document.getElementById(id) as HTMLElement;
const input=(id:string)=>$(id) as HTMLInputElement;
const el=(tag:string,text?:string,className?:string)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const bytes=(n:number|undefined)=>n!==undefined&&Number.isFinite(n)?n>=2**30?(n/2**30).toFixed(1)+' GiB':n>=2**20?(n/2**20).toFixed(0)+' MiB':(n/1024).toFixed(0)+' KiB':'無資料';
const percent=(n:number|undefined)=>n!==undefined&&Number.isFinite(n)?n.toFixed(1)+'%':'無資料';
const pill=(text:string,kind:string)=>el('span',text,'pill '+kind);
const time=(s:string|null|undefined)=>s?new Date(s).toLocaleTimeString('zh-TW',{hour12:false}):'尚未取得';
const bar=(n:number|undefined)=>{const div=el('div',undefined,'bar '+((n??0)>=95?'error':(n??0)>=85?'warn':''));const span=el('span');span.style.width=Math.max(0,Math.min(100,n||0))+'%';div.append(span);return div;};
const healthLabel:Record<string,string>={ok:'正常',healthy:'健康',error:'異常',unhealthy:'異常',idle:'待命',inactive:'未啟動',transition:'狀態變更中',unknown:'無法確認'};
// A host whose resource metrics come from Beszel shows a neutral pointer, never a missing-data warning.
const externalResources=(s:Snapshot|null|undefined)=>s?.resources==='external';
// Android devices are read over adb by the server (fleet-infra decision 0003): battery and thermal state replace CPU and GPU.
const isAndroid=(s:Snapshot|null|undefined)=>s?.platform==='android';
const batteryHealth:Record<string,string>={good:'良好',overheat:'過熱',dead:'損壞','over-voltage':'過電壓',failure:'故障',cold:'過冷',unknown:'無法確認'};
const powerLabel:Record<string,string>={ac:'AC 供電',usb:'USB 供電',wireless:'無線充電',dock:'底座供電',none:'未接電源'};
const thermalLabel=['正常','輕微','中等','嚴重','危急','緊急','關機'];
const celsius=(n:number)=>n.toFixed(1)+'°C';
function hostSummary(s:Snapshot){if(externalResources(s))return '資源指標：Beszel';if(isAndroid(s)){const b=s.android?.battery;return b?`電池 ${b.level}% · ${celsius(b.temperature)}`:'電池資料無法確認';}return `CPU ${percent(s.hardware.cpuBusy)} · 記憶體可用 ${bytes(s.memory?.available)}`;}
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
function rows(){if(!fleet)return;const host=fleet.hosts.find(h=>h.name===selected),s=host?.snapshot;if(!s)return;const query=input('search').value.trim().toLowerCase(),filter=input('filter').value;
 const units:Row[]=s.services.map(u=>({...u,source:u.manager==='termux'?'Termux':u.manager==='android'?'Android app':u.manager==='launchd'?(u.scope==='user'?'launchd agent':'launchd daemon'):u.scope==='user'?'使用者 service':'系統 service',details:[u.installed,u.type,u.active,u.sub,u.result&&u.result!=='success'?u.result:''].filter(Boolean).join(' · ')}));
 for(const c of s.containers??[])units.push({...c,source:'Docker',description:c.image,health:c.health==='unhealthy'||['restarting','dead'].includes(c.state??'')?'error':c.state==='running'?(c.health==='healthy'?'ok':'unknown'):'inactive',details:c.status,required:true});
 const list=units.filter(u=>(!query||(u.name+' '+(u.description??'')).toLowerCase().includes(query))&&(filter==='all'||filter==='important'&&important(u,host?.importantServices)||filter==='attention'&&u.health==='error'||filter==='running'&&(u.active==='active'||u.state==='running'))).sort((a,b)=>(a.health==='error'?-1:0)-(b.health==='error'?-1:0)||a.name.localeCompare(b.name));
 const tbody=$('services');tbody.replaceChildren();for(const u of list){const tr=el('tr'),name=el('td',u.name);name.append(el('small',u.description));
  if(host?.status==='online'&&!host.stale&&s.platform==='linux'&&host.logUnits?.some(v=>v.name===u.name&&v.scope===u.scope)){
   const button=el('button','查看日誌','log-link');button.setAttribute('type','button');button.setAttribute('aria-label',`查看 ${u.name} 日誌`);
   button.addEventListener('click',()=>void openLog(host.name,u.name));name.append(button);
  }
  const state=el('td');state.append(pill(healthLabel[u.health]||'無法確認',u.health));if(u.health==='unknown'&&u.state==='running')state.append(el('small','執行中 · 未設定健康檢查'));tr.append(name,state,el('td',u.source),el('td',u.details));tbody.append(tr);}$('empty').hidden=list.length>0;$('service-count').textContent=`已安裝 ${s.services.length} 個 service · ${s.containers?.length??0} 個容器 · 顯示 ${list.length} 項`;
}
function render(){if(!fleet)return;if(!fleet.hosts.some(h=>h.name===selected))selected=fleet.hosts[0]?.name;$('hosts').replaceChildren();for(const h of fleet.hosts){const button=el('button',undefined,'host '+(h.name===selected?'selected':''));button.setAttribute('aria-pressed',String(h.name===selected));const top=el('div',undefined,'host-top');const good=h.status==='online'&&!h.stale;top.append(el('span',h.name,'host-name'),pill(h.status==='loading'?'讀取中':!good?'離線 / 資料過期':h.snapshot?.attention.length?'需要關注':'正常',!good?'warning':h.snapshot?.attention.some(a=>a.severity==='error')?'error':h.snapshot?.attention.length?'warning':'ok'));button.append(top,el('div',h.snapshot?hostSummary(h.snapshot):'等待主機回應','host-detail'),el('div',`最近成功更新 ${time(h.lastSuccess)}`,'host-detail'));button.addEventListener('click',()=>{closeLog();selected=h.name;location.hash=selected;render();});$('hosts').append(button);}
 const h=fleet.hosts.find(h=>h.name===selected);if(!h)return;const s=h.snapshot;
 if(openedLog&&(openedLog.host!==h.name||h.status!=='online'||h.stale))closeLog();
 $('host-title').textContent=h.name;$('connection').textContent=h.status!=='online'||h.stale?'無法取得即時資料。'+(s?'下方保留最後一次成功的快照，請留意更新時間。':'正在等待 collector 回應。'):'';$('updated').textContent=`網頁更新 ${time(fleet.serverTime)} · 每 ${fleet.refreshSeconds} 秒採集`;
 const sum=$('summary');sum.textContent=s?`${s.attention.length} 項需要關注`:'等待資料';sum.className='pill '+(!s?'warning':s.attention.some(a=>a.severity==='error')?'error':s.attention.length?'warning':'ok');$('attention').replaceChildren();$('resources').replaceChildren();$('disks').replaceChildren();$('checks').replaceChildren();$('services').replaceChildren();renderEvents(h.name);if(!s)return;
 for(const a of s.attention){const notice=el('div',a.title,'notice '+a.severity);if(a.detail)notice.append(el('span',a.detail));$('attention').append(notice);}if(!s.attention.length)$('attention').append(el('div',h.status==='online'&&!h.stale?'目前沒有偵測到需要處理的異常':'最後一次快照沒有異常；目前連線狀態待確認','notice '+(h.status==='online'&&!h.stale?'ok':'warning')));
 function metric(label:string,value:string,detail:string,n?:number){const div=el('div',undefined,'metric');div.append(el('div',label,'metric-label'),el('div',value,'metric-value'));if(n!==undefined)div.append(bar(n));div.append(el('div',detail,'metric-sub'));$('resources').append(div);}
 const uptime=`${Math.floor(s.hardware.uptime/86400)} 天 ${Math.floor(s.hardware.uptime%86400/3600)} 小時`;
 if(externalResources(s)){metric('資源指標','Beszel','CPU、記憶體、磁碟與 GPU 由 Beszel 監控與保存歷史');metric('主機運作時間',uptime,`${s.hardware.cpuCount} CPU · 核心 ${s.hardware.kernel}`);$('disks').append(el('div','此主機的磁碟容量由 Beszel 監控','check'));}
 else if(isAndroid(s)){const b=s.android?.battery,t=s.android?.thermal,protection=s.android?.protection,mem=s.memory,mp=mem?mem.used/mem.total*100:undefined,data=s.disks?.find(d=>d.mount==='/data');
 metric('電池電量',b?b.level+'%':'無資料',b?`健康 ${batteryHealth[b.health]??b.health} · ${powerLabel[b.power]??b.power} · 電池保護 ${protection==null?'無資料':protection?'開啟':'關閉'}`:'採集無法確認');
 metric('電池溫度',b?celsius(b.temperature):'無資料',t?[`熱狀態 ${thermalLabel[t.status]??t.status}`,...t.sensors.map(x=>`${x.name} ${celsius(x.temperature)}`)].join(' · '):'熱感測無法確認');
 metric('記憶體使用率',percent(mp),mem?`使用 ${bytes(mem.used)} / ${bytes(mem.total)} · 可用 ${bytes(mem.available)}`:'採集無法確認',mp);
 metric('/data 儲存空間',data?data.percent+'%':'無資料',data?`使用 ${bytes(data.used)} · 可用 ${bytes(data.available)}`:'採集無法確認',data?.percent);
 }
 else{metric('CPU 使用率',percent(s.hardware.cpuBusy),`${s.hardware.cpuCount} CPU · Load ${s.hardware.load.map(n=>n.toFixed(2)).join(' / ')}`,s.hardware.cpuBusy);
 const mem=s.memory,mp=mem?mem.used/mem.total*100:undefined;metric('記憶體使用率',percent(mp),mem?`使用 ${bytes(mem.used)} / ${bytes(mem.total)} · 可用 ${bytes(mem.available)}`:'採集無法確認',mp);
 const disk=s.disks?.find(d=>d.mount==='/');metric('系統磁碟',disk?disk.percent+'%':'無資料',disk?`使用 ${bytes(disk.used)} · 可用 ${bytes(disk.available)}`:'採集無法確認',disk?.percent);
 const gpu=s.gpus?.[0];metric(gpu?'GPU 使用率':'主機運作時間',gpu?percent(gpu.busy):Math.floor(s.hardware.uptime/86400)+' 天',gpu?`${gpu.name} · ${gpu.temperature}°C · ${bytes(gpu.memoryUsed)} / ${bytes(gpu.memoryTotal)}`:`${Math.floor(s.hardware.uptime%86400/3600)} 小時 · 核心 ${s.hardware.kernel}`,gpu?.busy);
 }
 for(const d of s.disks??[]){const row=el('div',undefined,'disk'),name=el('div',d.mount);name.append(el('small',[d.source,d.type].filter(Boolean).join(' · ')));const usage=el('div',d.percent+'%');usage.append(bar(d.percent));const remaining=el('div',`可用 ${bytes(d.available)}`,'disk-space');remaining.append(el('small',`使用 ${bytes(d.used)} / ${bytes(d.total)}`));row.append(name,usage,remaining);$('disks').append(row);}
 for(const p of s.probes??[]){const div=el('div',p.name,'check');div.append(pill(p.ok?'通過':'異常',p.ok?'ok':'error'),el('small',p.status?`HTTP ${p.status}`:'無法連線'));$('checks').append(div);}for(const j of s.journalErrors??[]){const div=el('div',j.unit,'check');div.append(pill(j.count+' 個錯誤','warning'),el('small',`${j.scope}${j.process?' · '+j.process:''} · 最近 ${time(j.lastAt)}`));$('checks').append(div);}if(!s.journalErrors?.length)$('checks').append(el('div',s.platform==='darwin'?'近一小時沒有採集到必要 launchd 工作的 error 紀錄':isAndroid(s)?'Android 裝置透過 adb 採集，不讀取系統記錄':'近一小時沒有採集到 error 等級的 journal 紀錄','check'));
 rows();
}
const eventLabel:Record<string,string>={attention:'需要關注',recovered:'已恢復',offline:'無法連線',online:'恢復連線'};
function renderEvents(host:string){const list=events.filter(e=>e.host===host).slice(0,20);$('events').replaceChildren();for(const e of list){const div=el('div',e.title,'check');div.append(pill(eventLabel[e.type]||e.type,e.type==='attention'?(e.severity==='error'?'error':'warning'):e.type==='offline'?'error':'ok'),el('small',`${e.kind} · ${new Date(e.at).toLocaleString('zh-TW',{hour12:false})}${e.detail?' · '+e.detail:''}`));$('events').append(div);}if(!list.length)$('events').append(el('div','目前沒有紀錄到狀態轉換','check'));}
async function refresh(){if(fetching)return;fetching=true;try{const r=await fetch('/api/fleet',{cache:'no-store'});if(!r.ok)throw Error();fleet=await r.json();try{const e=await fetch('/api/events?limit=200',{cache:'no-store'});if(e.ok)events=(await e.json()).events;}catch{}render();}catch{$('connection').textContent='監控 server 暫時無法連線；目前頁面資料可能已過期。';}finally{fetching=false;}}
$('refresh').addEventListener('click',refresh);$('search').addEventListener('input',rows);$('filter').addEventListener('change',rows);
$('log-close').addEventListener('click',closeLog);$('log-refresh').addEventListener('click',()=>{if(openedLog)void openLog(openedLog.host,openedLog.unit);});
void refresh();setInterval(refresh,5000);
