import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const root=path.resolve(import.meta.dirname,'..');
// The repository is public, so examples must use placeholder names. A tailnet's generated MagicDNS suffix
// (tail<6 hex>.ts.net) or a home directory would identify a real network or machine.
const identifying=[/\btail[0-9a-f]{6}\.ts\.net\b/i,/\/home\/(?!user\b)[a-z][a-z0-9._-]*/,/\/Users\/(?!example\b)[A-Za-z][A-Za-z0-9._-]*/];
test('tracked files contain no real tailnet names or machine-local home paths',async()=>{
 const {stdout}=await promisify(execFile)('git',['ls-files','-z'],{cwd:root,maxBuffer:16*1024*1024});
 const hits:string[]=[];
 for(const file of stdout.split('\0').filter(Boolean)){if(file==='package-lock.json')continue;let text;try{text=await fs.readFile(path.join(root,file),'utf8');}catch{continue;}for(const pattern of identifying)if(pattern.test(text))hits.push(file+' '+pattern);}
 assert.deepEqual(hits,[]);
});
