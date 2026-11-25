export function composePost(draft,article){
  const headline=String(draft.headline||article.title).trim().slice(0,90);
  const body=String(draft.body||'').trim().slice(0,520);
  const source=String(article.source).replace(/[\r\n]/g,'').slice(0,50);
  // Plain text prevents HTML/Markdown injection from RSS content.
  return ('🎮 '+headline+'\n\n'+body+'\n\nИсточник: '+source+'\n'+article.url).slice(0,1000);
}
export async function telegramCall(token,method,data,fetchFn=fetch){
  const r=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),
    signal:AbortSignal.timeout(12000)
  });
  const payload=await r.json().catch(()=>({}));
  if(!r.ok||!payload.ok)throw new Error('Telegram '+method+' HTTP '+r.status+': '+String(payload.description||'Unknown error').slice(0,160));
  return payload.result;
}
export async function publishPost(draft,article,env,fetchFn=fetch){
  const chat_id=env.TELEGRAM_CHAT_ID;
  const text=composePost(draft,article);
  if(env.DEFAULT_PHOTO_FILE_ID){
    const r=await telegramCall(env.TELEGRAM_BOT_TOKEN,'sendPhoto',{chat_id,photo:env.DEFAULT_PHOTO_FILE_ID,caption:text},fetchFn);
    return r?.message_id;
  }
  if(env.USE_SOURCE_IMAGES==='true'&&article.image){
    // Only opt in after verifying publisher allows republishing its images.
    const permittedHost=new URL(article.url).hostname;
    let image=null;
    try{image=new URL(article.image);}catch{}
    if(image?.protocol==='https:'&&image.hostname===permittedHost){
      const r=await telegramCall(env.TELEGRAM_BOT_TOKEN,'sendPhoto',{chat_id,photo:image.href,caption:text},fetchFn);
      return r?.message_id;
    }
  }
  // Link previews can contain the original article image; no illegal rehosting.
  const r=await telegramCall(env.TELEGRAM_BOT_TOKEN,'sendMessage',{chat_id,text,link_preview_options:{is_disabled:false}},fetchFn);
  return r?.message_id;
}
