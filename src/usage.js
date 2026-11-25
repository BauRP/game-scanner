// Rates verified against Cloudflare Workers AI pricing on 2026-11-26.
const RATES={'@cf/openai/gpt-oss-20b':[18182,27273],'@cf/google/gemma-4-26b-a4b-it':[9091,27273]};
export function measureUsage(model,response){
 const usage=response?.usage||response?.result?.usage;
 const input=usage?.prompt_tokens??usage?.input_tokens,output=usage?.completion_tokens??usage?.output_tokens;
 const rates=RATES[model];
 if(!rates||!Number.isInteger(input)||input<0||!Number.isInteger(output)||output<0)return null;
 return {input,output,neurons:(input*rates[0]+output*rates[1])/1000000};
}
const day=()=>new Date().toISOString().slice(0,10);
const CREATE="CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, measured INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, neurons REAL NOT NULL DEFAULT 0, exhausted INTEGER NOT NULL DEFAULT 0)";
export async function recordUsage(db,model,response,exhausted=false){
 if(!db)return;
 const u=measureUsage(model,response);
 try{
 await db.prepare(CREATE).run();
 await db.prepare("INSERT INTO ai_usage(day,calls,measured,input_tokens,output_tokens,neurons,exhausted) VALUES (?,1,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1,measured=measured+excluded.measured,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,neurons=neurons+excluded.neurons,exhausted=MAX(exhausted,excluded.exhausted)").bind(day(),Number(Boolean(u)),u?.input||0,u?.output||0,u?.neurons||0,Number(exhausted)).run();
 }catch{console.warn('AI usage recording unavailable');}
}
export async function usageStatus(db){
 if(!db)return {available:false};
 try{
 await db.prepare(CREATE).run();
 const r=await db.prepare("SELECT calls,measured,input_tokens,output_tokens,neurons,exhausted FROM ai_usage WHERE day=?").bind(day()).first();
 return {available:true,day:day(),calls:r?.calls||0,measured:r?.measured||0,inputTokens:r?.input_tokens||0,outputTokens:r?.output_tokens||0,estimatedNeurons:Math.ceil(r?.neurons||0),quotaExhausted:Boolean(r?.exhausted),complete:Boolean(r&&r.calls===r.measured),accountTotal:false};
 }catch{return {available:false};}
}
