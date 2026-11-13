import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=(name:string)=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const {fleet,events}=JSON.parse(read('docs/images/dashboard-fixture.json'));
test('the README screenshot fixture is four fictional hosts showing healthy, failing, resource-pressure, and stale states',()=>{
 assert.deepEqual(fleet.hosts.map((host:{name:string})=>host.name),['alpha','bravo','charlie','delta']);
 const [alpha,bravo,,delta]=fleet.hosts;
 assert.ok(alpha.snapshot.services.some((service:{health:string})=>service.health==='error'),'a failed unit');
 assert.ok(alpha.snapshot.containers.some((container:{state:string})=>container.state==='exited'),'a required container that is not running');
 assert.ok(alpha.snapshot.probes.some((probe:{ok:boolean})=>!probe.ok),'a failed probe');
 assert.ok(alpha.snapshot.memory.available/alpha.snapshot.memory.total<0.15&&alpha.snapshot.disks.some((disk:{percent:number})=>disk.percent>=90),'resource pressure');
 assert.equal(bravo.snapshot.attention.length,0);assert.equal(delta.status,'offline');assert.equal(delta.stale,true);
 assert.ok(events.every((event:{host:string})=>event.host==='alpha'));
});
test('the README shows the generated screenshot right after the opening paragraph, with alt text',()=>{
 const readme=read('README.md'),image=readme.match(/^!\[([^\]]{20,})\]\((docs\/images\/dashboard\.png)\)$/m);
 assert.ok(image,'image reference with descriptive alt text');assert.ok(fs.existsSync(new URL('../'+image[2],import.meta.url)));
 const [heading,opening,reference]=readme.split('\n').filter(Boolean);assert.equal(heading,'# Host Monitor');assert.ok(opening&&reference?.startsWith('!['));
});
