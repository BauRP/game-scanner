import {SOURCES} from './sources.js';
const CREATE="CREATE TABLE IF NOT EXISTS source_quality (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)";
export async function readQuality(db){
 if(!db)return {};
 try{await db.prepare(CREATE).run();const row=await db.prepare('SELECT data FROM source_quality WHERE id=1').first();return JSON.parse(row?.data||'{}');}catch{return {};}
}
export function combineQuality(previous={},feeds=[],checks=[]){
 const result={...previous};
 for(const {source,ok,articles,withImage,reason} of feeds){
   const v=result[source]={...(result[source]||{})};
   v.lastFeedOk=Boolean(ok);v.lastFeedCheckAt=new Date().toISOString();
   v.consecutiveFailures=ok?0:(v.consecutiveFailures||0)+1;
   // Expose safe failure categories, never raw URLs or network exception contents.
   v.lastFeedError=ok?null:/^HTTP_\d{3}$|^(?:redirect_loop|feed_redirect_unavailable|invalid_feed_root|incomplete_feed_prefix)$/.test(reason||'')?reason:'network_or_parse_error';
   v.feedChecks=(v.feedChecks||0)+1;v.feedOk=(v.feedOk||0)+Number(ok);
   v.articles=(v.articles||0)+(Number.isFinite(articles)?articles:0);v.withImage=(v.withImage||0)+(Number.isFinite(withImage)?withImage:0);
 }
 for(const {source,found,accepted} of checks){
   const v=result[source]={...(result[source]||{})};
   if(typeof found==='boolean'){v.photoChecks=(v.photoChecks||0)+1;v.photoFound=(v.photoFound||0)+Number(found);}
   if(typeof accepted==='boolean'){v.uploadChecks=(v.uploadChecks||0)+1;v.uploadOk=(v.uploadOk||0)+Number(accepted);}
 }
 return result;
}
export function qualityBonus(v){
 if(!v)return 0;
 const feedPenalty=v.feedChecks>=3?Math.round((v.feedOk/v.feedChecks-1)*4):0;
 if(!v.photoChecks||v.photoChecks<3)return feedPenalty;
 const rate=(v.photoFound+2)/(v.photoChecks+4);
 const upload=v.uploadChecks>=3?(v.uploadOk+2)/(v.uploadChecks+4):0.5;
 return feedPenalty+Math.round((rate-0.5)*12+(upload-0.5)*6);
}
export async function saveQuality(db,feeds,checks){
 if(!db||(!feeds.length&&!checks.length))return;
 try{
   const previous=await readQuality(db);
   const next=combineQuality(previous,feeds,checks);
   await db.prepare('INSERT INTO source_quality(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(JSON.stringify(next)).run();
 }catch{console.warn('Game Scanner source quality storage unavailable');}
}
export async function qualityStatus(db){
 const data=await readQuality(db);
 return SOURCES.map(s=>({source:s.name,priority:s.priority||0,...(data[s.name]||{}),bonus:qualityBonus(data[s.name])}));
}
