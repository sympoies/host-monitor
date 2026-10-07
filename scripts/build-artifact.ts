import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const output=process.argv[2];if(!output)throw Error('output directory required');
const files=['package.json','README.md','DEVELOPMENT.md','AGENTS.md','src/model.ts','src/schema.ts','src/sessions.ts','src/alerts.ts','src/android.ts','src/beszel.ts','src/agentless.ts','src/router.ts','src/collector.ts','src/jobs.ts','src/jobs-reader.ts','src/server.ts','public/index.html','public/app.js','public/order.js','public/tabs.js','public/style.css'];
// public/app.js is emitted from public/app.ts by tsc (a devDependency) into a scratch directory, never read from the checkout,
// so a stale local build cannot enter the artifact. Every other file is copied from the checkout.
const emitted=new Set(['public/app.js','public/order.js','public/tabs.js']);
const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));if(typeof version!=='string'||!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))throw Error('package.json version must be semantic');
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-emit-'));
try{
 const tsc=path.join(path.dirname(createRequire(path.join(root,'package.json')).resolve('typescript/package.json')),'bin/tsc');
 await promisify(execFile)(process.execPath,[tsc,'-p',path.join(root,'tsconfig.browser.json'),'--outDir',path.join(scratch,'public')],{cwd:root});
 const source=(file:string)=>path.join(emitted.has(file)?scratch:root,file);
 const inventory:{path:string;sha256:string}[]=[];for(const file of files){const data=await fs.readFile(source(file));inventory.push({path:file,sha256:createHash('sha256').update(data).digest('hex')});}
 const hash=createHash('sha256').update(JSON.stringify(inventory)).digest('hex');await fs.mkdir(output,{recursive:false});for(const {path:file} of inventory){const target=path.join(output,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(source(file),target);}await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({schemaVersion:1,version,artifact:hash,files:inventory},null,2)+'\n');console.log(JSON.stringify({artifact:hash,files:inventory.length}));
}finally{await fs.rm(scratch,{recursive:true,force:true});}
