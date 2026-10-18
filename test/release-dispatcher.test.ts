import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..'),script=root+'/.agents/scripts/release.sh';
const ARTIFACT='a'.repeat(64);
const git=(cwd:string,...args:string[])=>exec('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','tag.gpgsign=false',...args],{cwd});
// A throwaway repository with a bare remote and a stubbed packager: nothing here can touch the real repository or its tags.
async function fixture(opts:{version?:string;devlog?:string;remoteTag?:string}={}){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-dispatch-'));
 const remote=tmp+'/remote.git',repo=tmp+'/repo';
 await exec('git',['init','--bare','--initial-branch=main',remote]);
 await exec('git',['init','--initial-branch=main',repo]);
 await fs.mkdir(repo+'/.agents/scripts',{recursive:true});await fs.mkdir(repo+'/scripts');await fs.mkdir(repo+'/docs/devlog',{recursive:true});
 await fs.copyFile(script,repo+'/.agents/scripts/release.sh');await fs.chmod(repo+'/.agents/scripts/release.sh',0o755);
 const version=opts.version??'1.2.3';
 await fs.writeFile(repo+'/package.json',JSON.stringify({name:'fixture',version}));
 await fs.writeFile(repo+'/docs/devlog/README.md','# Development log\n');
 await fs.writeFile(repo+'/docs/devlog/2026-01.md',opts.devlog??`# 2026-01\n\n## 2026-01-02 - ${version}: fixture release\n`);
 await fs.writeFile(repo+'/scripts/package-release.sh',`#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p "$1"\nprintf '%s\\n' ${ARTIFACT} >"$1/artifact-id"\nprintf '{"version":"${version}","artifact":"${ARTIFACT}","tarball":"x.tar.gz"}\\n'\n`);
 await git(repo,'add','-A');await git(repo,'commit','-m','fixture');
 await git(repo,'remote','add','origin',remote);await git(repo,'push','origin','main');
 if(opts.remoteTag){await git(repo,'tag',opts.remoteTag);await git(repo,'push','origin',opts.remoteTag);await git(repo,'tag','-d',opts.remoteTag);}
 const snapshot=async()=>(await git(repo,'for-each-ref')).stdout+(await git(repo,'status','--porcelain')).stdout+(await exec('git',['for-each-ref'],{cwd:remote})).stdout;
 const run=(...args:string[])=>exec('bash',[repo+'/.agents/scripts/release.sh',...args],{cwd:repo}).then(r=>({code:0,...r}),(e:any)=>({code:e.code as number,stdout:e.stdout as string,stderr:e.stderr as string}));
 return {tmp,repo,remote,run,snapshot,version,done:()=>fs.rm(tmp,{recursive:true,force:true})};
}
test('script is executable and requires an explicit mode',async()=>{
 await fs.access(script,fs.constants.X_OK);
 const f=await fixture();
 try{
  for(const args of [[],['--dry-run','--execute'],['--bogus']]){const r=await f.run(...args);assert.equal(r.code,64);assert.match(r.stderr,/usage/);}
 }finally{await f.done();}
});
test('dry-run reports the planned version, tag, artifact, and steps without mutating anything',async()=>{
 const f=await fixture();
 try{
  const before=await f.snapshot();const head=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  const r=await f.run('--dry-run');
  assert.equal(r.code,0,r.stderr);
  assert.match(r.stdout,/nothing was tagged, pushed, or published/);
  assert.match(r.stdout,/^version: 1\.2\.3$/m);assert.match(r.stdout,/^tag: v1\.2\.3$/m);
  assert.match(r.stdout,new RegExp(`^commit: ${head}$`,'m'));assert.match(r.stdout,new RegExp(`^artifact: ${ARTIFACT}$`,'m'));
  for(const step of ['validate:','tag: git tag -s v1.2.3','push: git push origin v1.2.3','publish:','verify:'])assert.ok(r.stdout.includes('step: '+step),step);
  assert.equal(await f.snapshot(),before);
  assert.equal((await git(f.repo,'tag','--list')).stdout,'');
  assert.equal((await exec('git',['tag','--list'],{cwd:f.remote})).stdout,'');
 }finally{await f.done();}
});
test('dry-run refuses a missing devlog entry, an existing tag, and an unmerged commit',async()=>{
 let f=await fixture({devlog:'# 2026-01\n\n## 2026-01-02 - 9.9.9: other\n'});
 try{const r=await f.run('--dry-run');assert.equal(r.code,65);assert.match(r.stderr,/no devlog release entry for 1\.2\.3/);}finally{await f.done();}
 f=await fixture({remoteTag:'v1.2.3'});
 try{const r=await f.run('--dry-run');assert.equal(r.code,65);assert.match(r.stderr,/already exists on origin/);}finally{await f.done();}
 f=await fixture();
 try{
  await git(f.repo,'tag','v1.2.3');const local=await f.run('--dry-run');assert.equal(local.code,65);assert.match(local.stderr,/already exists locally/);await git(f.repo,'tag','-d','v1.2.3');
  await fs.writeFile(f.repo+'/unmerged.txt','x');await git(f.repo,'add','-A');await git(f.repo,'commit','-m','unmerged');
  const r=await f.run('--dry-run');assert.equal(r.code,65);assert.match(r.stderr,/is not merged into origin\/main/);
 }finally{await f.done();}
});
test('execute refuses before tagging when the tree is dirty or the commit is not checked out',async()=>{
 const f=await fixture();
 try{
  const first=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  await fs.writeFile(f.repo+'/scripts/extra','x');
  const dirty=await f.run('--execute');assert.equal(dirty.code,65);assert.match(dirty.stderr,/working tree is not clean/);
  await fs.rm(f.repo+'/scripts/extra');
  await fs.writeFile(f.repo+'/other.txt','x');await git(f.repo,'add','-A');await git(f.repo,'commit','-m','next');await git(f.repo,'push','origin','main');
  const moved=await f.run('--execute',first);assert.equal(moved.code,65);assert.match(moved.stderr,/check out the release commit/);
  assert.equal((await git(f.repo,'tag','--list')).stdout,'');
 }finally{await f.done();}
});
