import {FEEDS} from '../src/sources.js';
import {parseFeed} from '../src/news.js';
import {findArticleImage} from '../src/images.js';

async function probe(feed){
 const start=Date.now();
 try{
  const r=await fetch(feed.url,{signal:AbortSignal.timeout(12000),redirect:'follow',headers:{'User-Agent':'GameScannerNewsBot/1.0',Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml'}});
  if(!r.ok){await r.body?.cancel();return {source:feed.name,url:feed.url,http:r.status};}
  const reader=r.body?.getReader();if(!reader)return {source:feed.name,error:'empty_body'};
  let size=0,xml='';const decoder=new TextDecoder();
  try{while(size<750000){const {done,value}=await reader.read();if(done)break;const bytes=value.subarray(0,750000-size);size+=bytes.byteLength;xml+=decoder.decode(bytes,{stream:true});}xml+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  const items=parseFeed(xml,feed,Date.now(),72);
  const photo=items.length?await findArticleImage(items[0]):null;
  return {source:feed.name,url:feed.url,http:r.status,xml:/<(rss|feed|rdf:RDF)\b/i.test(xml),fresh:items.length,photo:photo?.mime||null,ms:Date.now()-start};
 }catch(e){return {source:feed.name,url:feed.url,error:String(e?.message||e).slice(0,120)};}
}
for(let i=0;i<FEEDS.length;i+=4)for(const result of await Promise.all(FEEDS.slice(i,i+4).map(probe)))console.log('FEED_PROBE '+JSON.stringify(result));
for(const path of ['/health','/commissioning-status','/source-quality','/publication-status','/ai-usage']){
 try{
 const r=await fetch('https://game-scanner.bikobaur.workers.dev'+path,{signal:AbortSignal.timeout(10000)});
 if(!r.ok){console.log('LIVE_PROBE '+JSON.stringify({path,http:r.status}));continue;}
 const j=await r.json();
 const safe=path==='/health'?{publishing:j.publishing,readyToPublish:j.readyToPublish,translationPolicy:j.translationPolicy,captionPolicy:j.captionPolicy,publicationIntervalMinutes:j.publicationIntervalMinutes,maxPostsPerDay:j.maxPostsPerDay}:path==='/commissioning-status'?{status:j.status,primaryVerified:j.primaryVerified,backupVerified:j.backupVerified,imageMode:j.imageMode,messageId:j.messageId}:path==='/publication-status'?{available:j.available,lastCycle:j.lastCycle,lastPublication:j.lastPublication}:path==='/ai-usage'?{available:j.available,calls:j.calls,measured:j.measured,estimatedNeurons:j.estimatedNeurons,quotaExhausted:j.quotaExhausted}:Array.isArray(j)?j.map(v=>({source:v.source,feedChecks:v.feedChecks,feedOk:v.feedOk,photoFound:v.photoFound})):null;
 console.log('LIVE_PROBE '+JSON.stringify({path,http:r.status,data:safe}));
 }catch(e){console.log('LIVE_PROBE '+JSON.stringify({path,error:String(e?.message||e).slice(0,120)}));}
}
