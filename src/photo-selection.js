import {findArticleImage} from './images.js';
import {assessArticle} from './editorial.js';
import {rankNews} from './news.js';
import {qualityBonus} from './source-quality.js';

// A bounded search across several stories before falling back to the branded cover.
export async function* photoCandidates(articles,{fetchFn=fetch,findImage=findArticleImage,wasAttempted=async()=>false,useImages=true,quality={},checks=[],maxStories=5,maxLookups=12,maxRequests=10}={}){
 const ranked=rankNews(articles,qualityBonus,quality);
 let requests=0,lookups=0,probes=0,fallback=null;
 const boundedFetch=(...args)=>{
   if(requests>=maxRequests)throw Error('Photo search budget reached');
   requests++;return fetchFn(...args);
 };
 for(const article of ranked){
   const editorial=assessArticle(article);
   if(!editorial.eligible)continue;
   if(lookups++>=maxLookups)break;
   if(await wasAttempted(article.url))continue;
   if(!useImages){yield {article,editorial,image:null};continue;}
   if(probes++>=maxStories||requests>=maxRequests)break;
   let limited=false,image=null;
   const probeFetch=(...args)=>{if(requests>=maxRequests)limited=true;return boundedFetch(...args);};
   try{image=await findImage(article,probeFetch);}catch{/* An unavailable image is not a failed publication. */}
   const check={source:article.source,...(!limited||image?{found:Boolean(image)}:{})};
   checks.push(check);
   if(image)yield {article,editorial,image,check};
   else if(!fallback)fallback={article,editorial,image:null};
 }
 if(fallback)yield fallback;
}
