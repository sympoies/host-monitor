import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {dictionaries,detectLanguage,loadLanguage,saveLanguage,translate} from '../public/i18n.ts';
const memory=(initial?:string)=>{let value=initial;return {getItem:()=>value??null,setItem:(_:string,v:string)=>{value=v;},removeItem:()=>{value=undefined;},peek:()=>value};};
const broken={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');},removeItem:()=>{throw Error('blocked');}};
const placeholders=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
test('both languages define exactly the same keys with the same placeholders and no empty text',()=>{
 const zh=Object.keys(dictionaries.zh).sort(),en=Object.keys(dictionaries.en).sort();
 assert.deepEqual(zh.filter(key=>!(key in dictionaries.en)),[],'keys missing from English');
 assert.deepEqual(en.filter(key=>!(key in dictionaries.zh)),[],'keys missing from Traditional Chinese');
 for(const key of zh){
  const a=(dictionaries.zh as Record<string,string>)[key],b=(dictionaries.en as Record<string,string>)[key];
  assert.ok(a.trim()&&b.trim(),`${key} is empty`);assert.deepEqual(placeholders(a),placeholders(b),`${key} placeholders differ`);
 }
});
test('every key the page names in HTML exists in the dictionary',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),keys=[...html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map(match=>match[1]);
 assert.ok(keys.length>20);for(const key of keys)assert.ok(key in dictionaries.en,key);
});
test('the browser language picks Traditional Chinese for any zh* tag and English otherwise',()=>{
 for(const tag of ['zh','zh-TW','zh-Hant-HK','zh-CN','ZH-tw'])assert.equal(detectLanguage([tag,'en-US']),'zh',tag);
 for(const tag of ['en','en-GB','ja','de-DE'])assert.equal(detectLanguage([tag,'zh-TW']),'en',tag);
 assert.equal(detectLanguage([]),'en');assert.equal(detectLanguage(undefined),'en');
});
test('a saved choice overrides the browser language and survives storage failures',()=>{
 const store=memory();assert.equal(loadLanguage(store,['zh-TW']),'zh');
 assert.equal(saveLanguage(store,'en'),true);assert.equal(loadLanguage(store,['zh-TW']),'en');
 assert.equal(loadLanguage(memory('klingon'),['zh-TW']),'zh','an unknown saved value is ignored');
 assert.equal(loadLanguage(broken,['en-US']),'en');assert.equal(saveLanguage(broken,'zh'),false);
});
test('translate fills placeholders and each language uses its own text',()=>{
 assert.notEqual(translate('zh','refresh'),translate('en','refresh'));
 assert.equal(translate('en','age.minutes',{n:5}),'5 min ago');assert.equal(translate('zh','age.minutes',{n:5}),'5 分鐘前');
});

test('language button text identifies the current language',()=>{
 assert.equal(dictionaries.zh['lang.current'],'中文');assert.equal(dictionaries.en['lang.current'],'English');
});
