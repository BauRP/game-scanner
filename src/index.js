import {commissionOnce,commissioningStatus} from './commissioning.js';
import {photoCandidates} from './photo-selection.js';
import {readQuality,saveQuality,qualityStatus} from './source-quality.js';
import {fetchNews} from './news.js';
import {initialize,dayKey,alreadyAttempted,publishedCount,claim,markSent,markFailed,releaseClaim,reserveHour,recentTitleKeys,titleKey,recordCycle,cycleHistory,releaseHour,isSimilarTitle,recentCategories,prepareTitleIndex} from './storage.js';
import {writePost,EditorialSkip} from './ai.js';
import {previewHtml,previewStatus,createAiPreview,refreshPreviewImage} from './preview.js';
import {usageStatus} from './usage.js';
import {russianDraftProblem} from './translator.js';
import {publishPost,telegramCall} from './telegram.js';
const intVal=(value,fallback,min,max)=>{const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;};
const adminAllowed=(request,env)=>Boolean(env.ADMIN_KEY&&request.headers.get('Authorization')==='Bearer '+env.ADMIN_KEY);
async function authorizedTool(request,env){
 if(adminAllowed(request,env))return true;
 if(!env.ADMIN_KEY||!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type')||''))return false;
 if(Number(request.headers.get('content-length')||0)>2048)return false;
 try{const reader=request.body?.getReader();if(!reader)return false;let size=0,body='';const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048)return false;body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}return new URLSearchParams(body).get('admin_key')===env.ADMIN_KEY;}catch{return false;}
}
const commissioned=r=>r.status==='sent'&&r.primaryVerified===true&&r.backupVerified===true&&r.imageMode==='publisher'&&Number.isInteger(r.messageId)&&r.messageId>0;
export async function runCycle(env,deps={}){
  if(env.PUBLISH_ENABLED!=='true')return {status:'disabled'};
  if(!env.DB||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)return {status:'missing_configuration'};
  if(env.COMMISSION_ONCE==='true'){
    const result=await commissioningStatus(env);
    if(!commissioned(result))return {status:'commissioning_required'};
  }
  const now=deps.now??Date.now();
  const clock=deps.clock||Date.now;
  const day=dayKey(now,0); // Cloudflare free allocation resets at 00:00 UTC (05:00 Kazakhstan).
  const max=intVal(env.MAX_POSTS_PER_DAY,24,1,24);
  await initialize(env.DB);
  if(await publishedCount(env.DB,day)>=max)return {status:'daily_limit',day};
  if(!await reserveHour(env.DB,now))return {status:'hour_already_reserved',day};
  const usage=await usageStatus(env.DB);
  if(usage.quotaExhausted||usage.estimatedNeurons>=9000)return {status:'daily_ai_quota',day};
  const previousTitles=await recentTitleKeys(env.DB,now);
  const titleIndex=prepareTitleIndex(previousTitles);
  const recent=await recentCategories(env.DB,now);
  let news;
  try{news=await (deps.fetchNews||fetchNews)(deps.fetchFn||fetch,now,intVal(env.MAX_ARTICLE_AGE_HOURS,72,1,168));}catch{await releaseHour(env.DB,now);return {status:'feed_unavailable',day};}
  const {articles,errors=[],feedStats=[]}=news;
  const checks=[],quality=await readQuality(env.DB);
  let draftsTried=0;
  const checkedArticles=new Set();
  try{
  for await(const selection of photoCandidates(articles.filter(a=>!previousTitles.has(titleKey(a.title))&&!isSimilarTitle(a.title,titleIndex)),{fetchFn:deps.fetchFn||fetch,findImage:deps.findArticleImage,wasAttempted:url=>alreadyAttempted(env.DB,url),useImages:env.USE_SOURCE_IMAGES==='true',quality,checks,recentCategories:recent})){
    const {article:item,editorial}=selection;
    if(draftsTried>=2)break;
    // Never start delivery in a different hour from the reservation.
    if((!deps.now||deps.clock)&&Math.floor(clock()/3600000)!==Math.floor(now/3600000))return {status:'hour_expired',day};
    if(checkedArticles.has(item.url))continue;
    checkedArticles.add(item.url);
    if(!await claim(env.DB,item,day,now))continue;
    draftsTried++;
    let draft;
    try{
      draft=await (deps.writePost||writePost)(item,env,deps.fetchFn||fetch,editorial);
      const problem=russianDraftProblem(draft);
      if(problem)throw new EditorialSkip(problem);
    }catch(e){
      if(e instanceof EditorialSkip){
        await markFailed(env.DB,item.url);
        continue;
      }
      // AI failure happened BEFORE any Telegram request. Safe to release the claim.
      await releaseClaim(env.DB,item.url);
      console.error('AI unavailable; nothing was published:',String(e?.message||e).slice(0,140));
      const quota=e?.diagnostics?.some(x=>x.reason==='daily_quota');
      if(!quota)await releaseHour(env.DB,now);
      return {status:quota?'daily_ai_quota':'ai_unavailable',day};
    }
    if((!deps.now||deps.clock)&&Math.floor(clock()/3600000)!==Math.floor(now/3600000)){await releaseClaim(env.DB,item.url);return {status:'hour_expired',day};}
    try{
      const messageId=await (deps.publishPost||publishPost)(draft,item,env,deps.fetchFn||fetch,selection);
      if(!Number.isInteger(messageId)||messageId<=0)throw Error('Missing Telegram message ID');
      await markSent(env.DB,item.url,messageId);
      return {status:'sent',source:item.source,engine:draft.engine,category:editorial.category,imageMode:selection.check?.accepted===true?'publisher':'game-scanner-cover',messageId,day};
    }catch(e){
      // Never auto retry ambiguous Telegram delivery, which can cause duplicates.
      await markFailed(env.DB,item.url);
      console.error('Posting failed:',String(e?.message||e).slice(0,140));
      return {status:'post_failed',day};
    }
  }
  if(errors.length)console.warn('Feeds unavailable:',errors.join(' | '));
  if(!articles.length&&errors.length)await releaseHour(env.DB,now);
  return {status:articles.length?'no_new_articles':'no_fresh_articles',failedFeeds:errors.length,day};
  }finally{await saveQuality(env.DB,feedStats,checks);}
}

const TEST_MESSAGE = '🎮 Game Scanner\n\n✅ Тестовая публикация! Бот успешно отправил сообщение в наш Telegram-канал.\n\nЭто только проверка связи. Автоматическая публикация игровых новостей пока выключена.';

export async function runOneTimeTest(env, deps = {}) {
  if (!env.TEST_MESSAGE_ONCE) return {status: 'not_requested'};
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return {status: 'missing_configuration'};
  const key = String(env.TEST_MESSAGE_ONCE);
  const db = env.DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS test_deliveries (test_key TEXT PRIMARY KEY, status TEXT NOT NULL, telegram_message_id INTEGER, recorded_at TEXT NOT NULL)").run();
  const claimResult = await db.prepare("INSERT OR IGNORE INTO test_deliveries (test_key, status, recorded_at) VALUES (?, 'sending', ?)")
    .bind(key, new Date().toISOString()).run();
  if (Number(claimResult?.meta?.changes || 0) !== 1) {
    const existing = await db.prepare("SELECT status FROM test_deliveries WHERE test_key = ?").bind(key).first();
    return {status: existing?.status || 'already_attempted'};
  }
  try {
    const result = await (deps.telegramCall || telegramCall)(
      env.TELEGRAM_BOT_TOKEN, 'sendMessage',
      {chat_id: env.TELEGRAM_CHAT_ID, text: TEST_MESSAGE, link_preview_options: {is_disabled: true}},
      deps.fetchFn || fetch
    );
    await db.prepare("UPDATE test_deliveries SET status = 'sent', telegram_message_id = ? WHERE test_key = ?")
      .bind(result?.message_id || null, key).run();
    return {status: 'sent'};
  } catch (error) {
    await db.prepare("UPDATE test_deliveries SET status = 'failed' WHERE test_key = ?").bind(key).run();
    console.error('One-time Telegram test failed:', String(error?.message || error).slice(0, 180));
    return {status: 'failed'};
  }
}

export default {
  async scheduled(event,env,ctx){
    // Test messages are manual only, never sent by cron.
    // Ignore old cron triggers while the Cloudflare schedule propagates.
    const retry=event?.cron==='12 * * * *';
    if(event?.cron&&event.cron!=='0 * * * *'&&!retry)return;
    const now=Date.now();
    // Do not replay delayed triggers from an already elapsed hour.
    if(Number.isFinite(event?.scheduledTime)&&Math.floor(event.scheduledTime/3600000)!==Math.floor(now/3600000))return;
    const work=(async()=>{
      if(retry){const history=await cycleHistory(env.DB);if(!history.available||!history.lastCycle||Math.floor(Date.parse(history.lastCycle.recordedAt)/3600000)!==Math.floor(now/3600000)||!['ai_unavailable','feed_unavailable','no_fresh_articles'].includes(history.lastCycle.status))return {status:'retry_not_needed'};}
      if(env.PUBLISH_ENABLED!=='true'&&env.COMMISSION_ONCE==='true')return commissionOnce(env);
      const result=await runCycle(env,{now,clock:Date.now});
      // The owner's launch request is armed, but real news remain gated on the two-model test.
      if(result.status==='commissioning_required'&&env.COMMISSION_ONCE==='true'){
        const state=await commissioningStatus(env);
        if(['sent','sending','delivery_unconfirmed'].includes(state.status))return result;
        if(state.status==='checking'&&!state.recoveryAvailable)return result;
        if(state.retryAvailable===false&&!state.recoveryAvailable)return result;
        if(!env.AI||env.USE_SOURCE_IMAGES!=='true')return {status:'missing_configuration'};
        if(!await reserveHour(env.DB,now))return {status:'hour_already_reserved'};
        return commissionOnce({...env,PUBLISH_ENABLED:'false'},{now});
      }
      return result;
    })();
    ctx.waitUntil(work.then(async result=>{if(result.status!=='retry_not_needed')await recordCycle(env.DB,now,result);console.log('Game Scanner:',JSON.stringify(result));})
      .catch(async e=>{await recordCycle(env.DB,now,{status:'cycle_error'});console.error('Scheduled cycle failed:',String(e?.message||e).slice(0,140));}));
  },
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='POST'&&['/ai-preview','/ai-preview-image','/test-message'].includes(url.pathname)&&!await authorizedTool(request,env))return new Response('Unauthorized',{status:401});
    if(url.pathname==='/ai-usage'&&request.method==='GET')return Response.json(await usageStatus(env.DB),{headers:{'Cache-Control':'no-store'}});
    if(url.pathname==='/publication-status'&&request.method==='GET')return Response.json(await cycleHistory(env.DB),{headers:{'Cache-Control':'no-store'}});
    if(url.pathname==='/source-quality'&&request.method==='GET')return Response.json(await qualityStatus(env.DB),{headers:{'Cache-Control':'no-store'}});
    if(url.pathname==='/commissioning-status'&&request.method==='GET'){
      return Response.json(await commissioningStatus(env),{headers:{'Cache-Control':'no-store'}});
    }
    if(url.pathname==='/commission-once'&&request.method==='POST'){
      if(!env.ADMIN_KEY||request.headers.get('Authorization')!=='Bearer '+env.ADMIN_KEY)return new Response('Unauthorized',{status:401});
      try{return Response.json(await commissionOnce(env),{headers:{'Cache-Control':'no-store'}});}
      catch{return Response.json({status:'check_failed'},{status:500});}
    }
    if(url.pathname==='/ai-preview-image'&&request.method==='POST'){
      return refreshPreviewImage(env);
    }
    if(url.pathname==='/ai-preview-status'&&request.method==='GET'){
      return Response.json(await previewStatus(env),{headers:{'Cache-Control':'no-store'}});
    }
    if(url.pathname==='/ai-preview'){
      if(request.method==='GET')return new Response(previewHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
      if(request.method==='POST')return createAiPreview(env);
      return new Response('Method Not Allowed',{status:405,headers:{Allow:'GET, POST'}});
    }
    if(url.pathname==='/test-message'){
      if(request.method==='POST'){
        if(env.PUBLISH_ENABLED==='true')return new Response('Тестовая отправка недоступна во время автоматической рассылки.',{status:409});
        try{
          const result=await runOneTimeTest(env);
          const lines={
            sent:'Успешно: Telegram подтвердил отправку одного тестового сообщения. Проверь канал.',
            failed:'Ошибка: Telegram не подтвердил отправку. Проверь Worker Logs; повтор блокирован, чтобы избежать дублей.',
            sending:'Попытка отправки уже началась. Проверь /health.',
            not_requested:'Тестовая отправка отключена в конфигурации.',
            missing_configuration:'Ошибка: не хватает TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID или D1.',
            already_attempted:'Этот тест уже запускался.'
          };
          return new Response(lines[result.status]||('Состояние теста: '+result.status),{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
        }catch(error){
          console.error('Test request error:',String(error?.message||error).slice(0,180));
          return new Response('Сбой теста. Открой Worker Logs.',{status:500,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
        }
      }
      if(request.method==='GET')return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game Scanner — тест</title><body style="font:18px system-ui;max-width:580px;margin:70px auto;padding:20px"><h1>🎮 Game Scanner</h1><p>Проверка связи с Telegram. Кнопка отправляет одно тестовое сообщение. Автоматические новости остаются выключенными.</p><form method="post" action="/test-message"><label>Ключ администратора <input name="admin_key" type="password" required autocomplete="off"></label><button style="font:inherit;padding:14px 20px;cursor:pointer">Отправить один тест</button></form><p><a href="/health">Проверить состояние</a></p></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
      return new Response('Method Not Allowed',{status:405,headers:{'Allow':'GET, POST'}});
    }
    if(request.method==='GET'&&url.pathname==='/health'){
      let testStatus = env.TEST_MESSAGE_ONCE ? 'pending' : 'not_requested';
      if(env.TEST_MESSAGE_ONCE && env.DB){
        try{
          const row = await env.DB.prepare("SELECT status FROM test_deliveries WHERE test_key = ?")
            .bind(String(env.TEST_MESSAGE_ONCE)).first();
          if(row?.status)testStatus=row.status;
        }catch{ /* The test table may not exist before the first scheduled event. */ }
      }
      const state=await commissioningStatus(env),history=await cycleHistory(env.DB);
      const requested=env.PUBLISH_ENABLED==='true';
      const ready=requested&&Boolean(env.DB&&env.AI&&env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID)&&(env.COMMISSION_ONCE!=='true'||commissioned(state));
      return Response.json({ok:true,service:'game-scanner',publishing:requested,readyToPublish:ready,commissioningState:state.status,history,
        telegramConfigured:Boolean(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID),storageConfigured:Boolean(env.DB),
        testStatus,commissioning:env.COMMISSION_ONCE==='true',imagePipelineVersion:'original-photo-v2',aiDiagnosticsVersion:2,primaryModel:env.AI_MODEL||'@cf/openai/gpt-oss-20b',backupModel:env.AI_BACKUP_MODEL||'@cf/google/gemma-4-26b-a4b-it',sourceImages:env.USE_SOURCE_IMAGES==='true',sourceExpansionVersion:2,translationPolicy:'russian-required-v1',captionPolicy:'headline-body-v1',publicationIntervalMinutes:60,maxPostsPerDay:intVal(env.MAX_POSTS_PER_DAY,24,1,24),quotaResetUtc:'00:00'},{headers:{'Cache-Control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/run'){
      if(!env.ADMIN_KEY||request.headers.get('Authorization')!=='Bearer '+env.ADMIN_KEY)return new Response('Unauthorized',{status:401});
      try{const now=Date.now(),result=await runCycle(env,{now});await recordCycle(env.DB,now,result);return Response.json(result);}
      catch(e){console.error('Manual run failed:',String(e?.message||e).slice(0,140));return Response.json({error:'Run failed; check Worker logs'},{status:500});}
    }
    return new Response('Not found',{status:404});
  }
};
