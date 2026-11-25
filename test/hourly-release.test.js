import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{runCycle} from '../src/index.js';
import {assessArticle,CATEGORIES} from '../src/editorial.js';
import {hourKey,titleKey,publishedCount,dayKey} from '../src/storage.js';
import {writePost,parseDraft,EditorialSkip} from '../src/ai.js';
import {readFileSync} from 'node:fs';

const now=Date.parse('2026-11-26T00:00:00Z');
const story=(title,description='',url='https://www.gematsu.com/story')=>({title,description,url,source:'Gematsu',publishedAt:now});
const item=story('New adventure game launches today','Adventure game with exploration.');
const valid={headline:'Новая игра вышла',body:'В игре доступно исследование мира.',engine:'test'};
function db(){
 const posts=new Map(),hours=new Set();
 return {posts,hours,prepare(sql){
   let args=[];
   return {bind(...a){args=a;return this;},async first(){
     if(sql.includes('COUNT(*)'))return {count:[...posts.values()].filter(p=>p.status==='sent'&&p.created_at>=args[0]&&p.created_at<args[1]).length};
     if(sql.includes('FROM posts WHERE url'))return posts.get(args[0])||null;
     if(sql.includes('FROM source_quality'))return null;
     if(sql.includes('FROM commissioning'))return {status:'sent',result_json:JSON.stringify({primaryVerified:true,backupVerified:true,imageMode:'publisher',messageId:1})};
     throw Error('Unexpected query: '+sql);
   },async all(){
     if(sql.includes('SELECT title FROM posts'))return {results:[...posts.values()].filter(p=>p.created_at>=args[0])};
     throw Error('Unexpected query: '+sql);
   },async run(){
     let changes=0;
     if(sql.startsWith('CREATE '))return {meta:{changes}};
     if(sql.startsWith('INSERT OR IGNORE INTO publication_hours')){
       if(!hours.has(args[0])){hours.add(args[0]);changes=1;}
     }else if(sql.startsWith('INSERT OR IGNORE INTO posts')){
       if(!posts.has(args[0])){posts.set(args[0],{status:'processing',title:args[2],created_at:args[3]});changes=1;}
     }else if(sql.startsWith('UPDATE posts SET status')){
       const p=posts.get(args.at(-1));if(p){p.status=sql.includes("'sent'")?'sent':'failed';changes=1;}
     }else if(sql.startsWith('DELETE FROM publication_hours')){changes=Number(hours.delete(args[0]));}
     else if(sql.startsWith('DELETE FROM posts')){changes=Number(posts.delete(args[0]));}
     else if(sql.startsWith('INSERT INTO source_quality')){changes=1;}
     else throw Error('Unexpected query: '+sql);
     return {meta:{changes}};
   }};
 }};
}
const setup=()=>{
 const env={DB:db(),PUBLISH_ENABLED:'true',COMMISSION_ONCE:'true',MAX_POSTS_PER_DAY:'24',TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@fake',USE_SOURCE_IMAGES:'false'};
 const calls={ai:0,send:0};
 const deps={now,fetchNews:async()=>({articles:[item],errors:[]}),writePost:async()=>{calls.ai++;return valid;},publishPost:async()=>{calls.send++;return 123;}};
 return {env,deps,calls};
};
test('configuration is hourly, enabled, 24 max, and retains commissioning gate',()=>{
 const c=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.deepEqual(c.triggers.crons,['0 * * * *','12 * * * *']);assert.equal(c.vars.MAX_POSTS_PER_DAY,'24');
 assert.equal(c.vars.PUBLISH_ENABLED,'true');assert.equal(c.vars.COMMISSION_ONCE,'true');
});
test('two simultaneous cycles reserve only one publication hour',async()=>{
 const {env,deps,calls}=setup();
 const r=await Promise.all([runCycle(env,deps),runCycle(env,deps)]);
 assert.deepEqual(r.map(x=>x.status).sort(),['hour_already_reserved','sent']);
 assert.equal(calls.send,1);
});
test('hourly mode allows the 24th post, never the 25th in UTC day',async()=>{
 const {env,deps,calls}=setup();
 for(let i=0;i<23;i++)env.DB.posts.set('old'+i,{status:'sent',title:'Archived article '+i,created_at:new Date(now+i*1000).toISOString()});
 assert.equal((await runCycle(env,deps)).status,'sent');
 assert.equal((await runCycle(env,{...deps,now:now+3600000})).status,'daily_limit');
 assert.equal(calls.send,1);
});
test('daily publication count uses UTC timestamps, not legacy Kazakhstan day keys',async()=>{
 const {env}=setup();const d=env.DB;
 d.posts.set('before',{status:'sent',created_at:new Date(now-1).toISOString()});
 d.posts.set('after',{status:'sent',created_at:new Date(now).toISOString(),day_key:'wrong'});
 assert.equal(await publishedCount(d,dayKey(now,0)),1);
 assert.notEqual(hourKey(now-1),hourKey(now));
});
test('same headline on another publisher is skipped within 72 hours',async()=>{
 const {env,deps,calls}=setup();
 assert.equal((await runCycle(env,deps)).status,'sent');
 const duplicate={...item,title:item.title.toUpperCase()+'!',url:'https://www.pcgamer.com/other',source:'PC Gamer'};
 assert.equal(titleKey(duplicate.title),titleKey(item.title));
 assert.equal((await runCycle(env,{...deps,now:now+3600000,fetchNews:async()=>({articles:[duplicate]})})).status,'no_new_articles');
 assert.equal(calls.send,1);
});
test('missing Telegram message ID does not count as a successful delivery',async()=>{
 const {env,deps}=setup();
 assert.equal((await runCycle(env,{...deps,publishPost:async()=>null})).status,'post_failed');
 assert.equal(await publishedCount(env.DB,dayKey(now,0)),0);
 assert.equal((await runCycle(env,deps)).status,'hour_already_reserved');
});
test('old and expired cron events cannot start a new publication',async()=>{
 const {env}=setup();const ctx={waitUntil(){throw Error('unexpected publication');}};
 await worker.scheduled({cron:'0 */3 * * *'},env,ctx);
 await worker.scheduled({cron:'* * * * *'},env,ctx);
 await worker.scheduled({cron:'0 * * * *',scheduledTime:Date.now()-3600000},env,ctx);
});
test('free-to-play launch, paid giveaway, free weekend and demo are separate categories',()=>{
 const cases=[
 ['New free game Nova now available','New free-to-play game.',2],
 ['Doom free to keep on Steam','Claim the paid game for free.',0],
 ['Doom free game weekend','Play for free this weekend. Free weekend.',12],
 ['New free demo available','Try the free demo.',12],
 ['New open beta announced','Join the open beta.',12],
 ['Doom reportedly free to keep soon','Unconfirmed giveaway.',14]
 ];
 for(const [title,description,index] of cases){const r=assessArticle(story(title,description));assert.equal(r.eligible,true,title);assert.equal(r.category,CATEGORIES[index],title);}
});
test('account-wide quota failure does not invoke second model',async()=>{
 let calls=0;
 await assert.rejects(writePost(item,{AI:{run:async()=>{calls++;throw Object.assign(Error('daily free allocation'),{code:3036});}}}),e=>e.diagnostics[0].reason==='daily_quota');
 assert.equal(calls,1);
});
test('oversized game description is rejected instead of truncating mid-sentence',()=>{
 assert.throws(()=>parseDraft({headline:'Игра вышла',body:'Описание игровой механики. '.repeat(25)},{...item,gameDetailsRequired:true}),EditorialSkip);
});
