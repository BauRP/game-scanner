import {extractInlineImages,trustedImageUrl} from './images.js';
import { SOURCES, FEEDS, sourceByName } from './sources.js';

const MAX_FEED_BYTES = 750000;
const MAX_ITEMS_PER_FEED = 20;
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};

export function decodeEntities(text='') {
  return String(text).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(match,code)=>{
    if(code[0]==='#') {
      const number = code[1]?.toLowerCase()==='x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
      return Number.isInteger(number) && number>0 && number<=0x10ffff && (number<0xd800 || number>0xdfff) ? String.fromCodePoint(number) : '';
    }
    return ENTITIES[code.toLowerCase()]||match;
  });
}
export function cleanText(value,limit=350) {
  return decodeEntities(String(value??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<[^>]*>/g,' ')
    .replace(/[\s\u00a0]+/g,' ').trim()).slice(0,limit);
}
function tag(xml,name) {
  const re=new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i');
  return xml.match(re)?.[1]??'';
}
function attr(xml,name) {
  return xml.match(new RegExp('\\b'+name+'\\s*=\\s*["\\x27]([^"\\x27]+)["\\x27]','i'))?.[1]||'';
}
export function normalizedUrl(value,allowedHosts) {
  try {
    const u=new URL(decodeEntities(value.trim()));
    if(u.protocol!=='https:'||u.username||u.password||u.port||!allowedHosts.includes(u.hostname.toLowerCase()))return '';
    for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|ref$)/i.test(k))u.searchParams.delete(k);
    u.hash='';
    return u.href;
  }catch{return '';}
}
function feedLink(xml) {
  const rss=tag(xml,'link');
  if(rss)return cleanText(rss,2048);
  const links=[...xml.matchAll(/<link\b[^>]*>/gi)].map(m=>({href:attr(m[0],'href'),rel:attr(m[0],'rel')}));
  return links.find(l=>l.href&&(!l.rel||l.rel==='alternate'))?.href||'';
}
function mediaUrls(xml) {
  const urls=[];
  for(const hit of xml.matchAll(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi)){
    const tag=hit[0],type=attr(tag,'type'),medium=attr(tag,'medium');
    if(type&&!/^image\//i.test(type))continue;
    if(medium&&medium.toLowerCase()!=='image')continue;
    const url=attr(tag,'url');
    // Untyped RSS enclosures are sometimes links to HTML articles, not images.
    // For an untyped enclosure accept only filenames resembling actual image files.
    if(/^<enclosure\b/i.test(tag)&&!type&&!/\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(url))continue;
    if(url)urls.push(decodeEntities(url));
  }
  return urls;
}
export function parseFeed(xml,source,now=null,maxAgeHours=72) {
  const blocks=[];for(const hit of String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)){blocks.push(hit);if(blocks.length>=MAX_ITEMS_PER_FEED)break;}
  return blocks.map(([, ,block])=>{
    const title=cleanText(tag(block,'title'),160);
    const url=normalizedUrl(feedLink(block),source.hosts);
    const rawDate=cleanText(tag(block,'pubDate')||tag(block,'published')||tag(block,'updated'),80);
    const publishedAt=Date.parse(rawDate);
    if(!url||title.length<=8||!Number.isFinite(publishedAt)||(now!==null&&!eligible({title,publishedAt},now,maxAgeHours)))return null;
    const rawFields=['description','summary','content:encoded','content'].map(field=>tag(block,field));
    const description=cleanText(rawFields[0]||rawFields[1]||rawFields[2],540);
    const feedContext=cleanText(rawFields[2]||rawFields[3]||rawFields[0]||rawFields[1],3200);
    const article={title,url,description,feedContext,publishedAt,source:source.name};
    const candidates=mediaUrls(block).map(u=>trustedImageUrl(u,article)).filter(Boolean);
    for(const field of new Set(rawFields.filter(Boolean))){
      if(candidates.length>=12)break;
      const raw=field.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1');
      for(const u of extractInlineImages(raw.includes('<img')?raw:decodeEntities(raw),article))candidates.push(u);
    }
    const imageCandidates=[...new Set(candidates)].slice(0,12);
    return {...article,image:imageCandidates[0]||'',imageCandidates};
  }).filter(Boolean);
}
export function eligible(item,now,maxAgeHours=72) {
  const age=now-item.publishedAt;
  return age>=-900000&&age<=maxAgeHours*3600000&&!/^(review|opinion|best deals|sponsored):/i.test(item.title);
}
export function rankNews(items,qualityBonus=()=>0,quality={}) {
  const score=(a)=>{
    const all=(a.title+' '+a.description).toLowerCase();
    let n=a.publishedAt/3600000+qualityBonus(quality[a.source])+(sourceByName(a.source)?.priority||0)+(a.imageCandidates?.length||a.image?6:0);
    if(/free (game|games)|free to keep|free-to-play|бесплатн|giveaway|available free/i.test(all))n+=24;
    if(/steam|epic games|pc release|gameplay|trailer|release date|update|announc|launch|playstation/i.test(all))n+=5;
    if(/sale|deal|discount|hardware|gift card|coupon/i.test(all))n-=8;
    return n;
  };
  return items.map(a=>({a,score:score(a)})).sort((a,b)=>b.score-a.score).map(x=>x.a);
}
export async function fetchNews(fetchFn=fetch,now=Date.now(),maxAgeHours=72) {
  const results=[];
  let redirects=0;
  for(let i=0;i<FEEDS.length;i+=4)results.push(...await Promise.allSettled(FEEDS.slice(i,i+4).map(async source=>{
    let url=source.url;
    const options={redirect:'manual',
      headers:{'Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml','User-Agent':'GameScannerNewsBot/1.0'},
      signal:AbortSignal.timeout(9000)
    };
    let res=await fetchFn(url,options);
    if([301,302,303,307,308].includes(res.status)){
      const loc=res.headers.get('location');await res.body?.cancel().catch(()=>{});
      const next=loc?normalizedUrl(new URL(loc,url).href,[...source.hosts,new URL(source.url).hostname]):'';
      if(!next||redirects>=6)throw Error('feed redirect unavailable');
      redirects++;res=await fetchFn(next,options);
    }
    if(!res.ok){await res.body?.cancel().catch(()=>{});throw new Error(source.name+' HTTP '+res.status);}
    const len=Number(res.headers.get('content-length')||0);
    if(len>MAX_FEED_BYTES){await res.body?.cancel().catch(()=>{});throw new Error(source.name+' feed too large');}
    const xml=await articleHtml(res,MAX_FEED_BYTES);
    if(!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)||/<html\b/i.test(xml.slice(0,1000)))throw Error('invalid RSS or Atom response');
    return parseFeed(xml,source,now,maxAgeHours);
  })));
  const items=[],errors=[];
  for(let i=0;i<results.length;i++){
    if(results[i].status==='fulfilled')items.push(...results[i].value);
    else errors.push(FEEDS[i].name+': '+String(results[i].reason?.message||'unavailable').slice(0,120));
  }
  const unique=new Map();
  for(const item of rankNews(items))if(!unique.has(item.url))unique.set(item.url,item);
  return {articles:[...unique.values()],errors,feedStats:FEEDS.map((f,i)=>({source:f.name,ok:results[i].status==='fulfilled',articles:results[i].value?.length||0,withImage:results[i].value?.filter(a=>a.imageCandidates.length).length||0}))};
}

export function needsGameContext(article,editorial={}){
  return /^(Новые игры и релизы|Анонсы и трейлеры)$/.test(editorial.category||'')||
    /\b(now available|out now|launch(?:es|ed)?|release(?:d| date)?|announc(?:es|ed|ement)|unveil(?:s|ed)?|reveal(?:s|ed)?|debut|gameplay trailer|new trailer)\b/i.test(article.title||'');
}
export function extractArticleContext(html){
  const text=String(html).replace(/<(script|style|nav|aside|footer|form|noscript|iframe|header)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  const main=text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]||
    text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if(!main)return '';
  const parts=[];
  for(const [,p] of main.matchAll(/<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)){
    const value=cleanText(p,700);
    if(value.length<35||/^(?:read more|related|subscribe|advertisement|follow us|sign up|share this|cookie|privacy policy|comments\b|recommended|you may also like|related articles|affiliate disclosure)/i.test(value))continue;
    if(!parts.includes(value))parts.push(value);
    if(parts.join(' ').length>=3200)break;
  }
  return parts.join(' ').slice(0,3200);
}
async function articleHtml(response,limit=1000000){
  const reader=response.body?.getReader();
  if(!reader)return '';
  const decoder=new TextDecoder();let size=0,html='';
  try{
    while(size<limit){
      const {done,value}=await reader.read();if(done)break;
      const chunk=value.subarray(0,limit-size);size+=chunk.byteLength;
      html+=decoder.decode(chunk,{stream:true});
    }
    return html+decoder.decode();
  }finally{await reader.cancel().catch(()=>{});}
}
export async function enrichArticle(article,editorial={},fetchFn=fetch){
  if(!needsGameContext(article,editorial))return article;
  const source=SOURCES.find(s=>s.name===article.source);
  const feed=String(article.feedContext||'').slice(0,3200);
  let page='';
  if(source){
    let url=normalizedUrl(String(article.url||''),source.hosts);
    try{
      const deadline=Date.now()+8000;
      for(let i=0;i<3&&url&&Date.now()<deadline;i++){
        if(new URL(url).port)break;
        const response=await fetchFn(url,{redirect:'manual',headers:{Accept:'text/html,application/xhtml+xml','User-Agent':'GameScannerNewsBot/1.0'},signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
        if([301,302,303,307,308].includes(response.status)){
          const loc=response.headers.get('location');await response.body?.cancel().catch(()=>{});
          url=loc?normalizedUrl(new URL(loc,url).href,source.hosts):'';continue;
        }
        if(response.ok&&/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type')||''))page=extractArticleContext(await articleHtml(response));
        else await response.body?.cancel().catch(()=>{});
        break;
      }
    }catch{/* Preserve verified feed information if the article is temporarily inaccessible. */}
  }
  const context=[article.description,feed,page].filter(Boolean).filter((v,i,a)=>!a.some((other,j)=>j!==i&&other.includes(v)&&(other.length>v.length||j<i))).join('\n').slice(0,6500);
  return {...article,gameDetailsRequired:true,articleContext:context,contextSource:page?'publisher_article':feed?'rss':'summary'};
}
