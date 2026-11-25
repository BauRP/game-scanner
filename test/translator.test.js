import test from 'node:test';
import assert from 'node:assert/strict';
import {russianDraftProblem} from '../src/translator.js';
import {writePost,PRIMARY_MODEL,BACKUP_MODEL,EditorialSkip} from '../src/ai.js';
import {publishPost} from '../src/telegram.js';
import {assessArticle} from '../src/editorial.js';
const article={source:'Steam',url:'https://store.steampowered.com/news/app/216150/view/123',title:'MapleStory Merch Now Available for Pre-Order',description:'MapleStory merch can be pre-ordered until December 9 2026 at 9:00 PM UTC. Orders are limited to three items per email address and shipping is available only within the United States and Canada. Expected shipment is March 2027.'};
const english={publish:true,headline:article.title,body:article.description};
const russian={publish:true,headline:'Открыт предзаказ товаров MapleStory',body:'Товары MapleStory можно заказать до 9 декабря 2026 года. Доставка доступна только в США и Канаде.'};
test('screenshot English post rejected, Russian equivalent accepted',()=>{
 assert.ok(russianDraftProblem(english));assert.equal(russianDraftProblem(russian),null);
});
test('Russian body cannot hide English headline',()=>{
 assert.equal(russianDraftProblem({...russian,headline:english.headline}),'headline_not_russian');
});
test('English sentence embedded in Russian text rejected',()=>{
 assert.ok(russianDraftProblem({...russian,body:russian.body+' Players will be able to explore the new world.'}));
});
test('official Latin game names and platform names remain allowed',()=>{
 assert.equal(russianDraftProblem({headline:'Новый трейлер DOOM: The Dark Ages',body:'Разработчики представили игровой процесс на PC, PS5 и Xbox Series X.'}),null);
});
test('English output triggers reserve model translation',async()=>{
 const calls=[];
 const result=await writePost(article,{AI:{run:async(m,o)=>{calls.push(m);if(m===PRIMARY_MODEL)return english;assert.match(o.messages[0].content,/Предыдущий редактор/);return russian;}}});
 assert.equal(result.engine,BACKUP_MODEL);assert.deepEqual(calls,[PRIMARY_MODEL,BACKUP_MODEL]);
});
test('both models English means editorial rejection',async()=>{
 await assert.rejects(writePost(article,{AI:{run:async()=>english}}),EditorialSkip);
});
test('final Telegram gate blocks English before any network request',async()=>{
 let calls=0;
 await assert.rejects(publishPost(english,article,{},async()=>{calls++;}),/headline_not_russian/);
 assert.equal(calls,0);
});
test('merchandise offer is not a game release',()=>{
 assert.equal(assessArticle(article).reason,'merchandise_promotion');
});
