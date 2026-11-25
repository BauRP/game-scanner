export async function initialize(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS posts (url TEXT PRIMARY KEY, day_key TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, telegram_message_id INTEGER)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_posts_day_status ON posts(day_key,status)").run();
}
export function dayKey(now,offsetHours=5){return new Date(now+offsetHours*3600000).toISOString().slice(0,10);}
export async function publishedCount(db,day){
  const row=await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE day_key = ? AND status = 'sent'").bind(day).first();
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
export async function markFailed(db,url){
  // Keep failed claim: retries after an ambiguous Telegram delivery can duplicate posts.
  await db.prepare("UPDATE posts SET status = 'failed' WHERE url = ? AND status = 'processing'").bind(url).run();
}
