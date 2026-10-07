import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
// Execute the actual compiled dashboard with a small DOM fixture. Network and timers are inert.
class Element{
 children:Element[]=[];dataset:Record<string,string>={};className='';hidden=false;attributes:Record<string,string>={};
 textContent:string;constructor(text=''){this.textContent=text;}
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=nodes;this.textContent='';}
 setAttribute(name:string,value:string){this.attributes[name]=value;}addEventListener(){}
 get text():string{return this.textContent+this.children.map(node=>node.text).join(' ');}
}
test('checks panel renders scheduled status, revisions, retry and failure without HTML interpolation',()=>{
 const roots=new Map<string,Element>(),root=(id:string)=>{if(!roots.has(id))roots.set(id,new Element());return roots.get(id)!;};
 const document={getElementById:root,createElement:()=>new Element(),createTextNode:(text:string)=>new Element(text)};
 const context=vm.createContext({document,location:{hash:''},localStorage:{getItem:()=>null},loadTabState:()=>({selected:'agents',order:[]}),DEFAULT_TAB_ORDER:[],fetch:()=>new Promise(()=>{}),setInterval:()=>{},Map,Date});
 const source=fs.readFileSync(new URL('../public/app.ts',import.meta.url),'utf8');
 const compiled=stripTypeScriptTypes(source).replace(/^import .*$/gm,'');
 vm.runInContext(compiled,context,{filename:'dashboard.js'});
 const revision='a'.repeat(40),base={id:'<job-a>',label:'<label>',registryRevision:revision,sourceRevision:'b'.repeat(40),runtimeRevision:'sha256:'+'c'.repeat(64),lastSuccess:'2026-01-02T12:00:00Z',nextDue:'2026-01-02T12:01:00Z',ageSeconds:5,retryCount:1,retryBudget:2};
 const render=context.renderChecks as (snapshot:unknown)=>void;
 render({jobs:{items:[{...base,status:'unknown',reasonCode:'snapshot_missing',outcome:'unknown',lastFailure:{outcome:'timeout',reasonCode:'timeout',at:'2026-01-02T11:00:00Z'}},{...base,id:'job-b',status:'healthy',reasonCode:'success',outcome:'success'}]}});
 const rows=root('checks').children;assert.equal(rows.length,2);assert.equal(rows[0].textContent,'<job-a>');assert.equal(rows[0].children[0].className,'pill warning');assert.equal(rows[1].children[0].className,'pill ok');
 for(const value of ['<label>','snapshot_missing','retry 1/2','snapshot 5s','Registry '+revision.slice(0,12),'source '+ 'b'.repeat(12),'runtime '+'c'.repeat(12),'最近失敗 timeout'])assert.ok(rows[0].text.includes(value),value);
 assert.equal(root('checks-filters').children.length,3,'healthy and unknown rows expose both filter categories');
});
