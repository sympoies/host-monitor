import {test} from 'node:test';import assert from 'node:assert/strict';import {projectSnapshot} from '../src/schema.ts';
test('snapshot intake retains the safe session inventory and rejects command details',()=>{
 const projected=projectSnapshot({schemaVersion:1,host:'collector-a',collectedAt:'2026-10-03T10:00:00Z',hardware:{cpuCount:4,load:[]},services:[],agentSessions:{status:'ok',sessions:[{agent:'codex',status:'running',phase:'working',title:'Build example',attach_command:'private-canary'}]}});
 assert.deepEqual(projected.agentSessions,{status:'ok',sessions:[{agent:'codex',status:'running',phase:'working',title:'Build example'}]});assert.equal(JSON.stringify(projected).includes('private-canary'),false);
});
