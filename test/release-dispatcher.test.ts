import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..'),script=root+'/.agents/scripts/release.sh';
const {version}=JSON.parse(await fs.readFile(root+'/package.json','utf8'));
const ARTIFACT='a'.repeat(64);
const git=(cwd:string,...args:string[])=>exec('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','tag.gpgsign=false',...args],{cwd,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
// A throwaway repository with a bare remote and a stubbed packager: nothing here can touch the real repository or its tags.
async function fixture(opts:{version?:string;devlog?:string;remoteTag?:string}={}){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-dispatch-'));
 const remote=tmp+'/remote.git',repo=tmp+'/repo';
 await exec('git',['init','--bare','--initial-branch=main',remote]);
 await exec('git',['init','--initial-branch=main',repo]);
 await fs.mkdir(repo+'/node_modules');await fs.mkdir(repo+'/.agents/scripts',{recursive:true});await fs.mkdir(repo+'/scripts');await fs.mkdir(repo+'/docs/devlog',{recursive:true});
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
 const bin=tmp+'/bin';await fs.mkdir(bin);await fs.mkdir(tmp+'/gnupg',{mode:0o700});
 const stub=async(name:string,body:string)=>{await fs.writeFile(bin+'/'+name,'#!/usr/bin/env bash\n'+body);await fs.chmod(bin+'/'+name,0o755);};
 // Stubs record each call so tests can assert ordering; gpg and gh behave as configured per run.
 await stub('npm','echo "npm $*" >>"$STUB_LOG"\n[[ ${STUB_VALIDATE_FAIL:-} != 1 || $1 != run ]]\n');
 await stub('gpg','case "$*" in\n*--verify*) cat >/dev/null; if [[ ${STUB_VERIFY_FAIL:-} == 1 ]]; then echo "[GNUPG:] BADSIG ABC Test"; exit 1; fi; echo "[GNUPG:] NEWSIG"; echo "[GNUPG:] GOODSIG ABC Test"; echo "[GNUPG:] VALIDSIG ABC 2026-01-01 0 0 0 0 0 0 ABC"; echo "[GNUPG:] TRUST_ULTIMATE 0 pgp" ;;\n*) cat >/dev/null; echo "[GNUPG:] SIG_CREATED D 1 8 00 0 ABC ABC" >&2; printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n" ;;\nesac\n');
 await stub('gh','echo "gh $*" >>"$STUB_LOG"\ncase "$2" in\nview) [[ ${STUB_NO_RELEASE:-} != 1 ]] || exit 1; echo https://example.invalid/releases/v1.2.3 ;;\ndownload) echo "${STUB_PUBLISHED:-'+ARTIFACT+'}" ;;\nesac\n');
 const log=tmp+'/stub.log';await fs.writeFile(log,'');
 const run=(args:string[],env:Record<string,string>={})=>exec('bash',[repo+'/.agents/scripts/release.sh',...args],{cwd:repo,env:{...process.env,PATH:bin+':'+process.env.PATH,STUB_LOG:log,GNUPGHOME:tmp+'/gnupg',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_COUNT:'3',GIT_CONFIG_KEY_0:'gpg.program',GIT_CONFIG_VALUE_0:bin+'/gpg',GIT_CONFIG_KEY_1:'user.name',GIT_CONFIG_VALUE_1:'Test',GIT_CONFIG_KEY_2:'user.email',GIT_CONFIG_VALUE_2:'test@example.invalid',RELEASE_WAIT_SECONDS:'1',RELEASE_POLL_SECONDS:'1',...env}}).then(r=>({code:0,...r}),(e:any)=>({code:e.code as number,stdout:e.stdout as string,stderr:e.stderr as string}));
 const calls=async()=>(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean);
 return {tmp,repo,remote,run,calls,snapshot,version,done:()=>fs.rm(tmp,{recursive:true,force:true})};
}
test('script is executable and requires an explicit mode',async()=>{
 await fs.access(script,fs.constants.X_OK);
 const f=await fixture();
 try{
  for(const args of [[],['--dry-run','--execute'],['--bogus']]){const r=await f.run(args);assert.equal(r.code,64);assert.match(r.stderr,/usage/);}
 }finally{await f.done();}
});
test('dry-run reports the planned version, tag, artifact, and steps without mutating anything',async()=>{
 const f=await fixture();
 try{
  const before=await f.snapshot();const head=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  const r=await f.run(['--dry-run']);
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
 try{const r=await f.run(['--dry-run']);assert.equal(r.code,65);assert.match(r.stderr,/no devlog release entry for 1\.2\.3/);}finally{await f.done();}
 f=await fixture({remoteTag:'v1.2.3'});
 try{const r=await f.run(['--dry-run']);assert.equal(r.code,65);assert.match(r.stderr,/already exists on origin/);}finally{await f.done();}
 f=await fixture();
 try{
  await git(f.repo,'tag','v1.2.3');const local=await f.run(['--dry-run']);assert.equal(local.code,65);assert.match(local.stderr,/already exists locally/);await git(f.repo,'tag','-d','v1.2.3');
  await fs.writeFile(f.repo+'/unmerged.txt','x');await git(f.repo,'add','-A');await git(f.repo,'commit','-m','unmerged');
  const r=await f.run(['--dry-run']);assert.equal(r.code,65);assert.match(r.stderr,/is not merged into origin\/main/);
 }finally{await f.done();}
});
test('execute refuses before tagging when the tree is dirty or the commit is not checked out',async()=>{
 const f=await fixture();
 try{
  const first=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  await fs.writeFile(f.repo+'/scripts/extra','x');
  const dirty=await f.run(['--execute']);assert.equal(dirty.code,65);assert.match(dirty.stderr,/working tree is not clean/);
  await fs.rm(f.repo+'/scripts/extra');
  await fs.writeFile(f.repo+'/other.txt','x');await git(f.repo,'add','-A');await git(f.repo,'commit','-m','next');await git(f.repo,'push','origin','main');
  const moved=await f.run(['--execute',first]);assert.equal(moved.code,65);assert.match(moved.stderr,/check out the release commit/);
  assert.equal((await git(f.repo,'tag','--list')).stdout,'');
 }finally{await f.done();}
});
test('execute runs validation before signing and leaves no tag when validation or signing fails',async()=>{
 let f=await fixture();
 try{
  const r=await f.run(['--execute'],{STUB_VALIDATE_FAIL:'1'});
  assert.equal(r.code,65);assert.match(r.stderr,/validate failed; no tag was created/);
  assert.deepEqual(await f.calls(),['npm ci','npm run validate']);
  assert.equal((await git(f.repo,'tag','--list')).stdout,'');assert.equal((await exec('git',['tag','--list'],{cwd:f.remote})).stdout,'');
 }finally{await f.done();}
 f=await fixture();
 try{
  // No signing key and an empty keyring: signing must fail closed.
  const r=await f.run(['--execute'],{GIT_CONFIG_VALUE_0:'/nonexistent-gpg'});
  assert.equal(r.code,65);assert.match(r.stderr,/signing tag v1\.2\.3 failed; no tag was created/);
  assert.deepEqual(await f.calls(),['npm ci','npm run validate']);
  assert.equal((await exec('git',['tag','--list'],{cwd:f.remote})).stdout,'');
 }finally{await f.done();}
});
test('execute removes a local tag whose signature does not verify and pushes nothing',async()=>{
 const f=await fixture();
 try{
  const r=await f.run(['--execute'],{STUB_VERIFY_FAIL:'1'});
  assert.equal(r.code,65);assert.match(r.stderr,/signature did not verify; local tag removed/);
  assert.equal((await git(f.repo,'tag','--list')).stdout,'');assert.equal((await exec('git',['tag','--list'],{cwd:f.remote})).stdout,'');
 }finally{await f.done();}
});
test('execute pushes the verified tag, waits for the release, and compares the published artifact id',async()=>{
 let f=await fixture();
 try{
  const r=await f.run(['--execute']);
  assert.equal(r.code,0,r.stderr);
  assert.match(r.stdout,/^release: https:\/\/example\.invalid\/releases\/v1\.2\.3$/m);assert.match(r.stdout,new RegExp(`^artifact: ${ARTIFACT}$`,'m'));
  assert.deepEqual((await f.calls()).slice(0,2),['npm ci','npm run validate']);
  const head=(await git(f.repo,'rev-parse','HEAD')).stdout.trim();
  assert.equal((await exec('git',['rev-parse','v1.2.3^{commit}'],{cwd:f.remote})).stdout.trim(),head);
 }finally{await f.done();}
 f=await fixture();
 try{
  const mismatch=await f.run(['--execute'],{STUB_PUBLISHED:'b'.repeat(64)});
  assert.equal(mismatch.code,69);assert.match(mismatch.stderr,/differs from .*tag v1\.2\.3 is already pushed/);
 }finally{await f.done();}
 f=await fixture();
 try{
  const timeout=await f.run(['--execute'],{STUB_NO_RELEASE:'1'});
  assert.equal(timeout.code,69);assert.match(timeout.stderr,/not visible within 1s.*tag v1\.2\.3 is already pushed/);
 }finally{await f.done();}
});
test('the real packager builds from the staged release commit in a dry-run',async()=>{
 // Copy the working tree (tracked and new files) into a throwaway repository so the real packager and dependencies are exercised.
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-real-'));
 try{
  const files=(await exec('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root})).stdout.split('\0').filter(Boolean);
  const repo=tmp+'/repo',remote=tmp+'/remote.git';
  await exec('git',['init','--bare','--initial-branch=main',remote]);await exec('git',['init','--initial-branch=main',repo]);
  for(const file of files){try{await fs.mkdir(path.dirname(path.join(repo,file)),{recursive:true});await fs.copyFile(path.join(root,file),path.join(repo,file));}catch(error:any){if(error.code!=='ENOENT')throw error;}}
  await fs.symlink(root+'/node_modules',repo+'/node_modules');
  await git(repo,'add','-A','--',':!node_modules');await git(repo,'commit','-m','snapshot');await git(repo,'remote','add','origin',remote);await git(repo,'push','origin','main');
  const r=await exec('bash',[repo+'/.agents/scripts/release.sh','--dry-run'],{cwd:repo}).then(x=>({code:0,...x}),(e:any)=>({code:e.code as number,stdout:e.stdout as string,stderr:e.stderr as string}));
  assert.equal(r.code,0,r.stderr);assert.match(r.stdout,new RegExp(`^version: ${version}$`,'m'));assert.match(r.stdout,/^artifact: [a-f0-9]{64}$/m);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
