// Standalone release asset: .mts keeps it an ES module wherever it is downloaded, with or without a package.json.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
interface Manifest{schemaVersion:number;artifact:string;files:{path:string;sha256:string}[]}
const [root,expected]=process.argv.slice(2);if(!root||!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('artifact directory and expected hash required');
const m=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')) as Manifest;if(m.schemaVersion!==1||m.artifact!==expected||createHash('sha256').update(JSON.stringify(m.files)).digest('hex')!==expected)throw Error('manifest identity mismatch');
const actual:string[]=[];
async function inventory(dir:string,relative=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=relative+entry.name;if(entry.isDirectory())await inventory(path.join(dir,entry.name),name+'/');else if(entry.isFile())actual.push(name);else throw Error('artifact contains a non-regular entry');}}
await inventory(root);
const listed=['manifest.json',...m.files.map(f=>f.path)].sort();
if(new Set(listed).size!==listed.length||JSON.stringify(actual.sort())!==JSON.stringify(listed))throw Error('artifact inventory mismatch');
for(const file of m.files){if(!/^(src|public)\/[a-zA-Z0-9._-]+$/.test(file.path)&&!['package.json','README.md','DEVELOPMENT.md','AGENTS.md'].includes(file.path))throw Error('unsafe artifact path');const s=await fs.lstat(path.join(root,file.path));if(!s.isFile())throw Error('artifact path is not a regular file');const data=await fs.readFile(path.join(root,file.path));if(createHash('sha256').update(data).digest('hex')!==file.sha256)throw Error('artifact file mismatch');}
console.log(JSON.stringify({artifact:expected,verified:true,files:m.files.length}));
