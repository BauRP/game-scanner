import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES,FEEDS} from '../src/sources.js';
import {fetchNews,rankNews,enrichArticle} from '../src/news.js';
import {trustedImageUrl} from '../src/images.js';
import {photoCandidates} from '../src/photo-selection.js';
import {combineQuality,qualityBonus} from '../src/source-quality.js';
import {writePost,parseDraft,EditorialSkip,PRIMARY_MODEL,BACKUP_MODEL} from '../src/ai.js';
import {publishPost} from '../src/telegram.js';
import {coverPngBytes} from '../src/cover.js';
const now=Date.parse('2026-11-26T00:00:00Z');
const article={source:'Gematsu',title:'Digimon Alysion now available',description:'A new mobile card game is now available.',url:'https://www.gematsu.com/digimon',publishedAt:now};
const second={...article,url:article.url+'-2',title:'New Doom gameplay trailer',publishedAt:now-6*3600000};
const img={mime:'image/png',bytes:coverPngBytes(),url:'https://www.gematsu.com/photo.png',method:'rss'};
const full={publish:true,headline:'Digimon Alysion вышла',body:'Мобильная игра уже доступна. Игроки собирают собственные колоды карт. В основе игрового процесса лежат карточные сражения.'};
test('15 unique publishers and 16 feeds, all with media domains',()=>{
 assert.equal(SOURCES.length,15);assert.equal(FEEDS.length,16);
 assert.equal(new Set(SOURCES.map(s=>s.name)).size,15);
 assert.equal(new Set(FEEDS.map(s=>s.url)).size,16);
 for(const s of SOURCES){assert.ok(s.media.length);assert.ok(trustedImageUrl('https://'+s.media[0]+'/photo.png',{source:s.name,url:'https://'+s.hosts[0]+'/news/story'}));}
});
test('every feed is read, errors isolated, HTML responses rejected',async()=>{
 const calls=[];
 const result=await fetchNews(async url=>{
  calls.push(url);const f=FEEDS.find(x=>x.url===url);
  if(f.name==='IGN')return new Response('<html>captcha</html>');
  if(f.name==='Dexerto')throw Error('offline');
  return new Response('<rss><channel><item><title>New game trailer today</title><link>https://'+f.hosts[0]+'/story</link><pubDate>'+new Date(now).toUTCString()+'</pubDate><description>New trailer.</description><media:content url="https://'+f.media[0]+'/picture.jpg" type="image/jpeg"/></item></channel></rss>');
 },now);
 assert.equal(calls.length,16);assert.equal(result.errors.length,2);
 assert.equal(result.articles.length,13);assert.equal(result.feedStats.filter(x=>x.ok).length,14);
 assert.ok(result.articles.every(x=>x.imageCandidates.length===1));
});
test('Steam and PlayStation preferred at equal freshness',()=>{
 const a={...article,source:'Steam'},b={...article,source:'PlayStation Blog'};
 assert.deepEqual(rankNews([article,b,a]).map(x=>x.source),['Steam','PlayStation Blog','Gematsu']);
});
test('original photo in later story preferred over first cover',async()=>{
 const seen=[],checks=[];
 for await(const x of photoCandidates([article,second],{checks,findImage:async a=>{seen.push(a.url);return a.url===second.url?img:null;}})){
  assert.equal(x.article.url,second.url);assert.equal(x.image,img);break;
 }
 assert.deepEqual(seen,[article.url,second.url]);assert.equal(checks.filter(x=>x.found).length,1);
});
test('cover fallback only after image search, never for already published news',async()=>{
 const list=[];
 for await(const x of photoCandidates([article,second],{wasAttempted:async u=>u===article.url,findImage:async()=>null}))list.push(x);
 assert.equal(list.length,1);assert.equal(list[0].article.url,second.url);assert.equal(list[0].image,null);
});
test('photo request budget is bounded and incomplete probes not penalized',async()=>{
 const checks=[];let requests=0;
 for await(const x of photoCandidates([article,second],{maxRequests:1,checks,fetchFn:async()=>{requests++;return new Response('');},findImage:async(a,f)=>{await f(a.url);await f(a.url);return null;}}))assert.equal(x.image,null);
 assert.equal(requests,1);assert.equal(checks[0].found,undefined);
});
test('source quality counts actual checks and rewards useful images',()=>{
 const feeds=[{source:'Steam',ok:true,articles:10,withImage:8}];
 const data=combineQuality({},feeds,Array.from({length:5},()=>({source:'Steam',found:true,accepted:true})));
 assert.equal(data.Steam.photoFound,5);assert.equal(data.Steam.uploadOk,5);assert.equal(data.Steam.withImage,8);assert.ok(qualityBonus(data.Steam)>0);
 assert.ok(qualityBonus({photoChecks:5,photoFound:0})<0);
 assert.equal(qualityBonus({photoChecks:1,photoFound:1}),0);
});
test('article context is supplied to either AI without invented facts',async()=>{
 const a={...article,feedContext:article.description};
 const page='<article><p>Players build their own decks of cards.</p><p>Card battles are the core of the gameplay.</p></article>';
 const f=async()=>new Response(page,{headers:{'content-type':'text/html'}});
 const enriched=await enrichArticle(a,{},f);
 assert.match(enriched.articleContext,/build their own decks/);
 const seen=[];
 const draft=await writePost(a,{AI:{run:async(model,opts)=>{seen.push(model);assert.match(opts.messages[1].content,/Card battles/);if(model===PRIMARY_MODEL)throw Error('capacity');return full;}}},f);
 assert.equal(draft.engine,BACKUP_MODEL);assert.deepEqual(seen,[PRIMARY_MODEL,BACKUP_MODEL]);
});
test('release requires three complete sentences and rejects unsupported numbers',()=>{
 const a={...article,gameDetailsRequired:true};
 assert.throws(()=>parseDraft({...full,body:'Мобильная игра уже доступна.'},a),EditorialSkip);
 assert.throws(()=>parseDraft({...full,body:full.body.replace('карточные','500 карточных')},a),EditorialSkip);
 assert.equal(parseDraft(full,a).body,full.body);
});
test('editorial rejection from both AI models is distinct from outage',async()=>{
 await assert.rejects(writePost(article,{AI:{run:async()=>({publish:false})}}),EditorialSkip);
});
test('prevalidated original image is reused and Telegram acceptance recorded',async()=>{
 const check={source:article.source,found:true};
 const result=await publishPost(full,article,{USE_SOURCE_IMAGES:'true',TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@fake'},async(url,opts)=>{
  assert.match(url,/api.telegram.org/);assert.equal(opts.body.get('photo').name,'news.png');
  return Response.json({ok:true,result:{message_id:1}});
 },{image:img,check});
 assert.equal(result,1);assert.equal(check.accepted,true);
});
