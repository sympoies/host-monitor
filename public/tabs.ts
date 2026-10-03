export const DEFAULT_TAB_ORDER=['resources','disks','checks','events','agents','services'];
export interface TabStateStore{getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
export interface TabState{order:string[];selected:string}
const KEY='host-monitor.hostTabs.v1';

export function mergeTabOrder(saved:unknown,defaults:string[]):string[]{
 const known=new Set(defaults),kept=new Set<string>();
 if(Array.isArray(saved))for(const id of saved)if(typeof id==='string'&&known.has(id))kept.add(id);
 return [...kept,...defaults.filter(id=>!kept.has(id))];
}
export function loadTabState(store:TabStateStore,defaults:string[]):TabState{
 try{
  const raw=store.getItem(KEY);if(raw===null)return {order:defaults,selected:defaults[0]??''};
  const saved=JSON.parse(raw) as {order?:unknown;selected?:unknown};
  return {order:mergeTabOrder(saved?.order,defaults),selected:typeof saved?.selected==='string'&&defaults.includes(saved.selected)?saved.selected:defaults[0]??''};
 }catch{return {order:defaults,selected:defaults[0]??''};}
}
export function saveTabState(store:TabStateStore,state:TabState):boolean{
 try{store.setItem(KEY,JSON.stringify(state));return true;}catch{return false;}
}
export function clearTabState(store:TabStateStore):void{try{store.removeItem(KEY);}catch{/* storage is optional */}}
export function moveTab(order:string[],id:string,index:number):string[]{
 if(!order.includes(id))return order;
 const rest=order.filter(item=>item!==id);rest.splice(Math.max(0,Math.min(rest.length,index)),0,id);return rest;
}
export function moveVisibleTab(order:string[],visible:string[],id:string,delta:number):string[]{
 const from=visible.indexOf(id);if(from<0)return order;
 const reordered=moveTab(visible,id,from+delta),positions=new Map<string,string>();
 reordered.forEach((item,index)=>positions.set(item,item));
 let next=0;return order.map(item=>positions.has(item)?reordered[next++]:item);
}
