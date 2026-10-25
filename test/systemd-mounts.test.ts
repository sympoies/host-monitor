import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {collectSystemdMounts} from '../src/collector.ts';

test('required generated mounts are collected by exact escaped unit name and retain inactive, missing, and failed states',async()=>{
 const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/systemd/mounts.json',import.meta.url),'utf8')) as {
  properties:Record<string,string>[];
 };
 const calls:string[][]=[];
 const run=async(_bin:string,args:string[])=>{
  calls.push(args);
  assert.equal(args[0],'show');
  assert.ok(args.includes('--'));
  const requested=args.slice(args.indexOf('--')+1);
  assert.deepEqual(requested,['srv-data\\x2darchive.mount','missing.mount','srv-cache.mount']);
  return fixture.properties.map(p=>Object.entries(p).map(([key,value])=>`${key}=${value}`).join('\n')).join('\n\n');
 };
 const required=['srv-data\\x2darchive.mount','missing.mount','srv-cache.mount','bad;unit.mount'];
 const rows=await collectSystemdMounts('system',required,run);
 assert.deepEqual(rows.map(r=>[r.name,r.active,r.health,r.required]),[
  ['srv-data\\x2darchive.mount','inactive','error',true],
  ['missing.mount','inactive','error',true],
  ['srv-cache.mount','failed','error',true]
 ]);
 assert.equal(rows.find(r=>r.name==='missing.mount')?.installed,'missing');
 assert.ok(calls.every(args=>!args.some(arg=>arg.includes(';'))),'unit names are passed as individual arguments');
});

test('no systemctl query is made when no required mount is configured',async()=>{
 let called=false;
 const rows=await collectSystemdMounts('system',[],async()=>{called=true;throw new Error('unexpected-call');});
 assert.deepEqual(rows,[]);assert.equal(called,false);
});
