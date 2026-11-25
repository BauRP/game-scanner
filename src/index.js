import {fetchNews} from './news.js';
import {initialize,dayKey,alreadyAttempted,publishedCount,claim,markSent,markFailed} from './storage.js';
import {writePost} from './ai.js';
import {publishPost} from './telegram.js';
const intVal=(value,fallback,min,max)=>{const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;};
export async function runCycle(env,deps={}){
  if(env.PUBLISH_ENABLED!=='true')return {status:'disabled'};
  if(!env.DB||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)return {status:'missing_configuration'};
  const now=deps.now??Date.now();
  const day=dayKey(now,intVal(env.KZ_UTC_OFFSET_HOURS,5,-12,14));
  const max=intVal(env.MAX_POSTS_PER_DAY,8,1,10);
  await initialize(env.DB);
  if(await publishedCount(env.DB,day)>=max)return {status:'daily_limit',day};
  const {articles,errors}=await (deps.fetchNews||fetchNews)(deps.fetchFn||fetch,now,intVal(env.MAX_ARTICLE_AGE_HOURS,72,1,168));
  for(const item of articles){
    if(await alreadyAttempted(env.DB,item.url))continue;
    if(!await claim(env.DB,item,day,now))continue;
    try{
      const draft=await (deps.writePost||writePost)(item,env,deps.fetchFn||fetch);
      const messageId=await (deps.publishPost||publishPost)(draft,item,env,deps.fetchFn||fetch);
      await markSent(env.DB,item.url,messageId);
      return {status:'sent',source:item.source,engine:draft.engine,day};
    }catch(e){
      await markFailed(env.DB,item.url);
      // Never auto retry ambiguous Telegram delivery, which can cause duplicates.
      console.error('Posting failed:',String(e?.message||e).slice(0,140));
      return {status:'post_failed',day};
    }
  }
  if(errors.length)console.warn('Feeds unavailable:',errors.join(' | '));
  return {status:articles.length?'no_new_articles':'no_fresh_articles',failedFeeds:errors.length,day};
}
export default {
  async scheduled(event,env,ctx){
    ctx.waitUntil(runCycle(env).then(result=>console.log('Game Scanner:',JSON.stringify(result)))
      .catch(e=>console.error('Cycle failed:',String(e?.message||e).slice(0,140))));
  },
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/health'){
      return Response.json({ok:true,service:'game-scanner',publishing:env.PUBLISH_ENABLED==='true',
        telegramConfigured:Boolean(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID),storageConfigured:Boolean(env.DB)},{headers:{'Cache-Control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/run'){
      if(!env.ADMIN_KEY||request.headers.get('Authorization')!=='Bearer '+env.ADMIN_KEY)return new Response('Unauthorized',{status:401});
      try{return Response.json(await runCycle(env));}
      catch(e){console.error('Manual run failed:',String(e?.message||e).slice(0,140));return Response.json({error:'Run failed; check Worker logs'},{status:500});}
    }
    return new Response('Not found',{status:404});
  }
};
