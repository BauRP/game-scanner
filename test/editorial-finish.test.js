import test from 'node:test';
import assert from 'node:assert/strict';
import {assessArticle} from '../src/editorial.js';
import {verifyDraft,EditorialSkip} from '../src/ai.js';
import {photoCandidates} from '../src/photo-selection.js';
const a=(title,description='')=>({title,description,url:'https://www.gematsu.com/story',source:'Gematsu',publishedAt:Date.now()});
test('claim for free during a free weekend does not mean ownership',()=>{
 assert.equal(assessArticle(a('Doom free weekend','Claim for free during the weekend.')).accessType,'trial');
});
test('last chance offer is not rejected because an unrelated event ended',()=>{
 assert.equal(assessArticle(a('Doom free to keep last chance','The tournament ended. Claim the game for free.')).eligible,true);
 assert.equal(assessArticle(a('Doom free to keep last chance','The giveaway has already expired.')).eligible,false);
});
test('remaster cannot become remake and unrelated percentage cannot become discount',()=>{
 assert.throws(()=>verifyDraft({headline:'Ремейк Doom',body:'Представлена новая версия игры.'},a('Doom remastered announced')),EditorialSkip);
 assert.throws(()=>verifyDraft({headline:'Скидка на Doom',body:'Игра подешевела на 20 процентов.'},a('Doom sale','50% off, now 20 dollars.')),EditorialSkip);
});
test('duplicate URLs do not consume multiple photo lookups',async()=>{
 const item=a('New gameplay trailer announced');let calls=0;
 const result=[];for await(const v of photoCandidates([item,item],{findImage:async()=>{calls++;return null;}}))result.push(v);
 assert.equal(calls,1);assert.equal(result.length,1);
});
