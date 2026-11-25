// Game Scanner publishes Russian editorial prose, while official game/brand names remain unchanged.
const RUSSIAN=/[А-Яа-яЁё]/g;
function counts(s){
 const letters=s.match(/\p{L}/gu)||[],ru=s.match(RUSSIAN)||[];
 const words=s.match(/[А-Яа-яЁё]{2,}/g)||[];
 return {letters:letters.length,ru:ru.length,words:words.length};
}
export function russianDraftProblem(draft){
 const headline=String(draft?.headline||'').trim(),body=String(draft?.body||'').trim();
 if(!headline||!body)return 'empty_translation';
 const h=counts(headline),b=counts(body);
 if(h.words<1)return 'headline_not_russian';
 if(b.words<2||b.ru/Math.max(1,b.letters)<0.5)return 'body_not_russian';
 // Reject English sentences embedded in otherwise Russian text. Names and short abbreviations are allowed.
 for(const part of body.split(/[.!?]+(?:\s|$)/)){
   const p=counts(part);
   if(p.letters>=24&&p.ru/Math.max(1,p.letters)<0.35)return 'mixed_language_sentence';
 }
 // Common untranslated English editorial phrases, not official product names.
 if(/\b(?:now available|available for pre[- ]order|can be pre[- ]ordered|orders are limited|shipping is available|expected shipment|release date announced|players will be able to|will be released on)\b/i.test(headline+' '+body))return 'untranslated_phrase';
 return null;
}
export function requireRussianDraft(draft){
 const reason=russianDraftProblem(draft);
 if(reason)throw Object.assign(new Error(reason),{code:'TRANSLATION_REQUIRED'});
 return draft;
}
