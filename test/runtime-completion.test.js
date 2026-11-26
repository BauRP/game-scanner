import test from 'node:test';
import assert from 'node:assert/strict';
import {titleKey,isSimilarTitle,prepareTitleIndex} from '../src/storage.js';
import {composePost} from '../src/telegram.js';
import {SOURCES} from '../src/sources.js';
import {photoCandidates} from '../src/photo-selection.js';
const source=SOURCES[0];
const item={title:'New gameplay trailer revealed',description:'Fresh gameplay footage.',source:source.name,url:'https://'+source.hosts[0]+'/story',publishedAt:Date.now(),imageCandidates:[]};
test('title keys preserve decimal hardware and patch version numbers',()=>{
 assert.equal(titleKey('GPU 12.5 GB and update 1.2.3 revealed'),'gpu 12.5 gb and update 1.2.3 revealed');
 assert.equal(isSimilarTitle('GPU 12.5 GB and update 1.2.3 revealed',prepareTitleIndex(new Set([titleKey('GPU 12.5 GB and update 1.2.3 revealed')]))),true);
});
test('caption remains source-free while the original link is validated internally',()=>{
 const draft={headline:'Новый игровой трейлер',body:'Разработчики показали свежие кадры игрового процесса.'};
 assert.equal(composePost(draft,item),'🎮 Новый игровой трейлер\n\nРазработчики показали свежие кадры игрового процесса.');
 assert.throws(()=>composePost({...draft,body:draft.body+' Источник: https://example.com'},item),/Unexpected public source footer/);
});
test('photo candidate offers exactly one alternative only when budget remains',async()=>{
 let calls=0;const photoCandidatesGen=photoCandidates([item],{useImages:true,findImage:async(a,fetch,excluded)=>{calls++;return {url:excluded.length?'https://cdn.example/second.jpg':'https://cdn.example/first.jpg',bytes:new Uint8Array([1]),mime:'image/jpeg'};}});
 const first=await photoCandidatesGen.next();assert.equal(first.done,false);
 const alternative=await first.value.findAlternative();assert.equal(alternative.url,'https://cdn.example/second.jpg');
 assert.equal(await first.value.findAlternative(),null);assert.equal(calls,2);
});
