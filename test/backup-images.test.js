import test from 'node:test';
import assert from 'node:assert/strict';
import {writePost,PRIMARY_MODEL,BACKUP_MODEL,parseDraft,EditorialSkip} from '../src/ai.js';
import {trustedImageUrl,extractImageFromHtml} from '../src/images.js';
import {composePost,publishPost} from '../src/telegram.js';
import {coverPngBytes} from '../src/cover.js';
const item={source:'Gematsu',title:'New gameplay trailer released for Doom',description:'Doom receives a new gameplay trailer.',url:'https://www.gematsu.com/2026/11/doom-trailer',image:'https://www.gematsu.com/images/doom.jpg'};
const good={response:'{"publish":true,"headline":"Новый трейлер Doom","body":"Для Doom представили новый трейлер с игровым процессом."}'};
test('GPT-OSS 20B is primary',async()=>{
 const models=[];const r=await writePost(item,{AI:{run:async m=>{models.push(m);return good;}}});
 assert.equal(r.engine,PRIMARY_MODEL);assert.deepEqual(models,[PRIMARY_MODEL]);
});
test('Gemma 4 is backup for failed GPT-OSS',async()=>{
 const models=[];const r=await writePost(item,{AI:{run:async m=>{models.push(m);if(m===PRIMARY_MODEL)throw Error('capacity');return good;}}});
 assert.equal(r.engine,BACKUP_MODEL);assert.deepEqual(models,[PRIMARY_MODEL,BACKUP_MODEL]);
});
test('Gemma handles GPT hallucination of a number',async()=>{
 const r=await writePost(item,{AI:{run:async m=>m===PRIMARY_MODEL?{response:'{"headline":"Doom 2088","body":"Новый трейлер"}'}:good}});
 assert.equal(r.engine,BACKUP_MODEL);
});
test('both model failures cause no draft',async()=>{
 await assert.rejects(writePost(item,{AI:{run:async()=>{throw Error('fail')}}}),/NO_VERIFIED_AI_DRAFT/);
});
test('invented dates and unmarked rumors are blocked',()=>{
 assert.throws(()=>parseDraft({response:'{"headline":"Doom 2088","body":"Новый трейлер"}'},item),EditorialSkip);
 assert.throws(()=>parseDraft(good,item,{rumor:true}),EditorialSkip);
});
test('publisher media URL must be trusted',()=>{
 assert.equal(trustedImageUrl(item.image,item),item.image);
 assert.equal(trustedImageUrl('https://127.0.0.1/secret.png',item),null);
 assert.equal(trustedImageUrl('https://evil.example/a.jpg',item),null);
 assert.equal(extractImageFromHtml('<meta content="'+item.image+'" property="og:image">',item),item.image);
});
test('original Game Scanner cover is PNG',()=>{
 assert.deepEqual([...coverPngBytes().slice(0,8)],[137,80,78,71,13,10,26,10]);
});
test('Telegram caption includes source link and fits media limit',()=>{
 const s=composePost(JSON.parse(good.response),item);
 assert.ok(s.endsWith(item.url));assert.ok(s.length<=1024);
});
test('publisher image is attached using sendPhoto',async()=>{
 const calls=[];const f=async(url,opt)=>{calls.push({url,opt});return Response.json({ok:true,result:{message_id:7}});};
 assert.equal(await publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},f),7);
 assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].opt.body).photo,item.image);
});
test('when publisher image is missing, branded photo is uploaded',async()=>{
 const calls=[];const f=async(url,opt)=>{calls.push({url,opt});return Response.json({ok:true,result:{message_id:8}});};
 assert.equal(await publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'false'},f),8);
 assert.equal(calls.length,1);assert.equal(calls[0].opt.body.get('photo').type,'image/png');
});
test('HTTP 400 photo rejection falls back only once',async()=>{
 let count=0;const f=async()=>++count===1?Response.json({ok:false,description:'bad photo'},{status:400}):Response.json({ok:true,result:{message_id:9}});
 assert.equal(await publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},f),9);
 assert.equal(count,2);
});
test('ambiguous network error never retries',async()=>{
 let count=0;const f=async()=>{count++;throw Error('timeout');};
 await assert.rejects(publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},f),/timeout/);
 assert.equal(count,1);
});
