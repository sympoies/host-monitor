// Host card order: the server's default order, optionally replaced by a per-browser saved order. Storage may be
// unavailable (private mode, blocked site data), so every access is guarded and falls back to the default order.
export interface OrderStore{getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
const KEY='host-monitor.hostOrder';
// Saved names keep their sequence; hosts no longer configured are dropped and new hosts follow in default order.
export function mergeOrder(saved:unknown,defaults:string[]):string[] {
 const known=new Set(defaults),kept=new Set<string>();
 if(Array.isArray(saved))for(const name of saved)if(typeof name==='string'&&known.has(name))kept.add(name);
 return [...kept,...defaults.filter(name=>!kept.has(name))];
}
export function loadOrder(store:OrderStore,defaults:string[]):string[] {
 try{const raw=store.getItem(KEY);return raw===null?defaults:mergeOrder(JSON.parse(raw),defaults);}catch{return defaults;}
}
export function saveOrder(store:OrderStore,order:string[]):boolean {
 try{store.setItem(KEY,JSON.stringify(order));return true;}catch{return false;}
}
export function clearOrder(store:OrderStore):void {
 try{store.removeItem(KEY);}catch{/* nothing was saved that could be removed */}
}
// Place `name` at `index` (clamped to the list); an unknown name leaves the order unchanged.
export function moveHost(order:string[],name:string,index:number):string[] {
 if(!order.includes(name))return order;
 const rest=order.filter(n=>n!==name);rest.splice(Math.max(0,Math.min(rest.length,index)),0,name);return rest;
}
// Reorder the visible subset in-place while leaving filtered-out hosts in their saved slots.
export function mergeVisibleOrder(order:string[],visibleOrder:string[]):string[] {
 const visible=new Set(visibleOrder);let next=0;
 return order.map(name=>visible.has(name)?visibleOrder[next++]:name);
}
