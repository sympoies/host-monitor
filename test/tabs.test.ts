import {test} from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_TAB_ORDER,mergeTabOrder,loadTabState,saveTabState,clearTabState,moveTab,moveVisibleTab} from '../public/tabs.ts';
const memory=(initial?:string)=>{let value=initial,key='';return {getItem:()=>value??null,setItem:(name:string,v:string)=>{key=name;value=v;},removeItem:()=>{value=undefined;},peek:()=>value,peekKey:()=>key};};
const broken={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');},removeItem:()=>{throw Error('blocked');}};
test('tab defaults match the sessions-first host detail section order',()=>assert.deepEqual(DEFAULT_TAB_ORDER,['agents','disks','checks','events','services']));
test('saved tab order drops removed ids, keeps valid order, and appends sections added later',()=>{
 assert.deepEqual(mergeTabOrder(['events','gone','resources','events'],['resources','disks','checks','events','agents','services','network']),['events','resources','disks','checks','agents','services','network']);
 assert.deepEqual(mergeTabOrder(['agents'],DEFAULT_TAB_ORDER),['agents','disks','checks','events','services']);
 assert.deepEqual(mergeTabOrder(null,DEFAULT_TAB_ORDER),DEFAULT_TAB_ORDER);
});
test('selected tab and reordered sections persist in one versioned browser key',()=>{
 const store=memory();assert.deepEqual(loadTabState(store,DEFAULT_TAB_ORDER),{order:DEFAULT_TAB_ORDER,selected:'agents'});
 const state={order:moveTab(DEFAULT_TAB_ORDER,'services',0),selected:'agents'};assert.equal(saveTabState(store,state),true);assert.deepEqual(loadTabState(store,DEFAULT_TAB_ORDER),state);assert.equal(store.peekKey(),'host-monitor.hostTabs.v1');
 clearTabState(store);assert.deepEqual(loadTabState(store,DEFAULT_TAB_ORDER),{order:DEFAULT_TAB_ORDER,selected:'agents'});
});
test('corrupt and unavailable storage fall back safely; an unknown selected tab resets',()=>{
 assert.deepEqual(loadTabState(memory('{bad json'),DEFAULT_TAB_ORDER),{order:DEFAULT_TAB_ORDER,selected:'agents'});
 assert.deepEqual(loadTabState(memory(JSON.stringify({order:['agents','gone'],selected:'gone'})),DEFAULT_TAB_ORDER),{order:['agents','disks','checks','events','services'],selected:'agents'});
 assert.deepEqual(loadTabState(broken,DEFAULT_TAB_ORDER),{order:DEFAULT_TAB_ORDER,selected:'agents'});assert.equal(saveTabState(broken,{order:DEFAULT_TAB_ORDER,selected:'agents'}),false);assert.doesNotThrow(()=>clearTabState(broken));
});
test('move controls reorder visible tabs without shifting hidden sections',()=>{
 const order=['resources','disks','checks','events','agents','services'];const visible=['resources','events','agents'];
 assert.deepEqual(moveVisibleTab(order,visible,'agents',-1),['resources','disks','checks','agents','events','services']);
 assert.deepEqual(moveVisibleTab(order,visible,'resources',-1),order);
});

test('saved resource selection migrates to sessions while the stable agents id retains its position',()=>{
 const saved=memory(JSON.stringify({order:['events','resources','agents','services','disks','checks'],selected:'resources'}));
 assert.deepEqual(loadTabState(saved,DEFAULT_TAB_ORDER),{order:['events','agents','services','disks','checks'],selected:'agents'});
});
