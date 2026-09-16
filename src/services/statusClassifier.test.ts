import assert from 'node:assert/strict';
import test from 'node:test';

const classifier = require('./statusClassifier');

test('rule hit does not call AI', async () => {
  let calls = 0;
  classifier.setAiClassifierForTests(async () => {
    calls++;
    return { category: 'unknown', confidence: 0, source: 'ai' };
  });
  const result = await classifier.classifyStatus('povtor silka yuborildi');
  assert.equal(result.category, 'repeat_sent');
  assert.equal(result.source, 'rule');
  assert.equal(calls, 0);
});

test('memory cache hit does not call AI twice', async () => {
  let calls = 0;
  classifier.setAiClassifierForTests(async () => {
    calls++;
    return { category: 'declined', confidence: 0.9, source: 'ai' };
  });
  await classifier.classifyStatus('custom status cache test');
  const result = await classifier.classifyStatus('custom status cache test');
  assert.equal(result.category, 'declined');
  assert.equal(calls, 1);
});

test('low confidence AI result becomes unknown', async () => {
  classifier.setAiClassifierForTests(async () => ({ category: 'repeat_sent', confidence: 0.4, source: 'ai' }));
  const result = await classifier.classifyStatus('another unmatched status');
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 0.4);
});

test('configured status phrase is used by the rule engine', async () => {
  const result = await classifier.classifyStatus('povtor silka yuborildi');
  assert.equal(result.category, 'repeat_sent');
  assert.equal(result.source, 'rule');
});

test('generic "уже" wording is not treated as an existing registration', () => {
  const matcher = require('../utils/statusMatcher');
  assert.equal(matcher.isAlreadyRegisteredStatus('уже отказался'), false);
  assert.equal(matcher.isAlreadyRegisteredStatus('уже не хочет говорить'), false);
  assert.equal(matcher.isAlreadyRegisteredStatus('не зарегистрировался'), false);
  assert.equal(matcher.isAlreadyRegisteredStatus('botdan ro`yxatdan o`tdi'), true);
});

test('positive wording with kerak is not treated as a declined call', () => {
  const matcher = require('../utils/statusMatcher');
  assert.equal(matcher.matchesCategory('menga kerak, qachon boshlanadi?', matcher.STATUS_CONFIG.declined), false);
  assert.equal(matcher.matchesCategory("ha albatta kerak bo'ladi", matcher.STATUS_CONFIG.declined), false);
  assert.equal(matcher.matchesCategory('otkaz qildi', matcher.STATUS_CONFIG.declined), true);
});

test('generic vaqti wording is not treated as a declined call', () => {
  const matcher = require('../utils/statusMatcher');
  assert.equal(
    matcher.matchesCategory('operator vaqtida javob berdi, hammasi yaxshi', matcher.STATUS_CONFIG.declined),
    false
  );
  assert.equal(
    matcher.matchesCategory('mijoz vaqtincha band, keyin qayta aloqaga chiqamiz', matcher.STATUS_CONFIG.declined),
    false
  );
  assert.equal(
    matcher.matchesCategory("vaqti yo'q, band", matcher.STATUS_CONFIG.declined),
    true
  );
});
