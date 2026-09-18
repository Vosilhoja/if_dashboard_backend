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

test('normalizes all supported apostrophe variants consistently', () => {
  const values = [
    "ro'yxatdan",
    'ro‘yxatdan',
    'roʻyxatdan',
    'roʼyxatdan',
    'ro′yxatdan',
    'ro`yxatdan',
  ];
  const normalized = values.map((value) => classifier.normalizedText(value));
  assert.equal(new Set(normalized).size, 1);
  assert.equal(normalized[0], 'ro yxatdan');
});

test('memory cache hit does not re-classify twice', async () => {
  const statusText = 'unique cache test phrase ' + Date.now();
  const first = await classifier.classifyStatus(statusText);
  const second = await classifier.classifyStatus(statusText);
  assert.equal(first.category, second.category);
  assert.equal(first.confidence, second.confidence);
  assert.equal(first.source, second.source);
  assert.equal(second.source, 'rule');
});

test('unmatched rule-based result returns unknown with rule source', async () => {
  const result = await classifier.classifyStatus('zzz totally unmatched status phrase xyz123');
  assert.equal(result.category, 'unknown');
  assert.equal(result.source, 'rule');
  assert.equal(typeof result.confidence, 'number');
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
