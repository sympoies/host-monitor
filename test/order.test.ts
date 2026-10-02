import {test} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import net from 'node:net';
import {mergeOrder,loadOrder,saveOrder,clearOrder,moveHost} from '../public/order.ts';import {createMonitor} from '../src/server.ts';
const defaults=['a','b','c','d'];
const memory=(initial?:string)=>{let value=initial;return {getItem:()=>value??null,setItem:(_:string,v:string)=>{value=v;},removeItem:()=>{value=undefined;},peek:()=>value};};
const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');},removeItem:()=>{throw new Error('denied');}};
test('a saved order keeps its sequence, drops removed hosts, and appends new hosts in default order',()=>{
 assert.deepEqual(mergeOrder(['c','a'],defaults),['c','a','b','d']);
 assert.deepEqual(mergeOrder(['gone','d','b','b'],defaults),['d','b','a','c']);
 assert.deepEqual(mergeOrder(undefined,defaults),defaults);
 assert.deepEqual(mergeOrder([1,null,'c'],defaults),['c','a','b','d']);
 assert.deepEqual(mergeOrder('not-a-list',defaults),defaults);
});
test('storage failures and corrupt values fall back to the default order',()=>{
 assert.deepEqual(loadOrder(broken,defaults),defaults);
 assert.deepEqual(loadOrder(memory('{bad json'),defaults),defaults);
 assert.deepEqual(loadOrder(memory(),defaults),defaults);
 assert.equal(saveOrder(broken,['b','a']),false);assert.doesNotThrow(()=>clearOrder(broken));
 const store=memory();assert.equal(saveOrder(store,['b','a']),true);assert.deepEqual(loadOrder(store,defaults),['b','a','c','d']);
 clearOrder(store);assert.deepEqual(loadOrder(store,defaults),defaults);
});
test('moving a host places it at the target index or by one step and clamps at the ends',()=>{
 assert.deepEqual(moveHost(defaults,'d',0),['d','a','b','c']);
 assert.deepEqual(moveHost(defaults,'a',2),['b','c','a','d']);
 assert.deepEqual(moveHost(defaults,'a',-1),['a','b','c','d']);
 assert.deepEqual(moveHost(defaults,'a',99),['b','c','d','a']);
 assert.deepEqual(moveHost(defaults,'zzz',1),defaults);
});
const host=(name:string)=>({name,ssh:name,node:'/usr/bin/node',collector:'/app/collector.ts',config:'/app/host.json'});
async function fleet(config:object){const m=createMonitor({hosts:['a','b','c'].map(host),...config} as any,{run:async()=>{throw Error('x');}});m.server.listen(0,'127.0.0.1');await once(m.server,'listening');
 try{return await (await fetch('http://127.0.0.1:'+(m.server.address() as net.AddressInfo).port+'/api/fleet')).json() as any;}finally{m.stop();await new Promise(r=>m.server.close(r));}}
test('hostOrder sets the default order; unlisted hosts follow in configuration order',async()=>{
 assert.deepEqual((await fleet({})).defaultOrder,['a','b','c']);
 assert.deepEqual((await fleet({hostOrder:['c','a']})).defaultOrder,['c','a','b']);
});
test('hostOrder must name configured hosts once',()=>{
 for(const bad of [['zzz'],['a','a'],'a',[1],Array(101).fill('a')])assert.throws(()=>createMonitor({hosts:[host('a')],hostOrder:bad} as any),/invalid-host-order/);
});
