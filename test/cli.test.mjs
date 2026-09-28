import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn,execFile} from 'node:child_process';import {once} from 'node:events';import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..'),server=root+'/src/server.mjs';
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const {port}=s.address();await new Promise(r=>s.close(r));return port;}
function refused(host,port){return new Promise(resolve=>{const socket=net.connect({host,port});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',()=>resolve(true));});}
for(const args of [[],['--config']])test(`server CLI without a config file (${JSON.stringify(args)}) exits 64 with a usage line`,async()=>{
 await assert.rejects(exec(process.execPath,[server,...args],{timeout:10000}),error=>error.code===64&&/^usage: node src\/server\.mjs --config <server-config\.json>$/m.test(error.stderr)&&!error.stderr.includes('    at '));
});
test('server CLI binds loopback on the configured port, answers /healthz and exits 0 on SIGTERM',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'host-monitor-cli-'));let child;
 try{
  const port=await freePort();
  // A local host whose collector is missing stays offline; the server must still start and answer health checks.
  await fs.writeFile(tmp+'/server.json',JSON.stringify({port,refreshSeconds:60,hosts:[{name:'local',node:process.execPath,collector:tmp+'/missing-collector.mjs',config:tmp+'/missing-host.json'}]}));
  child=spawn(process.execPath,[server,'--config',tmp+'/server.json'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',d=>stdout+=d);child.stderr.setEncoding('utf8').on('data',d=>stderr+=d);
  const exited=once(child,'exit');
  await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error('server did not start: '+stderr)),10000);const poll=setInterval(()=>{if(stdout.includes('listening')){clearTimeout(deadline);clearInterval(poll);resolve();}},25);exited.then(()=>{clearTimeout(deadline);clearInterval(poll);reject(Error('server exited early: '+stderr));});});
  const r=await fetch(`http://127.0.0.1:${port}/healthz`);assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,service:'host-monitor'});
  assert.equal(await refused('::1',port),true,'server must not listen on the IPv6 wildcard or loopback');
  child.kill('SIGTERM');const [code,signal]=await exited;assert.equal(signal,null);assert.equal(code,0);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await fs.rm(tmp,{recursive:true,force:true});}
});
