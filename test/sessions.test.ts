import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {parseSessionList,collectSessions,projectSessions,labelRules} from '../src/sessions.ts';
import {projectSnapshot} from '../src/schema.ts';import {collect} from '../src/collector.ts';
const fixture=await fs.readFile(new URL('./fixtures/sessions/list.json',import.meta.url),'utf8');
test('local list parsing keeps running sessions and only safe fields, with conservative activity',()=>{
 const result=parseSessionList(fixture);assert.equal(result.status,'ok');assert.equal(result.sessions.length,4);
 const work=result.sessions.find(s=>s.phase==='working')!;assert.equal(work.account,'account-a');assert.equal(work.lineageDepth,1);assert.equal(work.unreadMessageCount,0);
 assert.equal(result.sessions.find(s=>s.title==='Legacy activity')!.phase,'unknown');
 assert.equal(result.sessions.find(s=>s.agent==='claude')!.account,'account-b');
 const text=JSON.stringify(result);for(const value of ['private-canary','/workspace/','cwd','attach_command','last_prompt','tmux_session'])assert.equal(text.includes(value),false,value);
});
test('missing or failed CLI, malformed records, invalid envelopes and oversized output stay unknown; verified empty stays empty',async()=>{
 for(const text of ['{}','[]','bad',JSON.stringify({ok:false,data:[]}),JSON.stringify({ok:true,data:[{status:'running'}]}),' '.repeat(2*1024*1024+1)])assert.throws(()=>parseSessionList(text));
 for(const error of [Object.assign(Error('private-canary'),{code:'ENOENT'}),Error('timeout')])assert.deepEqual(await collectSessions({},async()=>{throw error;}),{status:'unknown',sessions:[]});
 assert.deepEqual(parseSessionList(JSON.stringify({schema_version:'cli.agent-session.list.v1',ok:true,data:[]})),{status:'ok',sessions:[]});
 assert.deepEqual(await collectSessions(false,async()=>{throw Error('must not run');}),{status:'disabled',sessions:[]});
 const calls:unknown[]=[];await collectSessions({bin:'/opt/tools/agent-session'},async(bin,args,options)=>{calls.push([bin,args,options]);return fixture;});
 assert.deepEqual(calls,[['/opt/tools/agent-session',['list','--format','json'],{timeout:5000,maxBuffer:2*1024*1024}]]);
});
test('ordered rules use all conditions and cwd path boundaries; selectors never enter snapshots',()=>{
 const rules=labelRules([{label:'Project lead',match:{role:'coordinator',cwdPrefix:'/workspace/example-project'}},{label:'Coordinator',match:{role:'coordinator'}},{label:'Reviewer',match:{titlePrefix:'Review',repoName:'example-project'}}]);
 const result=parseSessionList(fixture,rules);assert.equal(result.sessions.find(s=>s.phase==='working')!.label,'Project lead');assert.equal(result.sessions.find(s=>s.phase==='waiting')!.label,'Reviewer');
 const rows=JSON.parse(fixture);rows.data[1].cwd='/workspace/example-project-other';assert.equal(parseSessionList(JSON.stringify(rows),rules).sessions[1].label,'Coordinator');
 for(const bad of [[{label:'x',match:{}}],[{label:'x',match:{bogus:'x'}}],[{label:'x',match:{role:''}}],[{label:'x',match:{titlePrefix:42}}]])assert.throws(()=>labelRules(bad),/invalid-session-label-rules/);
});
test('server projection strips nested unsafe session fields and cannot turn malformed collection into verified empty',()=>{
 const raw=parseSessionList(fixture);const input={...raw,sessions:raw.sessions.map(s=>({...s,cwd:'private-canary',prompt_file:'private-canary',turn_state:{last_prompt:'private-canary'}}))};
 const base={schemaVersion:1,host:'collector-a',collectedAt:'2026-10-03T10:00:00Z',hardware:{cpuCount:4,load:[]},services:[],agentSessions:input};
 const projected=projectSnapshot(base);assert.deepEqual(projected.agentSessions,raw);assert.equal(JSON.stringify(projected).includes('private-canary'),false);
 assert.deepEqual(projectSessions({status:'ok',sessions:[{}]}),{status:'unknown',sessions:[]});
 assert.deepEqual(projectSessions({status:'unknown',sessions:raw.sessions}),{status:'unknown',sessions:[]});
});
test('portable collector collects configured sessions alongside host data without alerting on session CLI failure',async()=>{
 const run=async(bin:string)=>{if(bin==='/opt/tools/agent-session')return fixture;return '';};
 const snapshot=await collect({name:'collector-a',agentSessions:{bin:'/opt/tools/agent-session'}},{platform:'darwin',hostname:'collector-a',run});
 assert.equal(snapshot.agentSessions?.sessions.length,4);
 const unknown=await collect({name:'collector-a'},{platform:'darwin',hostname:'collector-a',run:async()=>{throw Error('missing');}});
 assert.equal(unknown.agentSessions?.status,'unknown');assert.ok(!unknown.collectionIssues.some(s=>s.includes('session')));
});

test('root and dispatched rules use explicit lineage, exact cwd and host-relative patterns',()=>{
 const rules=labelRules([{label:'Lead',match:{cwd:'~/projects/example',root:true}},{label:'Tester',match:{cwdPrefix:'~/projects/example/roles/tester'}},{label:'Worker',match:{root:false}}],'/home/user');
 const rows=JSON.parse(fixture);rows.data[0].cwd='/home/user/projects/example';rows.data[0].lineage={depth:0,parent:null};
 rows.data[1].cwd='/home/user/projects/example/roles/tester';rows.data[1].lineage={depth:1,parent:{session_id:'parent'}};
 rows.data[2].cwd='/home/user/projects/example';rows.data[2].lineage={depth:1,parent:{session_id:'parent'}};
 const result=parseSessionList(JSON.stringify(rows),rules);assert.deepEqual(result.sessions.map(s=>s.label),['Lead','Tester','Worker',undefined]);
 delete rows.data[0].lineage;assert.equal(parseSessionList(JSON.stringify(rows),rules).sessions[0].label,undefined);
 assert.throws(()=>labelRules([{label:'Lead',match:{root:'true'}}]),/invalid-session-label-rules/);
});
