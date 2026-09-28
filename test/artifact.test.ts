import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
test('collector CLI executes through the installed current-release symlink',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-entry-'));
 try{await fs.symlink(root,tmp+'/current');await fs.writeFile(tmp+'/host.json',JSON.stringify({name:'intentional-identity-mismatch'}));
 await assert.rejects(exec(process.execPath,[tmp+'/current/src/collector.ts','--config',tmp+'/host.json']),(error:any)=>error.code===1&&error.stderr.includes('host-identity-mismatch'));
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('artifact admission rejects added files, symlinks and changed content before installation',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-artifact-'));
 try{
  const artifact=path.join(tmp,'artifact');const built=await exec(process.execPath,[root+'/scripts/build-artifact.ts',artifact]);const hash=JSON.parse(built.stdout).artifact;
  const verify=()=>exec(process.execPath,[root+'/scripts/verify-artifact.mts',artifact,hash]);
  const manifest=JSON.parse(await fs.readFile(artifact+'/manifest.json','utf8'));assert.equal(manifest.version,JSON.parse(await fs.readFile(root+'/package.json','utf8')).version);
  await verify();await fs.writeFile(artifact+'/extra','unexpected');await assert.rejects(verify,/inventory mismatch/);await fs.unlink(artifact+'/extra');
  await fs.symlink('/dev/null',artifact+'/link');await assert.rejects(verify,/non-regular entry/);await fs.unlink(artifact+'/link');
  await fs.appendFile(artifact+'/public/app.js','\n// changed');await assert.rejects(verify,/file mismatch/);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('release installation admits only a verified artifact and is idempotent',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-install-'));
 try{
  const artifact=path.join(tmp,'artifact'),tampered=path.join(tmp,'tampered'),prefix=path.join(tmp,'prefix');
  const hash=JSON.parse((await exec(process.execPath,[root+'/scripts/build-artifact.ts',artifact])).stdout).artifact;
  const install=async(source:string)=>(await exec('bash',[root+'/scripts/install-release.sh',process.execPath,source,hash,prefix])).stdout.trim().split('\n').at(-1);
  const releases=path.join(prefix,'.local/share/host-monitor/releases'),release=path.join(releases,hash);
  await fs.cp(artifact,tampered,{recursive:true});await fs.appendFile(tampered+'/src/server.ts','\n// tampered');
  await assert.rejects(install(tampered),/file mismatch/);await assert.rejects(fs.access(release));
  assert.equal(await install(artifact),release);
  await exec(process.execPath,[root+'/scripts/verify-artifact.mts',release,hash]);
  assert.equal(await install(artifact),release);assert.deepEqual(await fs.readdir(releases),[hash]);
  await fs.appendFile(release+'/public/app.js','\n// drift');await assert.rejects(install(artifact),/file mismatch/);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('a built artifact contains every module the server and collector import',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-modules-'));
 try{await exec(process.execPath,[root+'/scripts/build-artifact.ts',tmp+'/a']);
  const {stdout}=await exec(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(tmp+'/a/src/server.ts')});await import(${JSON.stringify(tmp+'/a/src/collector.ts')});console.log('ok')`]);assert.equal(stdout.trim(),'ok');
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('the artifact runs TypeScript modules and ships the browser app as emitted JavaScript',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-emit-'));
 try{await exec(process.execPath,[root+'/scripts/build-artifact.ts',tmp+'/a']);
  const files=(JSON.parse(await fs.readFile(tmp+'/a/manifest.json','utf8')).files as {path:string}[]).map(f=>f.path);
  for(const file of ['src/server.ts','src/collector.ts','public/app.js'])assert.ok(files.includes(file),file);
  assert.ok(!files.some(f=>f.startsWith('public/')&&f.endsWith('.ts')),'browser TypeScript source must not ship');
  // A .js file is never type-stripped, so a syntax check proves the emitted app carries no TypeScript syntax.
  await exec(process.execPath,['--check',tmp+'/a/public/app.js']);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
