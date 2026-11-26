import test from 'node:test';
import assert from 'node:assert/strict';
import {cycleHistory,isSimilarTitle,titleKey} from '../src/storage.js';
import {verifyDraft,EditorialSkip,PRIMARY_MODEL} from '../src/ai.js';
import {assessArticle} from '../src/editorial.js';
import {extractInlineImages} from '../src/images.js';
import {measureUsage} from '../src/usage.js';
import {photoCandidates} from '../src/photo-selection.js';
const article=(title,description='')=>({title,description,source:'Gematsu',url:'https://www.gematsu.com/story',publishedAt:Date.now()});
test('history initializes empty table and independently reads existing publication',async()=>{
 let created=false;
 const db={prepare(sql){return {async run(){if(sql.includes('CREATE TABLE'))created=true;},async first(){if(sql.includes('cycle_history')){assert.ok(created);return null;}return {created_at:'2026-11-26T00:00:00Z',telegram_message_id:3};}};}};
 const r=await cycleHistory(db);assert.equal(r.available,true);assert.equal(r.lastCycle,null);assert.equal(r.lastPublication.messageId,3);
});
test('different event or negation is not a title duplicate',()=>{
 const old=titleKey('Doom major gameplay expansion release announced today');
 assert.equal(isSimilarTitle('Doom major gameplay expansion release not announced today',new Set([old])),false);
 assert.equal(isSimilarTitle('Doom major gameplay expansion release cancelled today',new Set([old])),false);
});
test('hardware values cannot borrow unrelated source numbers',()=>{
 const a=article('GPU performance test','60 fps and 12 GB memory.');
 assert.throws(()=>verifyDraft({headline:'Тест видеокарты',body:'Видеокарта показывает 12 кадров в секунду.'},a),EditorialSkip);
 assert.throws(()=>verifyDraft({headline:'Тест видеокарты',body:'Объём памяти составляет 60 ГБ.'},a),EditorialSkip);
 assert.doesNotThrow(()=>verifyDraft({headline:'Тест видеокарты',body:'Видеокарта показывает 60 кадров в секунду при 12 ГБ памяти.'},a));
});
test('regional claim requires source evidence',()=>{
 assert.throws(()=>verifyDraft({headline:'Новый релиз',body:'Игра доступна в Казахстане.'},article('New release','Available in Canada.')),EditorialSkip);
});
test('early access graduation and mandatory subscriptions remain distinct',()=>{
 assert.equal(assessArticle(article('Doom graduates from early access')).accessType,'full_release');
 assert.equal(assessArticle(article('Doom free to keep with Ubisoft+','Active subscription required.')).accessType,'subscription');
});
test('picture alternative is extracted without accepting AVIF source element',()=>{
 const a=article('Game screenshot');
 const html='<picture><source type="image/avif" srcset="/a.avif"><source type="image/jpeg" srcset="/a.jpg 800w"><img src="/fallback.webp"></picture>';
 const list=extractInlineImages(html,a);assert.ok(list.includes('https://www.gematsu.com/a.jpg'));assert.ok(!list.includes('https://www.gematsu.com/a.avif'));
});
test('usage selects complete nested counters instead of incomplete top-level data',()=>{
 const u=measureUsage(PRIMARY_MODEL,{usage:{},result:{usage:{input_tokens:100,output_tokens:20}}});
 assert.equal(u.input,100);assert.equal(u.output,20);
});
test('diversity preference does not suppress a qualified free giveaway',async()=>{
 const a=article('Doom free to keep today','Claim for free.');
 const b={...article('New gameplay trailer announced'),url:a.url+'2'};
 const result=[];for await(const x of photoCandidates([a,b],{useImages:false,recentCategories:['Бесплатные качественные игры','Бесплатные качественные игры']}))result.push(x.article.title);
 assert.equal(result[0],a.title);
});
