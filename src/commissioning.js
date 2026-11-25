import {fetchNews} from './news.js';
import {assessArticle} from './editorial.js';
import {writePost,BACKUP_MODEL,PRIMARY_MODEL,modelError} from './ai.js';
import {findArticleImage} from './images.js';
import {enrichArticle} from './news.js';
import {sendPublisherPhoto} from './telegram.js';
import {initialize,dayKey,alreadyAttempted,claim,markSent,markFailed} from './storage.js';

const KEY='original-photo-gemma-20261125';
const MAX_ATTEMPTS=3;
const DIAGNOSTICS_VERSION=2;
const RETRYABLE=new Set(['no_original_image','backup_not_verified','check_failed','article_already_claimed']);
const CREATE="CREATE TABLE IF NOT EXISTS commissioning (test_key TEXT PRIMARY KEY,status TEXT NOT NULL, result_json TEXT)";
export async function commissioningStatus(env){
  if(!env.DB)return {status:'missing_database'};
  try{
    const row=await env.DB.prepare('SELECT status,result_json FROM commissioning WHERE test_key=?').bind(KEY).first();
    return row?{status:row.status,...(row.result_json?JSON.parse(row.result_json):{})}:{status:'pending'};
  }catch{return {status:'pending'};}
}
export async function commissionOnce(env,deps={}){
  // Separate from normal publishing; this test can never send a second post.
  if(env.PUBLISH_ENABLED==='true')return {status:'already_live'};
  if(env.COMMISSION_ONCE!=='true'||env.USE_SOURCE_IMAGES!=='true')return {status:'disabled'};
  if(!env.DB||!env.AI||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)return {status:'missing_configuration'};
  const db=env.DB,fetchFn=deps.fetchFn||fetch,now=deps.now??Date.now();
  await db.prepare(CREATE).run();
  const lock=await db.prepare("INSERT OR IGNORE INTO commissioning(test_key,status) VALUES (?,'checking')").bind(KEY).run();
  let attempt=1;
  if(Number(lock.meta?.changes||0)!==1){
    const row=await db.prepare('SELECT status,result_json FROM commissioning WHERE test_key=?').bind(KEY).first();
    if(!row||!RETRYABLE.has(row.status))return commissioningStatus(env);
    let previous;
    try{previous=JSON.parse(row.result_json||'{}');}catch{return commissioningStatus(env);}
    attempt=previous.diagnosticsVersion===DIAGNOSTICS_VERSION?(Number.isInteger(previous.attempt)&&previous.attempt>0?previous.attempt:1)+1:1;
    if(attempt>MAX_ATTEMPTS)return commissioningStatus(env);
    // Atomic compare-and-set: only one worker can resume a pre-delivery failure.
    const retry=await db.prepare("UPDATE commissioning SET status='checking',result_json=? WHERE test_key=? AND status=? AND result_json IS ?")
      .bind(JSON.stringify({attempt,diagnosticsVersion:DIAGNOSTICS_VERSION}),KEY,row.status,row.result_json).run();
    if(Number(retry.meta?.changes||0)!==1)return commissioningStatus(env);
  }
  const save=async(status,result={})=>{
    const data={...result,diagnosticsVersion:DIAGNOSTICS_VERSION,attempt,maxAttempts:MAX_ATTEMPTS,retryAvailable:RETRYABLE.has(status)&&attempt<MAX_ATTEMPTS};
    await db.prepare('UPDATE commissioning SET status=?,result_json=? WHERE test_key=?').bind(status,JSON.stringify(data),KEY).run();
    return {status,...data};
  };
  let claimed=null, gemma=null, diagnostics={};
  try{
    await initialize(db);
    const {articles}=await (deps.fetchNews||fetchNews)(fetchFn,now,72);
    const candidates=articles.filter(a=>assessArticle(a).eligible);
    let checked=0;
    let picked;
    for(const article of candidates){
      if(await alreadyAttempted(db,article.url))continue;
      if(checked++>=4)break;
      const image=await (deps.findArticleImage||findArticleImage)(article,fetchFn);
      if(image){picked={article,image};break;}
    }
    if(!picked)return save('no_original_image');
    const {image}=picked;
    const article=picked.article.feedContext!==undefined?await enrichArticle(picked.article,assessArticle(picked.article),fetchFn):picked.article;
    const primary=env.AI_MODEL||PRIMARY_MODEL, model=env.AI_BACKUP_MODEL||BACKUP_MODEL;
    const editorial=assessArticle(article);
    const check=async(name)=>{
      try{
        const draft=await (deps.writePost||writePost)(article,{...env,AI_MODEL:name,AI_BACKUP_MODEL:name},fetchFn,editorial);
        if(draft.engine!==name)return {verified:false,reason:'wrong_model'};
        return {verified:true,draft};
      }catch(e){return {verified:false,error:e?.diagnostics?.[0]||modelError(e)};}
    };
    const first=await check(primary);
    const second=primary===model?{verified:false,reason:'duplicate_model_configuration'}:await check(model);
    const report=(name,r)=>({model:name,verified:r.verified,...(r.error?{error:r.error}:{}),...(r.reason?{reason:r.reason}:{})});
    diagnostics={primaryVerified:first.verified,backupVerified:second.verified,primary:report(primary,first),backup:report(model,second),imageFound:true,imageMethod:image.method};
    if(!first.verified||!second.verified)return save('check_failed',diagnostics);
    const draft=second.draft;
    gemma={...diagnostics,model,backupVerified:true,source:article.source,imageMode:'publisher',imageMethod:image.method,articleUrl:article.url};
    const day=dayKey(now,5);
    if(!await claim(db,article,day,now))return save('article_already_claimed',gemma);
    claimed=article.url;
    await save('sending',gemma);
    const id=await (deps.sendPublisherPhoto||sendPublisherPhoto)(draft,article,image,env,fetchFn);
    if(!Number.isInteger(id)||id<=0)throw Error('Missing Telegram message ID');
    await markSent(db,article.url,id);
    return save('sent',{...gemma,messageId:id});
  }catch(e){
    // A Telegram timeout may mean delivery already occurred. Never retry.
    if(claimed){try{await markFailed(db,claimed);}catch{}}
    return save(claimed?'delivery_unconfirmed':'check_failed',gemma||{...diagnostics,backupVerified:false,error:modelError(e,'commissioning')});
  }
}
