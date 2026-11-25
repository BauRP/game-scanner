import {findArticleImage} from './images.js';
import {coverPngBytes} from './cover.js';
export function composePost(draft,article){
  const headline=String(draft.headline||'').replace(/[\r\n]/g,' ').trim().slice(0,85);
  const body=String(draft.body||'').replace(/[\r\n]/g,' ').trim().slice(0,420);
  const source=String(article.source||'').replace(/[\r\n]/g,' ').trim().slice(0,50);
  const url=String(article.url||'');
  if(!headline||!body||!source||!/^https:\/\//.test(url)||url.length>450)throw new Error('Telegram caption lacks verifiable source');
  const ending='\n\nИсточник: '+source+'\n'+url;
  const intro='🎮 '+headline+'\n\n';
  const maxBody=Math.min(420,1024-intro.length-ending.length);
  if(maxBody<35)throw new Error('Article link leaves no room for a caption');
  return intro+body.slice(0,maxBody)+ending;
}
export class TelegramApiError extends Error{
  constructor(method,status,description){
    super('Telegram '+method+' HTTP '+status+': '+String(description||'Unknown error').slice(0,160));
    this.name='TelegramApiError';this.status=status;
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
  data.append('caption',caption);
  data.append('photo',new Blob([coverPngBytes()],{type:'image/png'}),'game-scanner.png');
  const r=await callApi(env.TELEGRAM_BOT_TOKEN,'sendPhoto',{body:data},fetchFn);
  return r.message_id;
}
export async function sendPublisherPhoto(draft,article,image,env,fetchFn=fetch){
  if(!image?.bytes?.length||!['image/png','image/jpeg'].includes(image.mime))throw new Error('Validated original image required');
  const data=new FormData();
  data.append('chat_id',env.TELEGRAM_CHAT_ID);
  data.append('caption',composePost(draft,article));
  data.append('photo',new Blob([image.bytes],{type:image.mime}),image.mime==='image/png'?'news.png':'news.jpg');
  const sent=await callApi(env.TELEGRAM_BOT_TOKEN,'sendPhoto',{body:data},fetchFn);
  return sent.message_id;
}
export async function publishPost(draft,article,env,fetchFn=fetch,selection=undefined){
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
        if(!(e instanceof TelegramApiError&&e.status===400))throw e;
        if(selection?.check)selection.check.accepted=false;
        console.warn('Source image rejected; using original Game Scanner cover');
      }
    }
  }
  return sendCoverPhoto(caption,env,fetchFn);
}