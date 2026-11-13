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
test('every string in the fixture stays within the fictional example set',()=>{
 const strings:string[]=[];(function walk(value:unknown){if(typeof value==='string')strings.push(value);else if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')Object.values(value).forEach(walk);})([fleet,events]);
 assert.ok(strings.length>100);
 // Nothing that could identify a real network, machine, person, or credential: addresses, accounts, paths, domains, URLs, token-like runs.
 const forbidden=[/\b\d{1,3}(\.\d{1,3}){3}\b/,/[0-9a-f]{1,4}(:[0-9a-f]{0,4}){3,}/i,/@/,/:\/\//,/(^|[\s"'=])(~|\/(home|Users|root|etc|var|opt|srv|mnt)\b)/,/\.(ts\.net|local|lan|internal|corp|com|net|org|io|dev|app)\b/i,/[A-Za-z0-9+\/_-]{32,}/];
 for(const text of strings)for(const pattern of forbidden)assert.ok(!pattern.test(text),`${JSON.stringify(text)} matches ${pattern}`);
 const fictional=(name:string)=>/^(alpha|bravo|charlie|delta)$/.test(name);
 for(const host of fleet.hosts){assert.ok(fictional(host.name)&&fictional(host.snapshot.host));}
 for(const session of fleet.hosts[0].snapshot.agentSessions.sessions)assert.match(session.repoName,/^example\//);
 for(const container of fleet.hosts[0].snapshot.containers)assert.match(container.image,/^example\//);
});
test('docs/images/dashboard.png is a real 1280 px wide PNG of a modest size',()=>{
 const png=fs.readFileSync(new URL('../docs/images/dashboard.png',import.meta.url));
 assert.deepEqual([...png.subarray(0,8)],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],'PNG signature');
 assert.equal(png.subarray(12,16).toString('latin1'),'IHDR');assert.equal(png.readUInt32BE(16),1280);assert.ok(png.length<300*1024);
 // Only image data chunks: no text, EXIF, or time metadata that could carry a name or path.
 const chunks:string[]=[];for(let at=8;at<png.length;at+=12+png.readUInt32BE(at))chunks.push(png.subarray(at+4,at+8).toString('latin1'));
 assert.ok(chunks.every(name=>['IHDR','PLTE','tRNS','IDAT','IEND'].includes(name)),chunks.join());
});
test('the README shows the generated screenshot right after the opening paragraph, with alt text',()=>{
 const readme=read('README.md'),image=readme.match(/^!\[([^\]]{20,})\]\((docs\/images\/dashboard\.png)\)$/m);
 assert.ok(image,'image reference with descriptive alt text');assert.ok(fs.existsSync(new URL('../'+image[2],import.meta.url)));
 const [heading,opening,reference]=readme.split('\n').filter(Boolean);assert.equal(heading,'# Host Monitor');assert.ok(opening&&reference?.startsWith('!['));
});
