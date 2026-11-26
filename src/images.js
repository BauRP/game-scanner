// Media links come only from configured publishers, never search engines or user input.
import {sourceByName} from './sources.js';
const allowed = (host,domain)=>host===domain||host.endsWith('.'+domain);
export function trustedImageUrl(value,article){
  if(typeof value!=='string'||value.length>2048)return null;
  let image,story;
  try{image=new URL(value,article.url);story=new URL(article.url);}catch{return null;}
  if(image.protocol!=='https:'||image.username||image.password||image.port||
    image.hostname.includes(':')||/^\d+(?:\.\d+){3}$/.test(image.hostname)||
    /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$/i.test(image.hostname))return null;
  if(story.protocol!=='https:'||!sourceByName(article.source)?.hosts.includes(story.hostname))return null;
  if(!sourceByName(article.source)?.media.some(d=>allowed(image.hostname,d)))return null;
  // An RSS enclosure can accidentally point to the article itself, which is HTML,
  // not a photo. Never submit the article URL to Telegram sendPhoto.
  if(image.origin===story.origin&&image.pathname.replace(/\/$/,'')===story.pathname.replace(/\/$/,''))return null;
  image.hash='';
  return image.href;
}
// Try several original images before the branded cover. All network reads are bounded.
const MAX_HTML=750000, MAX_IMAGE=8*1024*1024, MAX_CANDIDATES=5;
function decodeMeta(value){
  return String(value??'').replace(/&amp;|&quot;|&apos;|&#39;|&lt;|&gt;|&#x[\da-f]+;|&#\d+;/gi,m=>{
    const known={'&amp;':'&','&quot;':'"','&apos;':"'",'&#39;':"'",'&lt;':'<','&gt;':'>'};
    const k=m.toLowerCase();
    if(known[k])return known[k];
    const n=k.startsWith('&#x')?parseInt(k.slice(3,-1),16):Number(k.slice(2,-1));
    return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';
  });
}
function attrs(tag){
  const out=Object.create(null);
  for(const [,key,a,b,c] of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
    out[key.toLowerCase()]=decodeMeta(a??b??c);
  return out;
}
function usable(value,article){
  const url=trustedImageUrl(decodeMeta(value),article);
  if(!url)return null;
  const path=new URL(url).pathname;
  if(/(?:^|[/_.-])(?:logo|favicon|avatar|sprite|placeholder|pixel|tracking|spacer|icon|badge|advert|banner-ad)(?:[/_.-]|$)/i.test(path))return null;
  return url;
}
function add(list,value,article){
  const u=usable(value,article);
  if(u&&!list.includes(u)&&list.length<30)list.push(u);
}
function srcset(value){
  return String(value||'').split(',').map(x=>x.trim().split(/\s+/))
    .filter(x=>x[0]).sort((a,b)=>(parseFloat(b[1])||1)-(parseFloat(a[1])||1)).map(x=>x[0]);
}
export function extractInlineImages(html,article){
  const list=[];
  for(const [tag] of String(html).matchAll(/<img\b[^>]*>/gi)){
    const a=attrs(tag);
    if((a.width&&Number(a.width)<120)||(a.height&&Number(a.height)<80))continue;
    if(/(?:^|\s)(?:avatar|logo|advertisement|related-post|author-photo)(?:\s|$)/i.test(a.class||''))continue;
    for(const value of [a['data-src'],a['data-lazy-src'],a['data-original'],...srcset(a['data-srcset']||a.srcset),a.src])add(list,value,article);
  }
  // Modern publisher pages frequently offer AVIF plus JPEG/WebP alternatives.
  for(const [picture] of String(html).matchAll(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi)){
    if(list.length>=30)break;
    if(/<img\b[^>]*class\s*=\s*["'][^"']*(?:avatar|advertisement|author-photo)/i.test(picture))continue;
    for(const [tag] of picture.matchAll(/<source\b[^>]*>/gi)){
      const a=attrs(tag);
      if(a.type&&!/^image\/(?:jpeg|png|webp)$/i.test(a.type))continue;
      for(const value of srcset(a['data-srcset']||a.srcset))add(list,value,article);
    }
  }
  return list;
}
export function extractImageCandidates(html,article){
  const list=[],s=String(html);
  for(const [tag] of s.matchAll(/<meta\b[^>]*>/gi)){
    const a=attrs(tag),key=(a.property||a.name||a.itemprop||'').toLowerCase();
    if(['og:image:secure_url','og:image','og:image:url','twitter:image','twitter:image:src','image','thumbnailurl'].includes(key))add(list,a.content,article);
  }
  for(const [tag] of s.matchAll(/<link\b[^>]*>/gi)){
    const a=attrs(tag);
    if((a.rel||'').toLowerCase()==='image_src')add(list,a.href,article);
  }
  function imageValue(v){
    if(typeof v==='string')add(list,v,article);
    else if(Array.isArray(v))v.slice(0,12).forEach(imageValue);
    else if(v&&typeof v==='object')add(list,v.contentUrl||v.url,article);
  }
  function inspect(v,depth=0){
    if(!v||typeof v!=='object'||depth>8)return;
    if(Array.isArray(v)){v.slice(0,40).forEach(x=>inspect(x,depth+1));return;}
    const types=[v['@type']].flat().map(String);
    if(types.some(t=>/^(?:NewsArticle|Article|BlogPosting|ReportageNewsArticle|VideoGame|WebPage)$/i.test(t))||(!types[0]&&depth===0)){
      imageValue(v.image);imageValue(v.thumbnailUrl);imageValue(v.primaryImageOfPage);
    }
    if(v['@graph'])inspect(v['@graph'],depth+1);
    if(v.mainEntity)inspect(v.mainEntity,depth+1);
  }
  for(const [,open,json] of s.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)){
    if((attrs(open).type||'').toLowerCase()!=='application/ld+json')continue;
    try{inspect(JSON.parse(json));}catch{}
  }
  const body=s.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0]||s.match(/<main\b[^>]*>[\s\S]*?(?:<\/main>|$)/i)?.[0];
  if(body){const main=body.replace(/<(aside|nav|footer|script)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');for(const u of extractInlineImages(main,article))add(list,u,article);}
  return list;
}
export function extractImageFromHtml(html,article){return extractImageCandidates(html,article)[0]||null;}
async function readLimited(res,maxBytes,prefixOnly=false){
  const size=Number(res.headers.get('content-length')||0);
  if(!prefixOnly&&size>maxBytes){await res.body?.cancel().catch(()=>{});throw Error('Image too large');}
  const reader=res.body?.getReader();if(!reader)throw Error('Empty response');
  const chunks=[];let total=0;
  try{
    while(total<maxBytes){
      const {value,done}=await reader.read();
      if(done)break;
      if(total+value.byteLength>maxBytes&&!prefixOnly)throw Error('Image too large');
      const chunk=value.subarray(0,maxBytes-total);chunks.push(chunk);total+=chunk.byteLength;
    }
    if(!prefixOnly&&total===maxBytes&&!(await reader.read()).done)throw Error('Image too large');
  }finally{await reader.cancel().catch(()=>{});}
  const data=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return data;
}
function storyUrl(value,article){
  try{
    const u=new URL(value,article.url);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&sourceByName(article.source)?.hosts.includes(u.hostname)?u.href:null;
  }catch{return null;}
}
async function boundedFetch(url,article,fetchFn,isImage,deadline){
  const validate=isImage?u=>usable(u,article):u=>storyUrl(u,article);
  for(let hops=0;hops<=2;hops++){
    url=validate(url);if(!url||Date.now()>=deadline)return null;
    const res=await fetchFn(url,{method:'GET',redirect:'manual',
      headers:{Accept:isImage?'image/jpeg,image/png,image/webp;q=0.9,image/avif;q=0':'text/html,application/xhtml+xml','User-Agent':'GameScannerNewsBot/1.0',...(isImage?{Referer:article.url}:{})},
      signal:AbortSignal.timeout(Math.max(1,Math.min(6500,deadline-Date.now())))});
    if([301,302,303,307,308].includes(res.status)){
      const next=res.headers.get('location');await res.body?.cancel().catch(()=>{});
      if(!next)return null;url=new URL(next,url).href;continue;
    }
    if(!res.ok){await res.body?.cancel().catch(()=>{});return null;}
    return {res,url};
  }
  return null;
}
export function fileType(b){
  if(b.length>=33&&[137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x)&&String.fromCharCode(...b.subarray(12,16))==='IHDR'){
    const view=new DataView(b.buffer,b.byteOffset,b.byteLength),w=view.getUint32(16),h=view.getUint32(20);
    if(w>=120&&h>=80&&w+h<=10000&&Math.max(w/h,h/w)<=20)return 'image/png';
  }
  if(b.length>=20&&b[0]===255&&b[1]===216&&b[2]===255&&b[b.length-2]===255&&b[b.length-1]===217){
    // Read JPEG SOF dimensions, not merely the extension or HTTP MIME type.
    let i=2;
    while(i+4<b.length&&b[i]===255){
      while(b[i]===255)i++;
      const marker=b[i++];if(marker===218||marker===217)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      const n=b[i]*256+b[i+1];if(n<2||i+n>b.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&n>=8){
        const h=b[i+3]*256+b[i+4],w=b[i+5]*256+b[i+6];
        if(w>=120&&h>=80&&w+h<=10000&&Math.max(w/h,h/w)<=20)return 'image/jpeg';
        break;
      }
      i+=n;
    }
  }
  // WebP RIFF headers: reject animation and dimensions outside Telegram's photo limits.
  const ascii=(i,n)=>String.fromCharCode(...b.subarray(i,i+n));
  if(b.length>=30&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'){
    const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
    if(view.getUint32(4,true)+8!==b.length)return null;
    let w=0,h=0;
    if(ascii(12,4)==='VP8X'&&view.getUint32(16,true)===10){
      if(b[20]&2)return null;
      w=1+b[24]+(b[25]<<8)+(b[26]<<16);h=1+b[27]+(b[28]<<8)+(b[29]<<16);
    }else if(ascii(12,4)==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42){
      w=view.getUint16(26,true)&16383;h=view.getUint16(28,true)&16383;
    }else if(ascii(12,4)==='VP8L'&&b[20]===47){
      const bits=view.getUint32(21,true);w=(bits&16383)+1;h=((bits>>>14)&16383)+1;
    }
    if(w>=120&&h>=80&&w+h<=10000&&Math.max(w/h,h/w)<=20)return 'image/webp';
  }
  return null;
}
async function download(url,article,fetchFn,deadline){
  try{
    const hit=await boundedFetch(url,article,fetchFn,true,deadline);
    if(!hit)return null;
    const type=hit.res.headers.get('content-type')||'';
    if(type&&!/^(?:image\/|application\/octet-stream)/i.test(type)){await hit.res.body?.cancel().catch(()=>{});return null;}
    const bytes=await readLimited(hit.res,MAX_IMAGE);
    const mime=fileType(bytes);return mime?{url:hit.url,bytes,mime}:null;
  }catch{return null;}
}
export async function findArticleImage(article,fetchFn=fetch){
  const deadline=Date.now()+16000,seen=new Set();
  let attempts=0;
  async function tryList(values,method,limit){
    for(const value of values){
      const url=usable(value,article);
      if(!url||seen.has(url))continue;
      if(attempts>=limit||Date.now()>=deadline)break;
      seen.add(url);attempts++;
      const file=await download(url,article,fetchFn,deadline);
      if(file)return {...file,method};
    }
    return null;
  }
  // Prefer Telegram-compatible candidates; AVIF URLs are tried last for CDN content negotiation.
  const feedImages=[...(article.imageCandidates||[]),article.image].filter(Boolean).sort((a,b)=>Number(/\.avif(?:[?#]|$)/i.test(a))-Number(/\.avif(?:[?#]|$)/i.test(b)));
  const rss=await tryList(feedImages,'rss',2);
  if(rss)return rss;
  try{
    const hit=await boundedFetch(article.url,article,fetchFn,false,deadline);
    if(hit){
      if(!hit.res.headers.get('content-type')||/(?:text\/html|application\/xhtml\+xml)/i.test(hit.res.headers.get('content-type'))){
        const html=new TextDecoder().decode(await readLimited(hit.res,MAX_HTML,true));
        const candidates=extractImageCandidates(html,{...article,url:hit.url});
        candidates.sort((a,b)=>Number(/\.avif(?:[?#]|$)/i.test(a))-Number(/\.avif(?:[?#]|$)/i.test(b)));
        const image=await tryList(candidates,'article',MAX_CANDIDATES);
        if(image)return image;
      }else await hit.res.body?.cancel().catch(()=>{});
    }
  }catch{}
  return tryList(feedImages,'rss',MAX_CANDIDATES);
}
