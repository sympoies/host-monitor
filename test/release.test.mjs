import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const {version}=JSON.parse(await fs.readFile(root+'/package.json','utf8'));
const packageRelease=(out,tag,env={})=>exec('bash',[root+'/scripts/package-release.sh',out,tag],{env:{...process.env,SOURCE_DATE_EPOCH:'1700000000',...env}});
test('release packaging produces a pinnable, checksummed artifact that installs through the documented path',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-release-'));
 try{
  const out=tmp+'/release';const result=JSON.parse((await packageRelease(out,'v'+version)).stdout);
  assert.equal(result.version,version);assert.match(result.artifact,/^[a-f0-9]{64}$/);
  const tarball=`host-monitor-${version}-${result.artifact}.tar.gz`;assert.equal(result.tarball,tarball);
  assert.deepEqual((await fs.readdir(out)).sort(),['SHA256SUMS','artifact-id',tarball,'install-release.sh','verify-artifact.mjs'].sort());
  assert.equal(await fs.readFile(out+'/artifact-id','utf8'),result.artifact+'\n');
  const sums=await fs.readFile(out+'/SHA256SUMS','utf8');assert.deepEqual(sums.trim().split('\n').map(l=>l.split('  ')[1]).sort(),['artifact-id',tarball,'install-release.sh','verify-artifact.mjs'].sort());
  await exec('sha256sum',['--check','--strict','SHA256SUMS'],{cwd:out});
  // Infra install path: download, verify checksums, extract, verify the artifact identity, install.
  const extract=tmp+'/extract';await fs.mkdir(extract);await exec('tar',['-xzf',path.join(out,tarball),'-C',extract]);
  const artifact=path.join(extract,`host-monitor-${version}-${result.artifact}`);assert.deepEqual(await fs.readdir(extract),[path.basename(artifact)]);
  await exec(process.execPath,[out+'/verify-artifact.mjs',artifact,result.artifact]);
  const installed=(await exec('bash',[out+'/install-release.sh',process.execPath,artifact,result.artifact,tmp+'/prefix'])).stdout.trim().split('\n').at(-1);
  assert.equal(installed,path.join(tmp,'prefix/.local/share/host-monitor/releases',result.artifact));
  // Rebuilding the same source with the same timestamp reproduces the same tarball bytes.
  const again=tmp+'/again';await packageRelease(again,'v'+version);
  assert.equal(await fs.readFile(again+'/SHA256SUMS','utf8'),sums);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('release packaging refuses a tag that does not match the package version',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-release-'));
 try{
  await assert.rejects(packageRelease(tmp+'/out','v0.0.0-mismatch'),error=>error.code===65&&error.stderr.includes(`does not match package version v${version}`));
  await assert.rejects(fs.access(tmp+'/out'));
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
