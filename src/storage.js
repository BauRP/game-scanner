export async function initialize(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS posts (url TEXT PRIMARY KEY, day_key TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, telegram_message_id INTEGER)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_posts_day_status ON posts(day_key,status)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_posts_created_status ON posts(created_at,status)").run();
}
export function dayKey(now,offsetHours=5){return new Date(now+offsetHours*3600000).toISOString().slice(0,10);}
export async function publishedCount(db,day){
  const start=day+'T00:00:00.000Z';
  const end=new Date(Date.parse(start)+86400000).toISOString();
  // Read actual timestamps so legacy Kazakhstan day keys cannot bypass the UTC limit.
  const row=await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE created_at >= ? AND created_at < ? AND status = 'sent'").bind(start,end).first();
  return Number(row?.count||0);
}
export async function alreadyAttempted(db,url){
  return Boolean(await db.prepare("SELECT url FROM posts WHERE url = ? LIMIT 1").bind(url).first());
}
export async function claim(db,item,day,now){
  const r=await db.prepare("INSERT OR IGNORE INTO posts (url,day_key,status,title,created_at) VALUES (?,?,'processing',?,?)")
    .bind(item.url,day,item.title,new Date(now).toISOString()).run();
  return Number(r?.meta?.changes||0)===1;
}
export async function markSent(db,url,messageId){
  await db.prepare("UPDATE posts SET status = 'sent',telegram_message_id = ? WHERE url = ? AND status = 'processing'").bind(messageId||null,url).run();
}
export async function releaseClaim(db,url){
  // Only release BEFORE Telegram delivery is attempted.
  await db.prepare("DELETE FROM posts WHERE url = ? AND status = 'processing'").bind(url).run();
}
export async function markFailed(db,url){
  // Keep failed claim: retries after an ambiguous Telegram delivery can duplicate posts.
  await db.prepare("UPDATE posts SET status = 'failed' WHERE url = ? AND status = 'processing'").bind(url).run();
}

export const hourKey=now=>new Date(now).toISOString().slice(0,13);
export async function reserveHour(db,now){
  await db.prepare("CREATE TABLE IF NOT EXISTS publication_hours (hour_key TEXT PRIMARY KEY, created_at TEXT NOT NULL)").run();
  const key=hourKey(now);
  // A single immutable reservation prevents duplicate cron/manual delivery, including ambiguous failures.
  const result=await db.prepare("INSERT OR IGNORE INTO publication_hours(hour_key,created_at) VALUES (?,?)").bind(key,new Date(now).toISOString()).run();
  return Number(result?.meta?.changes||0)===1;
}
export function titleKey(title){
  const value=String(title||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  return value.length>=20&&value.split(' ').length>=4?value:'';
}
export async function recentTitleKeys(db,now){
  const result=await db.prepare("SELECT title FROM posts WHERE created_at >= ? AND status IN ('sent','processing','failed') ORDER BY created_at DESC LIMIT 100").bind(new Date(now-72*3600000).toISOString()).all();
  return new Set((result.results||[]).map(r=>titleKey(r.title)).filter(Boolean));
}

export async function recordCycle(db,now,result){
 if(!db)return;
 try{
 await db.prepare("CREATE TABLE IF NOT EXISTS cycle_history (hour_key TEXT PRIMARY KEY, recorded_at TEXT NOT NULL, result_json TEXT NOT NULL)").run();
 const data={status:String(result.status||'unknown'),...(result.source?{source:result.source}:{}),...(result.category?{category:result.category}:{}),...(result.imageMode?{imageMode:result.imageMode}:{}),...(result.engine?{engine:result.engine}:{}),...(Number.isInteger(result.messageId)?{messageId:result.messageId}:{}),...(Number.isInteger(result.failedFeeds)?{failedFeeds:result.failedFeeds}:{})};
 await db.prepare("INSERT INTO cycle_history(hour_key,recorded_at,result_json) VALUES (?,?,?) ON CONFLICT(hour_key) DO UPDATE SET recorded_at=excluded.recorded_at,result_json=excluded.result_json WHERE json_extract(cycle_history.result_json,'$.status')!='sent' AND json_extract(excluded.result_json,'$.status')!='hour_already_reserved'").bind(hourKey(now),new Date().toISOString(),JSON.stringify(data)).run();
 }catch{console.warn('Cycle history unavailable');}
}
export async function cycleHistory(db){
 if(!db)return {available:false};
 try{
 const row=await db.prepare("SELECT recorded_at,result_json FROM cycle_history ORDER BY hour_key DESC LIMIT 1").first();
 const sent=await db.prepare("SELECT created_at,telegram_message_id FROM posts WHERE status='sent' ORDER BY created_at DESC LIMIT 1").first();
 return {available:true,lastCycle:row?{recordedAt:row.recorded_at,...JSON.parse(row.result_json)}:null,lastPublication:sent?{createdAt:sent.created_at,messageId:sent.telegram_message_id}:null};
 }catch{return {available:false};}
}

export async function releaseHour(db,now){
 // Only called on an explicit pre-Telegram failure. Never release an ambiguous delivery.
 await db.prepare("DELETE FROM publication_hours WHERE hour_key=?").bind(hourKey(now)).run();
}
const STOP=new Set(['the','and','for','with','from','this','that','its','new','game','games','on','in','of','to','a','an','is','at','by']);
export function prepareTitleIndex(previous){
 const words=x=>new Set(x.split(' ').filter(w=>w.length>2&&!STOP.has(w)));
 const numbers=x=>(x.match(/\d+(?:[.,]\d+)?/g)||[]).join(',');
 return [...previous].map(key=>({words:words(key),numbers:numbers(key)})).filter(x=>x.words.size>=4);
}
export function isSimilarTitle(title,previous){
 const key=titleKey(title);if(!key)return false;
 const words=x=>new Set(x.split(' ').filter(w=>w.length>2&&!STOP.has(w)));
 const a=words(key);if(a.size<4)return false;
 const numbers=x=>(x.match(/\d+(?:[.,]\d+)?/g)||[]).join(',');
 const index=Array.isArray(previous)?previous:prepareTitleIndex(previous);
 const num=numbers(key);
 for(const other of index){
   if(num!==other.numbers)continue;
   const b=other.words;
   const shared=[...a].filter(x=>b.has(x)).length;
   if(shared>=4&&shared/(a.size+b.size-shared)>=0.84)return true;
 }
 return false;
}
export async function recentCategories(db,now){
 try{
 const r=await db.prepare("SELECT result_json FROM cycle_history WHERE hour_key>=? ORDER BY hour_key DESC LIMIT 6").bind(hourKey(now-6*3600000)).all();
 return (r.results||[]).map(x=>JSON.parse(x.result_json)).filter(x=>x.status==='sent'&&x.category).map(x=>x.category);
 }catch{return [];}
}
