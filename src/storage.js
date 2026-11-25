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
