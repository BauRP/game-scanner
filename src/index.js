import {commissionOnce,commissioningStatus} from './commissioning.js';
import {fetchNews} from './news.js';
import {initialize,dayKey,alreadyAttempted,publishedCount,claim,markSent,markFailed,releaseClaim} from './storage.js';
import {writePost,EditorialSkip} from './ai.js';
import {assessArticle} from './editorial.js';
import {previewHtml,previewStatus,createAiPreview,refreshPreviewImage} from './preview.js';
import {publishPost,telegramCall} from './telegram.js';
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
    const editorial=assessArticle(item);
    if(!editorial.eligible)continue;
    if(await alreadyAttempted(env.DB,item.url))continue;
    if(!await claim(env.DB,item,day,now))continue;
    let draft;
    try{
      draft=await (deps.writePost||writePost)(item,env,deps.fetchFn||fetch,editorial);
    }catch(e){
      if(e instanceof EditorialSkip){
        await markFailed(env.DB,item.url);
        continue;
      }
      // AI failure happened BEFORE any Telegram request. Safe to release the claim.
      await releaseClaim(env.DB,item.url);
      console.error('AI unavailable; nothing was published:',String(e?.message||e).slice(0,140));
      return {status:'ai_unavailable',day};
    }
    try{
      const messageId=await (deps.publishPost||publishPost)(draft,item,env,deps.fetchFn||fetch);
      await markSent(env.DB,item.url,messageId);
      return {status:'sent',source:item.source,engine:draft.engine,category:editorial.category,day};
    }catch(e){
      // Never auto retry ambiguous Telegram delivery, which can cause duplicates.
      await markFailed(env.DB,item.url);
      console.error('Posting failed:',String(e?.message||e).slice(0,140));
      return {status:'post_failed',day};
    }
  }
  if(errors.length)console.warn('Feeds unavailable:',errors.join(' | '));
  return {status:articles.length?'no_new_articles':'no_fresh_articles',failedFeeds:errors.length,day};
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
    const work=env.PUBLISH_ENABLED!=='true'&&env.COMMISSION_ONCE==='true'?commissionOnce(env):runCycle(env);
    ctx.waitUntil(work.then(result=>console.log('Game Scanner:',JSON.stringify(result)))
      .catch(e=>console.error('Scheduled cycle failed:',String(e?.message||e).slice(0,140))));
  },
  async fetch(request,env){
    const url=new URL(request.url);
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
      if(request.method==='GET')return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game Scanner — тест</title><body style="font:18px system-ui;max-width:580px;margin:70px auto;padding:20px"><h1>🎮 Game Scanner</h1><p>Проверка связи с Telegram. Кнопка отправляет одно тестовое сообщение. Автоматические новости остаются выключенными.</p><form method="post" action="/test-message"><button style="font:inherit;padding:14px 20px;cursor:pointer">Отправить один тест</button></form><p><a href="/health">Проверить состояние</a></p></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
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
      return Response.json({ok:true,service:'game-scanner',publishing:env.PUBLISH_ENABLED==='true',
        telegramConfigured:Boolean(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID),storageConfigured:Boolean(env.DB),
        testStatus,commissioning:env.COMMISSION_ONCE==='true',imagePipelineVersion:'original-photo-v2',primaryModel:env.AI_MODEL||'@cf/openai/gpt-oss-20b',backupModel:env.AI_BACKUP_MODEL||'@cf/google/gemma-4-26b-a4b-it',sourceImages:env.USE_SOURCE_IMAGES==='true'},{headers:{'Cache-Control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/run'){
      if(!env.ADMIN_KEY||request.headers.get('Authorization')!=='Bearer '+env.ADMIN_KEY)return new Response('Unauthorized',{status:401});
      try{return Response.json(await runCycle(env));}
      catch(e){console.error('Manual run failed:',String(e?.message||e).slice(0,140));return Response.json({error:'Run failed; check Worker logs'},{status:500});}
    }
    return new Response('Not found',{status:404});
  }
};
