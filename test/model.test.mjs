import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseMeminfo,cpuBusy,classifyUnit,parseDisks,attentionFor} from '../src/model.mjs';
import {collectSystemd,journal} from '../src/collector.mjs';
test('available memory includes reclaimable cache and invalid snapshots are rejected',()=>{
 const m=parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 700 kB\nSwapTotal: 100 kB\nSwapFree: 60 kB');assert.equal(m.used,300*1024);assert.equal(m.swapUsed,40*1024);assert.throws(()=>parseMeminfo('MemTotal: 1 kB\nMemAvailable: 2 kB'));
});
test('templates remain installed inventory without invalid show requests and aliases inherit canonical health',async()=>{
 const run=async(_bin,args)=>{
  if(args.includes('list-unit-files'))return JSON.stringify([{unit_file:'worker@.service',state:'disabled'},{unit_file:'sshd.service',state:'alias'}]);
  if(args.includes('list-units'))return '[]';
  assert.ok(!args.includes('worker@.service'));assert.ok(args.some(a=>a.includes('Names')));
  return 'Id=ssh.service\nNames=ssh.service sshd.service\nActiveState=active\nResult=success\n';
 };
 const rows=await collectSystemd('system',['sshd.service'],run);
 assert.equal(rows.find(r=>r.name==='sshd.service').health,'ok');
 assert.equal(rows.find(r=>r.name==='worker@.service').active,'inactive');
});
test('journal queries partition system and user scope explicitly',async()=>{
 for(const scope of ['system','user']){
  const rows=await journal(scope,async(_bin,args)=>{assert.ok(args.includes('--'+scope));return JSON.stringify({_SYSTEMD_UNIT:'user@1000.service',_SYSTEMD_USER_UNIT:'example.service',__REALTIME_TIMESTAMP:'1000000'});});
  assert.equal(rows[0].scope,scope);assert.equal(rows[0].count,1);
 }
});
test('CPU percentages use counter deltas and exclude idle and IO wait',()=>{assert.equal(cpuBusy([10,0,10,70,10,0,0,0],[20,0,20,140,20,0,0,0]),20);assert.equal(cpuBusy([1,1],[1,1]),null);});
test('successful dormant oneshots are idle; required stopped services and failed results are errors',()=>{
 assert.equal(classifyUnit({name:'backup.service',active:'inactive',type:'oneshot',result:'success'}),'idle');
 assert.equal(classifyUnit({name:'web.service',active:'inactive',result:'success'},['web.service']),'error');
 assert.equal(classifyUnit({name:'backup.service',active:'inactive',type:'oneshot',result:'exit-code'}),'error');
 assert.equal(classifyUnit({name:'optional.service',active:'inactive',result:'success'}),'inactive');
});
test('disk inventory excludes ephemeral filesystems and preserves mounts containing spaces',()=>{const d=parseDisks('Filesystem Type 1B-blocks Used Avail Use% Mounted on\n/dev/root ext4 1000 100 900 10% /\ntmpfs tmpfs 100 1 99 1% /run\n/dev/data ext4 1000 900 100 90% /some folder');assert.equal(d.length,2);assert.equal(d[1].mount,'/some folder');});
test('attention combines independent probe and collection failures without hiding them behind running state',()=>{const a=attentionFor({collectionIssues:['user services unavailable'],services:[{scope:'user',name:'web.service',active:'active',health:'ok'}],probes:[{name:'web API',ok:false,status:500}],disks:[{mount:'/',percent:96}]});assert.deepEqual(a.map(e=>e.kind),['collection','disk','probe']);});
test('installed inactive services remain visible and missing required units need attention',async()=>{
 const run=async(_bin,args)=>args.includes('list-unit-files')?JSON.stringify([{unit_file:'idle.service',state:'disabled'}]):args.includes('list-units')?'[]':'Id=idle.service\nActiveState=inactive\nType=oneshot\nResult=success\n\nId=missing.service\nActiveState=inactive\nResult=success\n';
 const rows=await collectSystemd('user',['missing.service'],run);assert.equal(rows.find(u=>u.name==='idle.service').health,'idle');assert.equal(rows.find(u=>u.name==='missing.service')?.health,'error');
});
