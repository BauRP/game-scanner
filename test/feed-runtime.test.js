import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchNews,isFeedXml} from '../src/news.js';
import {FEEDS} from '../src/sources.js';
import {combineQuality} from '../src/source-quality.js';
const now=Date.parse('2026-11-26T04:00:00Z');
const xml=f=>'<rss><channel><item><title>New gameplay trailer announced</title><link>https://'+f.hosts[0]+'/story</link><pubDate>'+new Date(now).toUTCString()+'</pubDate><description><![CDATA[<html>Game trailer details</html>]]></description></item></channel></rss>';
test('feed root distinguishes RSS embedded HTML from actual HTML page',()=>{
 assert.equal(isFeedXml('<?xml version="1.0"?><!-- feed --><rss version="2.0"></rss>'),true);
 assert.equal(isFeedXml('<html><rss></rss></html>'),false);
});
test('oversized feed preserves complete first item without downloading tail',async()=>{
 const result=await fetchNews(async url=>{const f=FEEDS.find(x=>x.url===url);return new Response(xml(f)+' '.repeat(800000),{headers:{'content-length':'900000'}});},now);
 assert.equal(result.errors.length,0);
 assert.ok(result.articles.some(a=>a.source==='Nintendo Life'));
});
test('same-publisher two-hop redirects work within shared budget',async()=>{
 const f=FEEDS.find(x=>x.name==='Nintendo Life');
 const result=await fetchNews(async url=>{
 if(url===f.url)return new Response(null,{status:301,headers:{location:'/feed-step'}});
 if(url==='https://www.nintendolife.com/feed-step')return new Response(null,{status:302,headers:{location:'/feed-final'}});
 if(url==='https://www.nintendolife.com/feed-final')return new Response(xml(f));
 return new Response(xml(FEEDS.find(x=>x.url===url)));
 },now);
 assert.equal(result.errors.length,0);
});
test('feed failure is recorded and cleared after recovery',()=>{
 let v=combineQuality({},[{source:'Nintendo Life',ok:false,reason:'HTTP_403'}]);
 assert.equal(v['Nintendo Life'].lastFeedError,'HTTP_403');
 assert.equal(v['Nintendo Life'].consecutiveFailures,1);
 v=combineQuality(v,[{source:'Nintendo Life',ok:true,articles:1}]);
 assert.equal(v['Nintendo Life'].lastFeedError,null);
 assert.equal(v['Nintendo Life'].consecutiveFailures,0);
});
