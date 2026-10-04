import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {resourceExpectation,EXTERNAL_RESOURCE_TEXT,AGENTLESS_TEXT} from '../scripts/accept-expectations.ts';
// A /api/fleet payload with one host of each resources state, as the browser acceptance reads it.
const fleet=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'fixtures','fleet-mixed.json'),'utf8'));
const snapshot=(name:string)=>fleet.hosts.find((h:{name:string})=>h.name===name).snapshot;
test('a host that collects its own resources expects four metrics and disk rows',()=>{
 assert.deepEqual(resourceExpectation(snapshot('linux-a')),{resources:'collected',metrics:4,diskRows:true});
});
test('an external-resource host expects metric slots and a Beszel no-data note',()=>{
 assert.deepEqual(resourceExpectation(snapshot('mac-a')),{resources:'external',metrics:4,diskRows:false,text:EXTERNAL_RESOURCE_TEXT});
});
test('an agentless host expects its own pointer and no service inventory',()=>{
 assert.deepEqual(resourceExpectation({resources:'external',agentless:true}),{resources:'external',metrics:4,diskRows:false,text:EXTERNAL_RESOURCE_TEXT});
});
test('the dashboard renders the text the agentless expectation looks for, in the resources and disks panels',()=>{
 const app=fs.readFileSync(path.join(import.meta.dirname,'..','public','app.ts'),'utf8');
 assert.ok(app.includes(`metric('資源指標','未安裝 collector','${AGENTLESS_TEXT}`));
 assert.ok(app.includes(`'${AGENTLESS_TEXT}：不採集磁碟容量'`));
});
test('a snapshot without the optional resources field is treated as collected, like the dashboard',()=>{
 assert.equal(resourceExpectation(snapshot('linux-legacy')).resources,'collected');
});
test('a host without a snapshot has no resource expectation',()=>{
 assert.throws(()=>resourceExpectation(snapshot('offline-a')),/no snapshot/);
});
test('Beszel freshness and optional GPU count drive installed resource expectations',()=>{
 assert.deepEqual(resourceExpectation({resources:'external'},{status:'ok',disks:[{}],gpus:[{},{}]}),{resources:'external',metrics:5,diskRows:true,text:EXTERNAL_RESOURCE_TEXT});
 for(const status of ['stale','unavailable'])assert.deepEqual(resourceExpectation({resources:'external'},{status,disks:[{}],gpus:[{},{}]}),{resources:'external',metrics:4,diskRows:false,text:EXTERNAL_RESOURCE_TEXT});
});
test('the browser acceptance takes its resource assertions from the expectation',()=>{
 const script=fs.readFileSync(path.join(import.meta.dirname,'..','scripts','accept-browser.ts'),'utf8');
 assert.ok(script.includes("from './accept-expectations.ts'"));
 assert.ok(!script.includes("count(),4)"),'no hard-coded four-metric assertion');
});
test('an Android device collects its own resources: four metrics (battery, temperature, memory, /data) and disk rows',()=>{
 assert.deepEqual(resourceExpectation(snapshot('phone-a')),{resources:'collected',metrics:4,diskRows:true});
 const app=fs.readFileSync(path.join(import.meta.dirname,'..','public','app.ts'),'utf8');
 for(const label of ['電池電量','電池溫度','記憶體使用率','/data 儲存空間'])assert.ok(app.includes(`metric('${label}'`),label);
});
test('dashboard tabs preserve the current host section order, with checks and events after disk capacity',()=>{
 const html=fs.readFileSync(path.join(import.meta.dirname,'..','public','index.html'),'utf8');
 const panels=[...html.matchAll(/<section\b[^>]*class="[^"]*\bpanel\b[^"]*"[^>]*>([\s\S]*?)<\/section>/g)]
  .map(([,panel])=>panel.match(/<h2\b[^>]*>([^<]+)<\/h2>/)?.[1]);
 const disk=panels.indexOf('磁碟容量');
 assert.deepEqual(panels.slice(disk,disk+3),['磁碟容量','功能檢查與最近錯誤','最近事件']);
 assert.deepEqual(panels.slice(0,6),['資源指標','磁碟容量','功能檢查與最近錯誤','最近事件','工作階段','服務']);
 assert.match(html,/id="host-tabs"[^>]*role="tablist"/);
 assert.match(html,/id="attention"[^>]*>[\s\S]*?<div class="tab-tools"/);
 assert.match(html,/aria-labelledby="tab-agents"/);
});
