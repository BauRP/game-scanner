import {fetchNews} from './news.js';
import {assessArticle} from './editorial.js';
import {writePost} from './ai.js';
import {findArticleImage,trustedImageUrl} from './images.js';

const KEY='gpt-oss-gemma-images-preview-20261125';
const CREATE="CREATE TABLE IF NOT EXISTS ai_previews (preview_key TEXT PRIMARY KEY, status TEXT NOT NULL, result_json TEXT, recorded_at TEXT NOT NULL)";
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function previewStatus(env){
  if(!env.DB)return {status:'missing_database'};
  try{
    const row=await env.DB.prepare('SELECT status,result_json FROM ai_previews WHERE preview_key = ?').bind(KEY).first();
    if(!row)return {status:'ready'};
    if(row.status!=='ready_to_review'||!row.result_json)return {status:row.status};
    const preview=JSON.parse(row.result_json);
    // Sanitize older saved previews too; otherwise the old bad image URL persists.
    if(preview.imageUrl&&!trustedImageUrl(preview.imageUrl,{source:preview.source,url:preview.url})){
      preview.imageUrl=null;
      preview.imageMode='game-scanner-cover';
    }
    return {status:row.status,preview};
  }catch{return {status:'ready'};}
}
export async function createAiPreview(env,deps={}){
  if(!env.DB||!env.AI)return json({status:'missing_configuration',message:'Не подключены база данных D1 или Workers AI.'},503);
  await env.DB.prepare(CREATE).run();
  const claim=await env.DB.prepare("INSERT OR IGNORE INTO ai_previews (preview_key,status,recorded_at) VALUES (?, 'working', ?)")
    .bind(KEY,new Date().toISOString()).run();
  if(Number(claim?.meta?.changes||0)!==1)return json(await previewStatus(env));
  try{
    const {articles}=await (deps.fetchNews||fetchNews)(deps.fetchFn||fetch,deps.now||Date.now(),72);
    const picked=articles.map(article=>({article,editorial:assessArticle(article)})).find(x=>x.editorial.eligible);
    if(!picked)throw new Error('No suitable fresh article in current feeds');
    const draft=await (deps.writePost||writePost)(picked.article,env,deps.fetchFn||fetch,picked.editorial);
    const image=env.USE_SOURCE_IMAGES==='true'?await findArticleImage(picked.article,deps.fetchFn||fetch):null;
    const preview={imageMode:image?'publisher':'game-scanner-cover',imageUrl:image?.url||null,category:picked.editorial.category,source:picked.article.source,originalTitle:picked.article.title,url:picked.article.url,headline:draft.headline,body:draft.body,model:draft.engine,notice:'Это черновик для проверки. В Telegram ничего не отправлялось.'};
    await env.DB.prepare("UPDATE ai_previews SET status='ready_to_review',result_json=? WHERE preview_key=?")
      .bind(JSON.stringify(preview),KEY).run();
    return json({status:'ready_to_review',preview});
  }catch(e){
    await env.DB.prepare("UPDATE ai_previews SET status='failed' WHERE preview_key=?").bind(KEY).run();
    console.error('AI preview failed:',String(e?.message||e).slice(0,160));
    return json({status:'failed',message:'Не удалось получить проверенный черновик. Автопубликация остаётся выключенной.'},503);
  }
}
export async function refreshPreviewImage(env,deps={}){
  if(!env.DB)return json({status:'missing_database'},503);
  try{
    const row=await env.DB.prepare('SELECT status,result_json FROM ai_previews WHERE preview_key = ?').bind(KEY).first();
    if(row?.status!=='ready_to_review'||!row.result_json)return json({status:'no_saved_preview'},404);
    const preview=JSON.parse(row.result_json);
    // No AI invocation, no Telegram call. This only rechecks the preview image.
    const image=env.USE_SOURCE_IMAGES==='true'?await findArticleImage({
      url:preview.url,source:preview.source,image:null
    },deps.fetchFn||fetch):null;
    preview.imageUrl=image?.url||null;
    preview.imageMode=image?'publisher':'game-scanner-cover';
    await env.DB.prepare('UPDATE ai_previews SET result_json = ? WHERE preview_key = ? AND status = ?')
      .bind(JSON.stringify(preview),KEY,'ready_to_review').run();
    return json({status:'ready_to_review',preview});
  }catch(e){
    console.error('Image recheck failed:',String(e?.message||e).slice(0,150));
    return json({status:'image_recheck_failed'},503);
  }
}

export const previewHtml='<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game Scanner — ИИ</title><body style="font:18px system-ui;max-width:650px;margin:65px auto;padding:20px"><h2>🎮 Game Scanner: проверка GPT-OSS 20B</h2><p>Программа возьмёт одну свежую новость, выберет изображение и попросит GPT-OSS 20B или резервную Gemma составить текст на русском. <b>В Telegram ничего не публикуется.</b></p><form method="post" action="/ai-preview"><button style="font:inherit;padding:14px 20px;cursor:pointer">Проверить ИИ на одной новости</button></form><p><a href="/ai-preview-status">Посмотреть сохранённый результат</a></p><form method="post" action="/ai-preview-image"><button style="font:inherit;padding:14px 20px;cursor:pointer">Повторно проверить картинку (без запуска ИИ)</button></form></body></html>';