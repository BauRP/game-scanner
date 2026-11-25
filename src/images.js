// Media links come only from configured publishers, never search engines or user input.
const PUBLISHER_HOSTS = Object.freeze({
  Gematsu: ['gematsu.com'],
  'PlayStation Blog': ['playstation.com'],
  'PC Gamer': ['pcgamer.com'],
  'Video Games Chronicle': ['videogameschronicle.com']
});
const MEDIA_HOSTS = Object.freeze({
  Gematsu: ['gematsu.com'],
  'PlayStation Blog': ['playstation.com'],
  'PC Gamer': ['pcgamer.com','futurecdn.net'],
  'Video Games Chronicle': ['videogameschronicle.com','gnwcdn.com']
});
const allowed = (host,domain)=>host===domain||host.endsWith('.'+domain);
export function trustedImageUrl(value,article){
  if(typeof value!=='string'||value.length>2048)return null;
  let image,story;
  try{image=new URL(value,article.url);story=new URL(article.url);}catch{return null;}
  if(image.protocol!=='https:'||image.username||image.password||image.port||
    image.hostname.includes(':')||/^\d+(?:\.\d+){3}$/.test(image.hostname)||
    /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$/i.test(image.hostname))return null;
  if(story.protocol!=='https:'||!PUBLISHER_HOSTS[article.source]?.some(d=>allowed(story.hostname,d)))return null;
  if(!MEDIA_HOSTS[article.source]?.some(d=>allowed(image.hostname,d)))return null;
  // An RSS enclosure can accidentally point to the article itself, which is HTML,
  // not a photo. Never submit the article URL to Telegram sendPhoto.
  if(image.origin===story.origin&&image.pathname.replace(/\/$/,'')===story.pathname.replace(/\/$/,''))return null;
  image.hash='';
  return image.href;
}
function decodeMeta(value){
  return String(value).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n))));
}
function attrs(tag){
  const out={};
  for(const [,key,a,b,c] of tag.matchAll(/([a-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
    out[key.toLowerCase()]=decodeMeta(a??b??c);
  return out;
}
export function extractImageFromHtml(html,article){
  for(const [tag] of String(html).matchAll(/<meta\b[^>]*>/gi)){
    const a=attrs(tag),key=(a.property||a.name||'').toLowerCase();
    if(['og:image:secure_url','og:image','twitter:image','twitter:image:src'].includes(key)){
      const url=trustedImageUrl(a.content,article);
      if(url)return url;
    }
  }
  return null;
}
async function readLimited(res,maxBytes){
  const size=Number(res.headers?.get?.('content-length')||0);
  if(size>maxBytes)throw new Error('Article HTML too large');
  if(!res.body?.getReader)return (await res.text()).slice(0,maxBytes);
  const reader=res.body.getReader(),chunks=[];let total=0;
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes)throw new Error('Article HTML too large');
      chunks.push(value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  const data=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(data);
}
export async function findArticleImage(article,fetchFn=fetch){
  const fromFeed=trustedImageUrl(article.image,article);
  if(fromFeed)return {url:fromFeed,method:'rss'};
  try{
    const r=await fetchFn(article.url,{method:'GET',redirect:'manual',
      headers:{Accept:'text/html','User-Agent':'GameScannerNewsBot/1.0'},
      signal:AbortSignal.timeout(6500)});
    if(!r.ok||(r.headers.get('content-type')&&!/text\/html/i.test(r.headers.get('content-type'))))return null;
    const url=extractImageFromHtml(await readLimited(r,500000),article);
    return url?{url,method:'og'}:null;
  }catch{return null;}
}