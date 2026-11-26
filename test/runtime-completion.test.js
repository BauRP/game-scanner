import test from 'node:test';
import assert from 'node:assert/strict';
import {titleKey,isSimilarTitle,prepareTitleIndex} from '../src/storage.js';
import {composePost,sendCoverPhoto} from '../src/telegram.js';
import {SOURCES} from '../src/sources.js';
import {photoCandidates} from '../src/photo-selection.js';
const source=SOURCES.find(s=>s.name==='Gematsu')||SOURCES[0];
const item={title:'New adventure game launches today',description:'Adventure game with exploration.',source:source.name,url:'https://'+source.hosts[0]+'/story',publishedAt:Date.now(),imageCandidates:[]};
test('title keys preserve decimal hardware and patch version numbers',()=>{
 assert.equal(titleKey('GPU 12.5 GB and update 1.2.3 revealed'),'gpu 12.5 gb and update 1.2.3 revealed');
 assert.equal(isSimilarTitle('GPU 12.5 GB and update 1.2.3 revealed',prepareTitleIndex(new Set([titleKey('GPU 12.5 GB and update 1.2.3 revealed')]))),true);
});
test('every Telegram post shows a verified clickable publisher and original article link',()=>{
 const draft={headline:'Новый игровой трейлер',body:'Разработчики показали свежие кадры игрового процесса.'};
 const caption=composePost({...draft,headline:'Новый трейлер <PS5> & детали'}, {...item,url:item.url+'?story=1&ref=feed'});
 assert.match(caption,/🔗 Источник: <a href="https:\/\/www\.gematsu\.com\/story\?story=1&amp;ref=feed">Gematsu<\/a>/);
 assert.match(caption,/<b>Новый трейлер &lt;PS5&gt; &amp; детали<\/b>/);
 assert.throws(()=>composePost({...draft,body:draft.body+' Источник: https://example.com'},item),/Unexpected public source footer/);
 assert.throws(()=>composePost(draft,{...item,url:'https://example.com/fake'}),/verifiable source/);
});
