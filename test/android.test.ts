import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {ADB_SCRIPT,adbSections,androidSnapshot,androidAttention} from '../src/android.ts';
import {projectSnapshot} from '../src/schema.ts';
// Recorded from a USB-attached Android 16 test device with ADB_SCRIPT; battery dates and charge counters are replaced.
const fixture=fs.readFileSync(path.join(import.meta.dirname,'fixtures/android/adb-shell.txt'),'utf8');
const at=Date.parse('2026-09-29T00:00:00Z');
const snap=(text=fixture)=>androidSnapshot('phone-a',text,at);
const kinds=(text:string)=>snap(text).attention.map(a=>[a.kind,a.title,a.severity]);

test('one adb shell script reads every section read-only and ends with a completion marker',()=>{
 for(const section of ['battery','protect','thermal','meminfo','df','uptime','ps','props','end'])assert.ok(ADB_SCRIPT.includes('echo @@'+section),section);
 assert.doesNotMatch(ADB_SCRIPT,/settings put|svc |am |pm |input |reboot|setprop|rm /);
 assert.deepEqual(Object.keys(adbSections(fixture)),['battery','protect','thermal','meminfo','df','uptime','ps','props']);
});
test('the recorded device output becomes a host snapshot with battery, protection, thermal, memory, and /data',()=>{
 const s=snap();
 assert.equal(s.host,'phone-a');assert.equal(s.platform,'android');assert.equal(s.resources,'collected');assert.equal(s.collectedAt,new Date(at).toISOString());
 assert.deepEqual(s.android?.battery,{level:84,health:'good',temperature:31.9,status:'not-charging',power:'usb'});
 assert.equal(s.android?.protection,true);
 assert.equal(s.android?.thermal?.status,0);
 assert.deepEqual(s.android?.thermal?.sensors,[{name:'AP',temperature:32.3},{name:'BAT',temperature:31.9},{name:'PATHM',temperature:34.3},{name:'SKIN',temperature:32.2},{name:'USB',temperature:31.3}]);
 assert.equal(s.android?.model,'SM-S9010');assert.equal(s.android?.release,'16');
 assert.equal(s.memory?.total,7394216*1024);assert.equal(s.memory?.available,2792284*1024);
 assert.deepEqual(s.disks,[{source:'/dev/block/dm-58',type:'',total:110120908*1024,used:10737896*1024,available:99251940*1024,percent:10,mount:'/data'}]);
 assert.deepEqual(s.hardware,{cpuCount:6,load:[2.49,2.33,2.44],uptime:266313.4,kernel:'5.10.236-android12-9-31998796-abS9010ZHSBGZH3'});
 assert.deepEqual(s.services.map(v=>[v.name,v.manager,v.required,v.health]),[['sshd','termux',true,'ok'],['tailscale','android',false,'ok']]);
 assert.deepEqual(s.collectionIssues,[]);assert.deepEqual(s.attention,[]);
});
test('the server projection keeps the Android fields and drops anything else',()=>{
 const s=snap() as unknown as Record<string,unknown>;const android={...(s.android as object),serial:'private-canary'};
 const projected=projectSnapshot({...s,android});
 assert.deepEqual(projected.android,snap().android);
 assert.equal(JSON.stringify(projected).includes('private-canary'),false);
});
test('a hot battery, bad health, and a nearly full /data need attention',()=>{
 assert.deepEqual(kinds(fixture.replace('temperature: 319','temperature: 452')),[['device','Battery temperature','error']]);
 assert.equal(snap(fixture.replace('temperature: 319','temperature: 449')).attention.length,0);
 assert.deepEqual(kinds(fixture.replace('  health: 2','  health: 3')),[['device','Battery health','error']]);
 assert.equal(snap(fixture.replace('  health: 2','  health: 3')).attention[0].detail,'overheat');
 assert.deepEqual(kinds(fixture.replace(' 10% /storage',' 90% /storage')),[['device','/data storage','warning']]);
 assert.deepEqual(kinds(fixture.replace(' 10% /storage',' 96% /storage')),[['device','/data storage','error']]);
 assert.equal(snap(fixture.replace(' 10% /storage',' 89% /storage')).attention.length,0);
});
test('battery protection off needs attention only while the device is on external power',()=>{
 const off=fixture.replace('@@protect\n1\n','@@protect\n0\n');
 assert.deepEqual(kinds(off),[['device','Battery protection off','warning']]);
 assert.deepEqual(kinds(off.replace('USB powered: true','USB powered: false')),[]);
 // A device without Samsung battery protection reports null: unknown, never an alert.
 const unknown=snap(fixture.replace('@@protect\n1\n','@@protect\nnull\n'));assert.equal(unknown.android?.protection,null);assert.deepEqual(unknown.attention,[]);
});
test('a missing Termux sshd is a required service error; a stopped Tailscale app is only shown',()=>{
 const noSshd=snap(fixture.replace('u0_a328      sshd\n',''));
 assert.deepEqual(noSshd.services.find(v=>v.name==='sshd')?.health,'error');
 assert.deepEqual(noSshd.attention.map(a=>[a.kind,a.title,a.severity]),[['service','sshd','error']]);
 // An sshd that does not belong to the Termux app user is not the Termux sshd.
 assert.equal(snap(fixture.replace('u0_a328      sshd','u0_a999      sshd')).services.find(v=>v.name==='sshd')?.health,'error');
 const noTailscale=snap(fixture.replace('u0_a321      com.tailscale.ipn\n',''));
 assert.equal(noTailscale.services.find(v=>v.name==='tailscale')?.health,'inactive');assert.deepEqual(noTailscale.attention,[]);
});
test('an unreadable section is a collection issue; truncated output is rejected as a whole',()=>{
 const broken=snap(fixture.replace(/@@thermal\n[\s\S]*?@@meminfo/,'@@thermal\nCan\'t find service: thermalservice\n@@meminfo'));
 assert.deepEqual(broken.collectionIssues,['thermal unavailable']);assert.equal(broken.android?.thermal,undefined);
 assert.deepEqual(broken.attention.map(a=>a.kind),['collection']);
 assert.throws(()=>snap(fixture.replace('@@end\n','')),/incomplete-adb-output/);
 assert.throws(()=>snap('error: device offline\n'),/incomplete-adb-output/);
 assert.throws(()=>snap(fixture.replace(/@@uptime\n[\s\S]*?@@ps/,'@@uptime\n@@ps')),/invalid-android-hardware/);
});
test('attention for a partial snapshot uses only the Android rules, not the Linux memory and disk thresholds',()=>{
 assert.deepEqual(androidAttention({collectionIssues:[],services:[],memory:{total:100,available:1},disks:[{percent:86,mount:'/data'}]}),[]);
});
