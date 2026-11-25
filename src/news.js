import { SOURCES } from './sources.js';

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
    if(u.protocol!=='https:'||u.username||u.password||!allowedHosts.includes(u.hostname.toLowerCase()))return '';
    for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|ref$)/i.test(k))u.searchParams.delete(k);
    u.hash='';
    return u.href;
  }catch{return '';}
}
function feedLink(xml) {
  const rss=tag(xml,'link');
  if(rss)return cleanText(rss,2048);
  return xml.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/i)?.[1]||'';
}
function mediaUrl(xml) {
  for(const hit of xml.matchAll(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi)){
    const tag=hit[0],type=attr(tag,'type'),medium=attr(tag,'medium');
    if(type&&!/^image\//i.test(type))continue;
    if(medium&&medium.toLowerCase()!=='image')continue;
    const url=attr(tag,'url');
    // Untyped RSS enclosures are sometimes links to HTML articles, not images.
    // For an untyped enclosure accept only filenames resembling actual image files.
    if(/^<enclosure\b/i.test(tag)&&!type&&!/\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(url))continue;
    if(url)return url;
  }
  return '';
}
export function parseFeed(xml,source) {
  const blocks=[...String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0,MAX_ITEMS_PER_FEED);
  return blocks.map(([, ,block])=>{
    const title=cleanText(tag(block,'title'),160);
    const url=normalizedUrl(feedLink(block),source.hosts);
    const description=cleanText(tag(block,'description')||tag(block,'summary')||tag(block,'content:encoded'),540);
    const rawDate=cleanText(tag(block,'pubDate')||tag(block,'published')||tag(block,'updated'),80);
    const publishedAt=Date.parse(rawDate);
    return {title,url,description,publishedAt,source:source.name,image:mediaUrl(block)};
  }).filter(item=>item.title.length>8&&item.url&&Number.isFinite(item.publishedAt));
}
export function eligible(item,now,maxAgeHours=72) {
  const age=now-item.publishedAt;
  return age>=-900000&&age<=maxAgeHours*3600000&&!/^(review|opinion|best deals|sponsored):/i.test(item.title);
}
export function rankNews(items) {
  const score=(a)=>{
    const all=(a.title+' '+a.description).toLowerCase();
    let n=a.publishedAt/3600000;
    if(/free (game|games)|free to keep|free-to-play|бесплатн|giveaway|available free/i.test(all))n+=24;
    if(/steam|epic games|pc release|gameplay|trailer|release date|update|announc|launch|playstation/i.test(all))n+=5;
    if(/sale|deal|discount|hardware|gift card|coupon/i.test(all))n-=8;
    return n;
  };
  return [...items].sort((a,b)=>score(b)-score(a));
}
export async function fetchNews(fetchFn=fetch,now=Date.now(),maxAgeHours=72) {
  const results=await Promise.allSettled(SOURCES.map(async source=>{
    const res=await fetchFn(source.url,{
      headers:{'Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml','User-Agent':'GameScannerNewsBot/1.0'},
      signal:AbortSignal.timeout(9000)
    });
    if(!res.ok)throw new Error(source.name+' HTTP '+res.status);
    const len=Number(res.headers.get('content-length')||0);
    if(len>MAX_FEED_BYTES)throw new Error(source.name+' feed too large');
    return parseFeed((await res.text()).slice(0,MAX_FEED_BYTES),source).filter(item=>eligible(item,now,maxAgeHours));
  }));
  const items=[],errors=[];
  for(let i=0;i<results.length;i++){
    if(results[i].status==='fulfilled')items.push(...results[i].value);
    else errors.push(SOURCES[i].name+': '+String(results[i].reason?.message||'unavailable').slice(0,120));
  }
  const unique=new Map();
  for(const item of rankNews(items))if(!unique.has(item.url))unique.set(item.url,item);
  return {articles:[...unique.values()],errors};
}
