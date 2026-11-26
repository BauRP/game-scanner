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
test('Telegram caption never exposes the Steam publisher name or original URL',()=>{
 const draft={headline:'Новый игровой трейлер',body:'Разработчики показали свежие кадры игрового процесса.'};
 const url='https://store.steampowered.com/news/example';
 const caption=composePost(draft,{...item,source:'Steam',url});
 assert.equal(caption,'🎮 Новый игровой трейлер\n\nРазработчики показали свежие кадры игрового процесса.');
 assert.ok(!caption.includes('Steam'));
 assert.ok(!caption.includes(url));
 assert.ok(!caption.includes('Источник:'));
});
