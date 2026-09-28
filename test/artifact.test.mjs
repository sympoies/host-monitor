import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
test('collector CLI executes through the installed current-release symlink',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-entry-'));
 try{await fs.symlink(root,tmp+'/current');await fs.writeFile(tmp+'/host.json',JSON.stringify({name:'intentional-identity-mismatch'}));
 await assert.rejects(exec(process.execPath,[tmp+'/current/src/collector.mjs','--config',tmp+'/host.json']),error=>error.code===1&&error.stderr.includes('host-identity-mismatch'));
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('artifact admission rejects added files, symlinks and changed content before installation',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-artifact-'));
 try{
  const artifact=path.join(tmp,'artifact');const built=await exec(process.execPath,[root+'/scripts/build-artifact.mjs',artifact]);const hash=JSON.parse(built.stdout).artifact;
  const verify=()=>exec(process.execPath,[root+'/scripts/verify-artifact.mjs',artifact,hash]);
  await verify();await fs.writeFile(artifact+'/extra','unexpected');await assert.rejects(verify,/inventory mismatch/);await fs.unlink(artifact+'/extra');
  await fs.symlink('/dev/null',artifact+'/link');await assert.rejects(verify,/non-regular entry/);await fs.unlink(artifact+'/link');
  await fs.appendFile(artifact+'/public/app.js','\n// changed');await assert.rejects(verify,/file mismatch/);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
