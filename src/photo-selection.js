import {findArticleImage} from './images.js';
import {assessArticle} from './editorial.js';
import {rankNews} from './news.js';
import {qualityBonus} from './source-quality.js';

// A bounded search across several stories before falling back to the branded cover.
export async function* photoCandidates(articles,{fetchFn=fetch,findImage=findArticleImage,wasAttempted=async()=>false,useImages=true,quality={},checks=[],recentCategories=[],maxStories=5,maxLookups=12,maxRequests=10}={}){
 const ranked=rankNews(articles,qualityBonus,quality);
 const assessments=new Map();
 const assess=a=>{if(!assessments.has(a))assessments.set(a,assessArticle(a));return assessments.get(a);};
 // Soft diversity preference only; no eligible category is blocked.
 const recent=recentCategories.slice(0,3);
 if(recent.length>=2&&recent[0]===recent[1]){
   const penalty=x=>{const e=assess(x);return !e.eligible?2:Number(e.category===recent[0]&&e.accessType!=='giveaway');};
   const leading=ranked.slice(0,8).map(a=>({a,p:penalty(a)})).sort((a,b)=>a.p-b.p).map(x=>x.a);
   ranked.splice(0,leading.length,...leading);
 }
 let requests=0,lookups=0,probes=0;const fallbacks=[],seenUrls=new Set();
 const boundedFetch=(...args)=>{
   if(requests>=maxRequests)throw Error('Photo search budget reached');
   requests++;return fetchFn(...args);
 };
 for(const article of ranked){
   const editorial=assess(article);
   if(!editorial.eligible||seenUrls.has(article.url))continue;
   seenUrls.add(article.url);
   if(lookups++>=maxLookups)break;
   if(await wasAttempted(article.url))continue;
   if(!useImages){yield {article,editorial,image:null};continue;}
   if(probes>=maxStories||requests>=maxRequests)break;
   probes++;
   let limited=false,image=null;
   const probeFetch=(...args)=>{if(requests>=maxRequests)limited=true;return boundedFetch(...args);};
   try{image=await findImage(article,probeFetch);}catch{/* An unavailable image is not a failed publication. */}
   const check={source:article.source,...(!limited||image?{found:Boolean(image)}:{})};
   checks.push(check);
   if(image){
     // Reuse the same search budget after an explicit Telegram image rejection.
     // Never search again after ambiguous delivery.
     let alternativeTried=false;
     const findAlternative=async()=>{
       if(alternativeTried||requests>=maxRequests)return null;
       alternativeTried=true;
       try{return await findImage(article,probeFetch,[image.url]);}catch{return null;}
     };
     yield {article,editorial,image,check,findAlternative};
   }
   else if(fallbacks.length<2)fallbacks.push({article,editorial,image:null});
 }
 for(const fallback of fallbacks)yield fallback;
}
