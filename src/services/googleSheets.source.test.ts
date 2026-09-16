import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { classifyRegistrationSource } = require('./googleSheets');

test('classifies an empty registration source as unknown', () => {
  assert.equal(classifyRegistrationSource(''), null);
  assert.equal(classifyRegistrationSource(undefined), null);
  assert.equal(classifyRegistrationSource('   '), null);
});

test('detects explicit bot registration sources', () => {
  assert.equal(classifyRegistrationSource('Telegram bot'), true);
  assert.equal(classifyRegistrationSource('сам зарегистрировался'), true);
});

test('detects explicit non-bot registration sources', () => {
  assert.equal(classifyRegistrationSource('Рекомендация друга или коллеги'), false);
  assert.equal(classifyRegistrationSource('Поиск в интернете (Google, Яндекс)'), false);
});
