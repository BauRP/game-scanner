import test from 'node:test';
import assert from 'node:assert/strict';
import {writePost,PRIMARY_MODEL,BACKUP_MODEL,parseDraft,EditorialSkip} from '../src/ai.js';
import {trustedImageUrl,extractImageFromHtml,findArticleImage} from '../src/images.js';
import {composePost,publishPost} from '../src/telegram.js';
import {coverPngBytes} from '../src/cover.js';
const item={source:'Gematsu',title:'New gameplay trailer released for Doom',description:'Doom receives a new gameplay trailer.',url:'https://www.gematsu.com/2026/11/doom-trailer',image:'https://www.gematsu.com/images/doom.jpg'};
import {parseFeed} from '../src/news.js';
const photo=()=>new Response(coverPngBytes(),{headers:{'content-type':'image/png'}});
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
test('Telegram caption keeps source attribution private and fits media limit',()=>{
 const s=composePost(JSON.parse(good.response),item);
 assert.equal(s,'🎮 Новый трейлер Doom\n\nДля Doom представили новый трейлер с игровым процессом.');
 assert.ok(!s.includes(item.url));assert.ok(!s.includes('Источник:'));assert.ok(!s.includes('Gematsu'));assert.ok(s.length<=1024);
});
test('publisher image is attached using sendPhoto',async()=>{
 const calls=[];const f=async(url,opt)=>{if(url===item.image)return photo();calls.push({url,opt});return Response.json({ok:true,result:{message_id:7}});};
 assert.equal(await publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},f),7);
 assert.equal(calls.length,1);assert.equal(calls[0].opt.body.get('photo').name,'news.png');assert.equal(calls[0].opt.body.get('caption'),'🎮 Новый трейлер Doom\n\nДля Doom представили новый трейлер с игровым процессом.');assert.equal(calls[0].opt.body.has('parse_mode'),false);
});
test('when publisher image is missing, branded photo is uploaded',async()=>{
 const calls=[];const f=async(url,opt)=>{calls.push({url,opt});return Response.json({ok:true,result:{message_id:8}});};
 assert.equal(await publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'false'},f),8);
 assert.equal(calls.length,1);assert.equal(calls[0].opt.body.get('photo').type,'image/png');assert.equal(calls[0].opt.body.get('caption'),'🎮 Новый трейлер Doom\n\nДля Doom представили новый трейлер с игровым процессом.');assert.equal(calls[0].opt.body.has('parse_mode'),false);
});
test('HTTP 400 photo rejection falls back only once',async()=>{
 let count=0;const f=async(url)=>url===item.image?photo():++count===1?Response.json({ok:false,description:'bad photo'},{status:400}):Response.json({ok:true,result:{message_id:9}});
 assert.equal(await publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},f),9);
 assert.equal(count,2);
});
test('ambiguous network error never retries',async()=>{
 let count=0;const f=async(url)=>{if(url===item.image)return photo();count++;throw Error('timeout');};
 await assert.rejects(publishPost(JSON.parse(good.response),item,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},f),/timeout/);
 assert.equal(count,1);
});

test('RSS article URL cannot be used as a Telegram photo',async()=>{
 const bad={...item,image:item.url};
 assert.equal(trustedImageUrl(bad.image,bad),null);
 assert.equal(trustedImageUrl(item.url+'?share=1',item),null);
 let photoAttempts=0;
 const fetchFn=async(url,opt)=>{
   if(url===bad.url)return new Response('<html><head><meta property="og:image" content="https://www.gematsu.com/images/doom.jpg"></head></html>',{headers:{'content-type':'text/html'}});
   if(url===item.image)return photo();
   photoAttempts++;return Response.json({ok:true,result:{message_id:21}});
 };
 const id=await publishPost(JSON.parse(good.response),bad,{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@gamescannews',USE_SOURCE_IMAGES:'true'},fetchFn);
 assert.equal(id,21);assert.equal(photoAttempts,1);
});
test('company names must be grounded in the source',()=>{
 const a={...item,title:'Bandai Card Games announces Digimon Alysion',description:'Bandai Card Games announced the mobile card game.'};
 assert.throws(()=>parseDraft({response:'{"headline":"Анонс Digimon Alysion","body":"Компания Bandai Namco сообщила о запуске."}'},a),EditorialSkip);
 assert.doesNotThrow(()=>parseDraft({response:'{"headline":"Анонс Digimon Alysion","body":"Компания Bandai Card Games сообщила о запуске."}'},a));
});

test('RSS description and encoded content contribute article image candidates',()=>{
 const xml='<rss><channel><item><title>New Doom gameplay trailer</title><link>'+item.url+'</link><pubDate>Wed, 25 Nov 2026 12:00:00 GMT</pubDate><description><![CDATA[<img src="https://www.gematsu.com/images/logo.png"><img data-src="'+item.image+'">]]></description><content:encoded>&lt;img src="https://www.gematsu.com/images/second.jpg"&gt;</content:encoded></item></channel></rss>';
 const [a]=parseFeed(xml,{name:'Gematsu',hosts:['www.gematsu.com']});
 assert.deepEqual(a.imageCandidates,[item.image,'https://www.gematsu.com/images/second.jpg']);
});
test('invalid feed photo falls through to JSON-LD on a large article',async()=>{
 const other='https://www.gematsu.com/images/other.png';
 const f=async(url)=>{
  if(url===item.image)return new Response('<html>not a photo</html>',{headers:{'content-type':'text/html'}});
  if(url===item.url)return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',image:[other]})+'</script>'+' '.repeat(1100000),{headers:{'content-type':'text/html','content-length':'1200000'}});
  if(url===other)return photo();
  throw Error('unexpected');
 };
 const result=await findArticleImage(item,f);
 assert.equal(result.url,other);assert.equal(result.mime,'image/png');
});
test('untrusted redirect is never fetched',async()=>{
 const calls=[];
 const f=async(url)=>{calls.push(url);return url===item.image?new Response(null,{status:302,headers:{location:'https://evil.example/photo.png'}}):new Response('',{status:404});};
 assert.equal(await findArticleImage(item,f),null);
 assert.deepEqual(calls,[item.image,item.url]);
});
