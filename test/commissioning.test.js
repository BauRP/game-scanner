import test from 'node:test';
import assert from 'node:assert/strict';
import {commissionOnce,commissioningStatus} from '../src/commissioning.js';
import worker,{runCycle} from '../src/index.js';

const item={source:'Gematsu',title:'Doom gameplay trailer released',description:'A new gameplay trailer for Doom was released.',url:'https://www.gematsu.com/2026/11/doom-trailer',publishedAt:Date.now(),image:'https://www.gematsu.com/images/doom.png'};
function database(initial=null){
 let record=initial;const posts=new Map();
 return {posts,prepare(sql){
   let args=[];
   return {bind(...a){args=a;return this;},async first(){
     if(sql.includes('FROM commissioning'))return record;
     if(sql.includes('FROM posts WHERE url'))return posts.get(args[0])||null;
     if(sql.includes('COUNT(*)'))return {count:0};
     throw Error('Unexpected query: '+sql);
   },async run(){
     let changes=0;
     if(sql.startsWith('CREATE '))return {meta:{changes}};
     if(sql.startsWith('INSERT OR IGNORE INTO commissioning')){
       if(!record){record={status:'checking',result_json:args[1]||null};changes=1;}
      }else if(sql.startsWith("UPDATE commissioning SET status='checking'")){
       if(record?.status===args[2]&&record.result_json===args[3]){
         record={status:'checking',result_json:args[0]};changes=1;
       }
     }else if(sql.startsWith('UPDATE commissioning')){
       record={status:args[0],result_json:args[1]};changes=1;
     }else if(sql.startsWith('INSERT OR IGNORE INTO posts')){
       if(!posts.has(args[0])){posts.set(args[0],{status:'processing'});changes=1;}
     }else if(sql.startsWith('UPDATE posts SET status')){
       const url=args.at(-1);posts.set(url,{status:sql.includes("'sent'")?'sent':'failed'});changes=1;
     }else throw Error('Unexpected query: '+sql);
     return {meta:{changes}};
   }};
 }};
}
function setup(){
 const env={DB:database(),AI:{},COMMISSION_ONCE:'true',USE_SOURCE_IMAGES:'true',PUBLISH_ENABLED:'false',TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'@fake',AI_BACKUP_MODEL:'gemma-test',AI_MODEL:'gpt-test'};
 const calls={ai:0,send:0};
 const deps={fetchNews:async()=>({articles:[item]}),findArticleImage:async()=>({url:item.image,method:'rss',bytes:new Uint8Array([1]),mime:'image/png'}),
 writePost:async(a,e)=>{calls.ai++;assert.equal(e.AI_MODEL,e.AI_BACKUP_MODEL);return {headline:'Doom',body:'Новый трейлер игры.',engine:e.AI_MODEL};},
 sendPublisherPhoto:async()=>{calls.send++;return 123;}};
 return {env,deps,calls};
}
test('commissioning verifies both models independently, requires original image and persists successful delivery once',async()=>{
 const {env,deps,calls}=setup();
 const r=await commissionOnce(env,deps);
 assert.equal(r.status,'sent');assert.equal(r.messageId,123);assert.equal(r.backupVerified,true);assert.equal(r.primaryVerified,true);
 assert.equal((await commissioningStatus(env)).status,'sent');
 assert.equal((await commissionOnce(env,deps)).messageId,123);
 assert.deepEqual(calls,{ai:2,send:1});assert.equal(env.DB.posts.get(item.url).status,'sent');
});
test('no original photo means no AI use and no Telegram delivery',async()=>{
 const {env,deps,calls}=setup();deps.findArticleImage=async()=>null;
 assert.equal((await commissionOnce(env,deps)).status,'no_original_image');
 assert.deepEqual(calls,{ai:0,send:0});
});
test('Gemma failure does not publish using the primary model',async()=>{
 const {env,deps,calls}=setup();deps.writePost=async()=>{throw Error('AI failure');};
 assert.equal((await commissionOnce(env,deps)).status,'check_failed');assert.equal(calls.send,0);
});
test('ambiguous delivery never retries',async()=>{
 const {env,deps,calls}=setup();deps.sendPublisherPhoto=async()=>{calls.send++;throw Error('timeout');};
 assert.equal((await commissionOnce(env,deps)).status,'delivery_unconfirmed');
 assert.equal((await commissionOnce(env,deps)).status,'delivery_unconfirmed');assert.equal(calls.send,1);
});
test('commissioning is disabled when normal publishing is live',async()=>{
 const {env,deps,calls}=setup();env.PUBLISH_ENABLED='true';
 assert.equal((await commissionOnce(env,deps)).status,'already_live');assert.equal(calls.send,0);
});
test('manual commissioning endpoint rejects unauthenticated requests',async()=>{
 const {env}=setup();env.ADMIN_KEY='secret';
 const r=await worker.fetch(new Request('https://example.com/commission-once',{method:'POST'}),env);
 assert.equal(r.status,401);
});

test('normal publishing stays blocked until real commissioning delivery is recorded',async()=>{
 const {env,deps,calls}=setup();env.PUBLISH_ENABLED='true';
 assert.equal((await runCycle(env,deps)).status,'commissioning_required');
 assert.equal(calls.send,0);
});
test('concurrent commissioning calls cannot send two news posts',async()=>{
 const {env,deps,calls}=setup();
 const results=await Promise.all([commissionOnce(env,deps),commissionOnce(env,deps)]);
 assert.ok(results.some(r=>r.status==='sent'));assert.equal(calls.send,1);
});
test('commissioning searches another eligible story if the first has no photo',async()=>{
 const {env,deps,calls}=setup();const second={...item,url:item.url+'-second'};
 deps.fetchNews=async()=>({articles:[item,second]});
 const original=deps.findArticleImage;deps.findArticleImage=async a=>a.url===item.url?null:original(a);
 const r=await commissionOnce(env,deps);
 assert.equal(r.status,'sent');assert.equal(r.articleUrl,second.url);assert.equal(calls.send,1);
});

test('temporary image failure can recover on the next attempt',async()=>{
 const {env,deps,calls}=setup();const original=deps.findArticleImage;
 deps.findArticleImage=async()=>null;
 const first=await commissionOnce(env,deps);
 assert.equal(first.status,'no_original_image');assert.equal(first.attempt,1);assert.equal(first.retryAvailable,true);
 deps.findArticleImage=original;
 const recovered=await commissionOnce(env,deps);
 assert.equal(recovered.status,'sent');assert.equal(recovered.attempt,2);
 assert.equal((await commissionOnce(env,deps)).status,'sent');assert.equal(calls.send,1);
});
test('temporary Gemma failure has a strict three-attempt limit',async()=>{
 const {env,deps,calls}=setup();deps.writePost=async()=>{calls.ai++;throw Error('quota');};
 for(let n=1;n<=3;n++){
  const r=await commissionOnce(env,deps);assert.equal(r.status,'check_failed');assert.equal(r.attempt,n);assert.equal(r.retryAvailable,n<3);
 }
 const fourth=await commissionOnce(env,deps);assert.equal(fourth.attempt,3);assert.deepEqual(calls,{ai:6,send:0});
});
test('concurrent retries acquire only one atomic lock',async()=>{
 const {env,deps,calls}=setup();const original=deps.findArticleImage;
 deps.findArticleImage=async()=>null;await commissionOnce(env,deps);deps.findArticleImage=original;
 const results=await Promise.all([commissionOnce(env,deps),commissionOnce(env,deps)]);
 assert.ok(results.some(r=>r.status==='sent'));assert.equal(calls.send,1);assert.equal(calls.ai,2);
});

test('Gemma failure preserves successful primary diagnostic but sends nothing',async()=>{
 const {env,deps,calls}=setup();
 const original=deps.writePost;deps.writePost=async(a,e)=>{if(e.AI_MODEL==='gemma-test')throw Object.assign(Error('quota'),{code:3036});return original(a,e);};
 const r=await commissionOnce(env,deps);
 assert.equal(r.status,'check_failed');assert.equal(r.primaryVerified,true);assert.equal(r.backupVerified,false);
 assert.equal(r.backup.error.reason,'daily_quota');assert.equal(calls.send,0);
});
test('primary failure still checks Gemma independently and sends nothing',async()=>{
 const {env,deps,calls}=setup();
 const original=deps.writePost;deps.writePost=async(a,e)=>{if(e.AI_MODEL==='gpt-test')throw Error('capacity');return original(a,e);};
 const r=await commissionOnce(env,deps);
 assert.equal(r.primaryVerified,false);assert.equal(r.backupVerified,true);assert.equal(calls.send,0);
});
test('old failed three-attempt commissioning resumes after diagnostic upgrade',async()=>{
 const {env,deps,calls}=setup();env.DB=database({status:'check_failed',result_json:JSON.stringify({attempt:3,backupVerified:false})});
 const r=await commissionOnce(env,deps);
 assert.equal(r.status,'sent');assert.equal(r.attempt,1);assert.equal(r.diagnosticsVersion,2);assert.equal(calls.send,1);
});
test('old ambiguous delivery is never reopened by diagnostics upgrade',async()=>{
 const {env,deps,calls}=setup();env.DB=database({status:'delivery_unconfirmed',result_json:JSON.stringify({attempt:3})});
 assert.equal((await commissionOnce(env,deps)).status,'delivery_unconfirmed');assert.equal(calls.send,0);assert.equal(calls.ai,0);
});
test('temporary minute trigger cannot publish after normal publishing is enabled',async()=>{
 const {env}=setup();env.PUBLISH_ENABLED='true';
 await worker.scheduled({cron:'*/1 * * * *'},env,{waitUntil(){throw Error('unexpected publication');}});
});
