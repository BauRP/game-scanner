import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFeed,eligible,normalizedUrl,cleanText,rankNews} from '../src/news.js';
import {composePost} from '../src/telegram.js';
import {parseDraft} from '../src/ai.js';
import {dayKey} from '../src/storage.js';
const source={name:'Gematsu',hosts:['gematsu.com','www.gematsu.com']};
const xml='<rss><channel><item><title><![CDATA[New game &amp; expansion unveiled]]></title><link>https://www.gematsu.com/2026/11/new-game?utm_source=social</link><pubDate>Wed, 25 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>A detailed <b>reveal</b> &amp; footage</p>]]></description></item><item><title>Malicious fake</title><link>http://evil.test/injected</link><pubDate>Wed, 25 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>';
test('RSS content sanitization and UTM removal',()=>{
  const a=parseFeed(xml,source);assert.equal(a.length,1);
  assert.equal(a[0].title,'New game & expansion unveiled');
  assert.equal(a[0].url,'https://www.gematsu.com/2026/11/new-game');
  assert.equal(a[0].description,'A detailed reveal & footage');
});
test('reject untrusted links',()=>{
  assert.equal(normalizedUrl('https://evil.test/',source.hosts),'');
  assert.equal(normalizedUrl('https://gematsu.com.evil.test/a',source.hosts),'');
  assert.equal(normalizedUrl('javascript:alert(1)',source.hosts),'');
  assert.ok(normalizedUrl('https://www.gematsu.com/post',source.hosts));
});
test('freshness and importance ranking',()=>{
  const now=Date.parse('2026-11-25T11:00:00Z'),a=parseFeed(xml,source)[0];
  assert.equal(eligible(a,now,72),true);
  assert.equal(eligible(a,now+100*3600000,72),false);
  assert.equal(eligible(a,now-2*3600000,72),false);
  assert.match(rankNews([a,{...a,title:'Free game available now'}])[0].title,/Free game/);
});
test('validates JSON from AI',()=>{
  assert.equal(parseDraft({response:'{"headline":"Новость","body":"Короткий текст новости."}'}).headline,'Новость');
  assert.throws(()=>parseDraft({response:'bad output'}));
});
test('plain Telegram post omits source footer while validating original',()=>{
  const article=parseFeed(xml,source)[0];
  const txt=composePost({headline:'Новая игра',body:cleanText('<script>bad()</script>Стала известна дата релиза.')},article);
  assert.equal(txt,'🎮 Новая игра\n\nСтала известна дата релиза.');
  assert.ok(!txt.includes('Источник:'));
  assert.ok(!txt.includes('https://'));
  assert.throws(()=>composePost({headline:'Новая игра',body:'Стала известна дата релиза.'},{...article,url:'https://evil.test/'}),/verifiable source/);
  assert.ok(!txt.includes('bad()'));
});
test('Kazakhstan daily cutoff',()=>{
  assert.equal(dayKey(Date.parse('2026-11-25T22:00:00Z'),5),'2026-11-26');
});
