import test from 'node:test';
import assert from 'node:assert/strict';
import {assessArticle,CATEGORIES} from '../src/editorial.js';
import {parseDraft,EditorialSkip,PRIMARY_MODEL} from '../src/ai.js';
import {measureUsage} from '../src/usage.js';
import {isSimilarTitle,titleKey} from '../src/storage.js';
import {fileType} from '../src/images.js';
import worker from '../src/index.js';
const article=(title,description)=>({title,description,source:'Gematsu',url:'https://www.gematsu.com/news/story'});
test('subscription and add-on are not permanent giveaways',()=>{
 assert.equal(assessArticle(article('Doom free game with Game Pass','Subscription required')).accessType,'subscription');
 assert.equal(assessArticle(article('Doom DLC free on Steam','New expansion')).accessType,'addon');
 assert.equal(assessArticle(article('Doom free to keep','Giveaway has ended')).eligible,false);
});
test('early access is not full release',()=>{
 const a=article('Doom early access launches','Early access begins today.');
 assert.equal(assessArticle(a).accessType,'pre_release');
 assert.throws(()=>parseDraft({headline:'Doom',body:'Игра уже вышла.'},a,assessArticle(a)),EditorialSkip);
});
test('discount value cannot be borrowed from unrelated price',()=>{
 const a=article('Doom sale','50% off, now 20 dollars.');
 assert.throws(()=>parseDraft({headline:'Скидка 20%',body:'Игра доступна со скидкой.'},a),EditorialSkip);
});
test('similar title detection preserves different version numbers',()=>{
 const a=titleKey('Doom major gameplay expansion announced today');
 assert.equal(isSimilarTitle('Major Doom gameplay expansion announced today',new Set([a])),true);
 assert.equal(isSimilarTitle('Doom major gameplay expansion announced today 2',new Set([a])),false);
});
test('usage without token counters is unknown, not zero',()=>{
 assert.equal(measureUsage(PRIMARY_MODEL,{}),null);
 assert.ok(measureUsage(PRIMARY_MODEL,{usage:{prompt_tokens:1000,completion_tokens:500}}).neurons>0);
});
test('unauthenticated expensive service requests rejected',async()=>{
 for(const path of ['/ai-preview','/ai-preview-image','/test-message']){
 const r=await worker.fetch(new Request('https://example.com'+path,{method:'POST'}),{ADMIN_KEY:'secret'});
 assert.equal(r.status,401);
 }
});
test('static WebP header accepted and animation rejected',()=>{
 const b=new Uint8Array(30);const v=new DataView(b.buffer);
 b.set(new TextEncoder().encode('RIFF'),0);v.setUint32(4,22,true);b.set(new TextEncoder().encode('WEBPVP8X'),8);v.setUint32(16,10,true);b[24]=199;b[27]=99;
 assert.equal(fileType(b),'image/webp');b[20]=2;assert.equal(fileType(b),null);
});
