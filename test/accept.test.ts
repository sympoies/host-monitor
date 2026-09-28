import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {resourceExpectation,EXTERNAL_RESOURCE_TEXT} from '../scripts/accept-expectations.ts';
// A /api/fleet payload with one host of each resources state, as the browser acceptance reads it.
const fleet=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'fixtures','fleet-mixed.json'),'utf8'));
const snapshot=(name:string)=>fleet.hosts.find((h:{name:string})=>h.name===name).snapshot;
test('a host that collects its own resources expects four metrics and disk rows',()=>{
 assert.deepEqual(resourceExpectation(snapshot('linux-a')),{resources:'collected',metrics:4,diskRows:true});
});
test('an external-resource host expects the Beszel pointer: two metrics and a disk note',()=>{
 assert.deepEqual(resourceExpectation(snapshot('mac-a')),{resources:'external',metrics:2,diskRows:false,text:EXTERNAL_RESOURCE_TEXT});
});
test('a snapshot without the optional resources field is treated as collected, like the dashboard',()=>{
 assert.equal(resourceExpectation(snapshot('linux-legacy')).resources,'collected');
});
test('a host without a snapshot has no resource expectation',()=>{
 assert.throws(()=>resourceExpectation(snapshot('offline-a')),/no snapshot/);
});
test('the dashboard renders the text the external expectation looks for, in the resources and disks panels',()=>{
 const app=fs.readFileSync(path.join(import.meta.dirname,'..','public','app.ts'),'utf8');
 assert.ok(app.includes(`metric('資源指標','${EXTERNAL_RESOURCE_TEXT}'`));
 assert.ok(app.includes(`'此主機的磁碟容量由 ${EXTERNAL_RESOURCE_TEXT} 監控'`));
});
test('the browser acceptance takes its resource assertions from the expectation',()=>{
 const script=fs.readFileSync(path.join(import.meta.dirname,'..','scripts','accept-browser.ts'),'utf8');
 assert.ok(script.includes("from './accept-expectations.ts'"));
 assert.ok(!script.includes("count(),4)"),'no hard-coded four-metric assertion');
});
