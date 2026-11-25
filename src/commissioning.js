import {fetchNews} from './news.js';
import {assessArticle} from './editorial.js';
import {writePost,BACKUP_MODEL} from './ai.js';
import {findArticleImage} from './images.js';
import {sendPublisherPhoto} from './telegram.js';
import {initialize,dayKey,alreadyAttempted,claim,markSent,markFailed} from './storage.js';

const KEY='original-photo-gemma-20261125';
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
  if(Number(lock.meta?.changes||0)!==1)return commissioningStatus(env);
  const save=async(status,result={})=>{
    await db.prepare('UPDATE commissioning SET status=?,result_json=? WHERE test_key=?').bind(status,JSON.stringify(result),KEY).run();
    return {status,...result};
  };
  let claimed=null, gemma=null;
  try{
    await initialize(db);
    const {articles}=await (deps.fetchNews||fetchNews)(fetchFn,now,72);
    const candidates=articles.filter(a=>assessArticle(a).eligible).slice(0,4);
    let picked;
    for(const article of candidates){
      if(await alreadyAttempted(db,article.url))continue;
      const image=await (deps.findArticleImage||findArticleImage)(article,fetchFn);
      if(image){picked={article,image};break;}
    }
    if(!picked)return save('no_original_image');
    const {article,image}=picked;
    // Force only Gemma: the primary model must never mask a backup failure.
    const model=env.AI_BACKUP_MODEL||BACKUP_MODEL;
    const draft=await (deps.writePost||writePost)(article,{...env,AI_MODEL:model,AI_BACKUP_MODEL:model},fetchFn,assessArticle(article));
    if(draft.engine!==model)return save('backup_not_verified');
    gemma={model,backupVerified:true,source:article.source,imageMode:'publisher',imageMethod:image.method};
    const day=dayKey(now,5);
    if(!await claim(db,article,day,now))return save('article_already_claimed',gemma);
    claimed=article.url;
    await save('sending',gemma);
    const id=await (deps.sendPublisherPhoto||sendPublisherPhoto)(draft,article,image,env,fetchFn);
    await markSent(db,article.url,id);
    return save('sent',{...gemma,messageId:id});
  }catch(e){
    // A Telegram timeout may mean delivery already occurred. Never retry.
    if(claimed){try{await markFailed(db,claimed);}catch{}}
    return save(claimed?'delivery_unconfirmed':'check_failed',gemma||{backupVerified:false});
  }
}
