// Fixed metadata reader: no entrypoint execution and no raw records leave this process.
import {validateJobConfig,readRecord,classifyJob} from './jobs.ts';
let input='';
for await(const chunk of process.stdin){input+=chunk.toString();if(Buffer.byteLength(input)>131072)throw Error('invalid-job-config');}
const {config,host,now}=JSON.parse(input);
validateJobConfig(config);
if(!config||typeof host!=='string'||host.length>96||!Number.isFinite(now))throw Error('invalid-job-config');
const items=await Promise.all(config.entries.map(async(job:typeof config.entries[number])=>{
 try{return classifyJob(await readRecord(config.statusDir,job.id),job,host,now);}
 catch{return {...classifyJob(null,job,host,now),reasonCode:'snapshot_unreadable'};}
}));
process.stdout.write(JSON.stringify({status:items.some(job=>job.status==='unknown')?'unknown':'ok',items}));
