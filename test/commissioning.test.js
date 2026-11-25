import test from 'node:test';
import assert from 'node:assert/strict';
import {commissionOnce,commissioningStatus} from '../src/commissioning.js';
import worker from '../src/index.js';

const item={source:'Gematsu',title:'Doom gameplay trailer released',description:'A new gameplay trailer for Doom was released.',url:'https://www.gematsu.com/2026/11/doom-trailer',publishedAt:Date.now(),image:'https://www.gematsu.com/images/doom.png'};
function database(){
 let record=null;const posts=new Map();
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
       if(!record){record={status:'checking',result_json:null};changes=1;}
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
 writePost:async(a,e)=>{calls.ai++;assert.equal(e.AI_MODEL,'gemma-test');assert.equal(e.AI_BACKUP_MODEL,'gemma-test');return {headline:'Doom',body:'Новый трейлер игры.',engine:'gemma-test'};},
 sendPublisherPhoto:async()=>{calls.send++;return 123;}};
 return {env,deps,calls};
}
test('commissioning runs backup only, requires original image and persists successful delivery once',async()=>{
 const {env,deps,calls}=setup();
 const r=await commissionOnce(env,deps);
 assert.equal(r.status,'sent');assert.equal(r.messageId,123);assert.equal(r.backupVerified,true);
 assert.equal((await commissioningStatus(env)).status,'sent');
 assert.equal((await commissionOnce(env,deps)).messageId,123);
 assert.deepEqual(calls,{ai:1,send:1});assert.equal(env.DB.posts.get(item.url).status,'sent');
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
