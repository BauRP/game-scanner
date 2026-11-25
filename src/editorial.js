// Editorial policy is deterministic and separate from the language model.
// The model is a Russian-language editor, not a source of facts.
export const CATEGORIES = Object.freeze([
  'Бесплатные качественные игры',
  'Главные игровые новости',
  'Новые игры и релизы',
  'Анонсы и трейлеры',
  'Крупные обновления',
  'Большие скидки и распродажи',
  'Игровое железо и производительность',
  'Рекорды и популярность игр',
  'Новости популярных игровых серий',
  'ИИ в видеоиграх',
  'Экранизации игр',
  'Крупный киберспорт',
  'Демо и открытые тестирования',
  'Серьёзные проблемы и исправления',
  'Подтверждённые утечки и слухи',
  'Громкие события в игровых и технологических компаниях'
]);
const has=(s,re)=>re.test(s);
const GIVEAWAY=/(?:\b(?:free to keep|free game(?:s)?|giveaway|100% off|claim for free|free for a limited time|free on (?:epic|steam|gog))\b|бесплатн(?:ая|ые|о|ую) (?:игр|раздач))/i;
const PERMANENT_FREE=/\b(free[- ]to[- ]play|f2p|always free|permanently free|free demo|free trial|weekend trial|free weekend)\b/i;
const QUALITY_SIGNAL=/\b(aaa|aa game|award[- ]winning|critically acclaimed|highly rated|top rated|hit game|blockbuster|best[- ]selling|major release|overwhelmingly positive|very positive|90% positive)\b|\b(gta|grand theft auto|red dead redemption|cyberpunk|the witcher|doom|elden ring|baldur.s gate|resident evil|civilization|assassin.s creed|forza|minecraft|stardew valley|hollow knight|god of war|mass effect)\b/i;
const RUMOR=/\b(rumou?r|leak(?:ed)?|reportedly|allegedly|unconfirmed|unverified|insider|speculation|might|could|слух|утечк)\b/i;

export function assessArticle(article){
  const title=String(article?.title||'');
  const body=String(article?.description||'');
  const combined=(title+' '+body).trim();
  if(title.length<9||!article?.url||!article?.source)return {eligible:false,reason:'missing_source'};
  if(has(title,/\b(sponsored|advertorial|opinion|rumor roundup|roundup of deals|best cheap games)\b/i))return {eligible:false,reason:'promotional_or_opinion'};
  if(has(combined,GIVEAWAY)){
    if(has(combined,PERMANENT_FREE))return {eligible:false,category:CATEGORIES[0],reason:'not_a_paid_game_giveaway'};
    if(!has(combined,QUALITY_SIGNAL))return {eligible:false,category:CATEGORIES[0],reason:'giveaway_quality_not_verified'};
    return {eligible:true,category:CATEGORIES[0],rumor:false};
  }
  let c=1;
  if(has(combined,/\b(ceo|chief executive|resign(?:ed|ation)?|fired|rehir(?:ed|ing)|reinstat(?:ed|ement)|layoffs?|laying off|studio closure|studio shuts|acquisition|acquired|merger|executive|board of directors)\b/i))c=15;
  else if(has(combined,/\b(major outage|servers? down|security breach|critical bug|gamebreaking|shutdown|delisted|vulnerability)\b/i))c=13;
  else if(has(combined,/\b(major update|season update|new season|patch notes|expansion|dlc|update brings)\b/i))c=4;
  else if(has(combined,/\b(open beta|closed beta|playtest|demo available|steam next fest|free demo)\b/i))c=12;
  else if(has(combined,/\b(discount|steam sale|epic sale|50% off|75% off|sale begins|price drop)\b/i))c=5;
  else if(has(combined,/\b(nvidia|amd|radeon|geforce|intel arc|gpu|graphics card|dlss|fsr|frame generation|fps boost)\b/i))c=6;
  else if(has(combined,/\b(record player count|concurrent players|sales record|best[- ]selling|player record|steam charts)\b/i))c=7;
  else if(has(combined,/\b(esports?|tournament|world championship|grand final)\b/i))c=11;
  else if(has(combined,/\b(movie adaptation|tv adaptation|netflix series|hbo series|live[- ]action adaptation)\b/i))c=10;
  else if(has(combined,/\b(ai npc|generative ai|ai[- ]powered game|artificial intelligence in games)\b/i))c=9;
  else if(has(combined,/\b(release date|launches on|launch date|out now|launches today|available now|released today)\b/i))c=2;
  else if(has(combined,/\b(announc(?:es|ed|ement)?|unveil(?:s|ed)?|reveal(?:s|ed)?|debut trailer|new trailer|gameplay trailer)\b/i))c=3;
  else if(has(combined,/\b(gta|counter[- ]strike|cs2|dota 2|minecraft|pokemon|fortnite|call of duty|roblox|elden ring|assassin.s creed)\b/i))c=8;
  if(has(combined,RUMOR))c=14;
  return {eligible:true,category:CATEGORIES[c],rumor:has(combined,RUMOR)};
}