import {requireRussianDraft} from './translator.js';
import {findArticleImage} from './images.js';
import {coverPngBytes} from './cover.js';
import {sourceByName} from './sources.js';
const htmlEscape=value=>String(value).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));
export function composePost(draft,article){
  const headline=String(draft.headline||'').replace(/[\r\n]/g,' ').trim().slice(0,85);
  const body=String(draft.body||'').replace(/[\r\n]/g,' ').trim().slice(0,420);
  // Always expose the verified original publisher and article as a clickable attribution.
  const publisher=sourceByName(article?.source);
  let url;
  try{url=new URL(article?.url);}catch{throw new Error('Telegram caption lacks verifiable source');}
  if(!headline||!body||!publisher||url.protocol!=='https:'||url.username||url.password||url.port||!publisher.hosts.includes(url.hostname))throw new Error('Telegram caption lacks verifiable source');
  if(/https?:\/\/|www\.|(?:^|\s)источник\s*:/i.test(headline+' '+body))throw new Error('Unexpected public source footer');
  return '🎮 '+headline+'\n\n'+body;
}
export class TelegramApiError extends Error{
  constructor(method,status,description){
    super('Telegram '+method+' HTTP '+status+': '+String(description||'Unknown error').slice(0,160));
    this.name='TelegramApiError';this.status=status;this.description=String(description||'');
  }
}
async function callApi(token,method,options,fetchFn){
  const r=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',...options,signal:AbortSignal.timeout(12000)
  });
  const payload=await r.json().catch(()=>({}));
  if(!r.ok||!payload.ok)throw new TelegramApiError(method,r.status,payload.description);
  if(!payload.result?.message_id)throw new Error('Telegram did not return message_id; delivery is uncertain');
  return payload.result;
}
export async function telegramCall(token,method,data,fetchFn=fetch){
  return callApi(token,method,{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)},fetchFn);
}
export async function sendCoverPhoto(caption,env,fetchFn=fetch){
  const data=new FormData();
  data.append('chat_id',env.TELEGRAM_CHAT_ID);
  data.append('caption',caption);\n  data.append('parse_mode','HTML');
  data.append('photo',new Blob([coverPngBytes()],{type:'image/png'}),'game-scanner.png');
  const r=await callApi(env.TELEGRAM_BOT_TOKEN,'sendPhoto',{body:data},fetchFn);
  return r.message_id;
}
export async function sendPublisherPhoto(draft,article,image,env,fetchFn=fetch){
  requireRussianDraft(draft);
  if(!image?.bytes?.length||!['image/png','image/jpeg','image/webp'].includes(image.mime))throw new Error('Validated original image required');
  const data=new FormData();
  data.append('chat_id',env.TELEGRAM_CHAT_ID);
  data.append('caption',composePost(draft,article));\n  data.append('parse_mode','HTML');
  data.append('photo',new Blob([image.bytes],{type:image.mime}),image.mime==='image/png'?'news.png':image.mime==='image/webp'?'news.webp':'news.jpg');
  const sent=await callApi(env.TELEGRAM_BOT_TOKEN,'sendPhoto',{body:data},fetchFn);
  return sent.message_id;
}
export async function publishPost(draft,article,env,fetchFn=fetch,selection=undefined){
  requireRussianDraft(draft);
  const caption=composePost(draft,article);
  // Publisher photos may be copyrighted: permission must be considered by channel owner.
  if(env.USE_SOURCE_IMAGES==='true'){
    const image=selection===undefined?await findArticleImage(article,fetchFn):selection.image;
    if(image){
      try{
        const id=await sendPublisherPhoto(draft,article,image,env,fetchFn);
        if(selection?.check)selection.check.accepted=true;
        return id;
      }catch(e){
        // HTTP 400 proves the image was rejected and not published.
        // Unknown network/5xx failures are NEVER retried to avoid duplicate posts.
        if(!(e instanceof TelegramApiError&&e.status===400&&/photo|image|file|media/i.test(e.description||'')))throw e;
        if(selection?.check)selection.check.accepted=false;
        // One additional original image may be tried only after a definitive rejection.
        const alternative=await selection?.findAlternative?.();
        if(alternative&&alternative.url!==image.url){
          try{
            const id=await sendPublisherPhoto(draft,article,alternative,env,fetchFn);
            if(selection?.check)selection.check.accepted=true;
            return id;
          }catch(second){
            if(!(second instanceof TelegramApiError&&second.status===400&&/photo|image|file|media/i.test(second.description||'')))throw second;
          }
        }
        console.warn('Source image rejected; using original Game Scanner cover');
      }
    }
  }
  return sendCoverPhoto(caption,env,fetchFn);
}