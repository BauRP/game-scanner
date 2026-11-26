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
   const leading=ranked.slice(0,8);
   leading.sort((a,b)=>{const penalty=x=>!assess(x).eligible?2:Number(assess(x).category===recent[0]&&assess(x).accessType!=='giveaway');return penalty(a)-penalty(b);});
   ranked.splice(0,leading.length,...leading);
 }
 let requests=0,lookups=0,probes=0;const fallbacks=[];
 const boundedFetch=(...args)=>{
   if(requests>=maxRequests)throw Error('Photo search budget reached');
   requests++;return fetchFn(...args);
 };
 for(const article of ranked){
   const editorial=assess(article);
   if(!editorial.eligible)continue;
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
   if(image)yield {article,editorial,image,check};
   else if(fallbacks.length<2)fallbacks.push({article,editorial,image:null});
 }
 for(const fallback of fallbacks)yield fallback;
}
