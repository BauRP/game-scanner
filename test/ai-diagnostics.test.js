import test from 'node:test';
import assert from 'node:assert/strict';
import {writeWithModel,writePost,PRIMARY_MODEL,BACKUP_MODEL,modelError} from '../src/ai.js';
const item={title:'Doom gameplay trailer released',description:'A new gameplay trailer for Doom was released.',source:'Gematsu'};
const draft={publish:true,headline:'Doom',body:'Представлен новый трейлер игры.'};
test('Gemma uses model-specific options and reads completion content',async()=>{
 const r=await writeWithModel(item,{AI:{run:async(model,options)=>{
 assert.equal(model,BACKUP_MODEL);assert.equal(options.max_completion_tokens,2048);
 assert.equal(options.chat_template_kwargs.enable_thinking,false);
 return {choices:[{message:{content:JSON.stringify(draft)},finish_reason:'stop'}]};
 }}},BACKUP_MODEL);
 assert.equal(r.engine,BACKUP_MODEL);
});
test('GPT-OSS retains known request settings',async()=>{
 const r=await writeWithModel(item,{AI:{run:async(model,options)=>{
 assert.equal(model,PRIMARY_MODEL);assert.equal(options.reasoning_effort,'low');assert.equal(options.max_tokens,650);
 return {output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(draft)}]}]};
 }}},PRIMARY_MODEL);
 assert.equal(r.engine,PRIMARY_MODEL);
});
test('diagnostics distinguish quota, invalid response and access failure',async()=>{
 assert.equal(modelError(Object.assign(Error('quota'),{code:3036})).reason,'daily_quota');
 assert.equal(modelError(Object.assign(Error('denied'),{code:5035})).reason,'paid_plan_required');
 await assert.rejects(writeWithModel(item,{AI:{run:async()=>({choices:[{message:{content:''},finish_reason:'length'}]})}},BACKUP_MODEL),e=>e.detail.reason==='output_truncated');
 await assert.rejects(writeWithModel(item,{AI:{run:async()=>({response:'not json'})}},BACKUP_MODEL),e=>e.detail.reason==='invalid_json');
});
test('main failure retains ordinary backup behavior',async()=>{
 const models=[];const r=await writePost(item,{AI:{run:async m=>{models.push(m);if(m===PRIMARY_MODEL)throw Error('capacity');return {response:JSON.stringify(draft)};}}});
 assert.equal(r.engine,BACKUP_MODEL);assert.deepEqual(models,[PRIMARY_MODEL,BACKUP_MODEL]);
});
