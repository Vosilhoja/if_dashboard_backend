const fs = require('fs');
const path = require('path');
const {
  STATUS_CONFIG,
  isLinkSentStatus,
  isRepeatSentStatus,
  isDeclinedStatus,
  isAlreadyRegisteredStatus,
  isWrongPersonStatus,
} = require('../utils/statusMatcher');
const { query, isPgConnected } = require('../db');
const { generateGeminiContent } = require('../ai/gemini');

const CONFIDENCE_THRESHOLD = 0.6;
const CATEGORIES = ['link_sent', 'repeat_sent', 'declined', 'already_registered', 'wrong_person', 'unknown'];
const learnedPath = path.join(process.cwd(), 'src', 'config', 'learned-phrases.json');
const memoryCache = new Map();
let learnedCache = null;
let aiCalls = 0;
let cacheHits = 0;
let aiClassifierOverride = null;

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[`'’ʻʽ_]/g, ' ')
    .replace(/[^\w\sа-яёўқғҳ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseRepeatedChars(text) {
  return String(text || '').replace(/(.)\1+/gu, '$1');
}

function transliterateCyrillicToLatin(text) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j',
    з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
    п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ҳ: 'h',
    ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e',
    ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g',
  };
  return String(text || '').split('').map((char) => map[char] || char).join('');
}

function normalizedText(text) {
  return collapseRepeatedChars(normalizeText(text));
}

function readLearnedPhrases() {
  if (learnedCache) return learnedCache;
  try {
    learnedCache = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  } catch {
    learnedCache = {};
  }
  return learnedCache;
}

function matchesLearned(text, category) {
  const phrases = readLearnedPhrases()[category] || [];
  return phrases.some((phrase) => text.includes(normalizedText(phrase)));
}

function ruleClassify(rawText, existingRules) {
  const text = normalizedText(rawText);
  if (!text) return null;
  if (existingRules?.category && existingRules.category !== 'unknown') {
    return {
      category: existingRules.category,
      confidence: Math.max(0.9, Number(existingRules.confidence || 0)),
      source: 'rule',
    };
  }

  const checks: Array<[string, (value: string) => boolean]> = [
    ['already_registered', (value) => isAlreadyRegisteredStatus(value, STATUS_CONFIG.alreadyRegistered)],
    ['repeat_sent', (value) => isRepeatSentStatus(value, STATUS_CONFIG.repeatSent)],
    ['wrong_person', (value) => isWrongPersonStatus(value, STATUS_CONFIG.wrongPerson)],
    ['declined', (value) => isDeclinedStatus(value, STATUS_CONFIG.declined)],
    ['link_sent', (value) => isLinkSentStatus(value, STATUS_CONFIG.linkSent)],
  ];
  for (const [category, matcher] of checks) {
    if (matcher(rawText) || matchesLearned(text, category)) {
      return { category, confidence: 1, source: 'rule' };
    }
  }
  return null;
}

async function getCached(normalized) {
  if (memoryCache.has(normalized)) return memoryCache.get(normalized);
  if (!isPgConnected()) return null;
  const result = await query(
    `SELECT category, confidence, source FROM status_classifications
     WHERE normalized_text = $1 LIMIT 1`,
    [normalized]
  );
  if (!result.rows[0]) return null;
  await query(
    'UPDATE status_classifications SET hit_count = hit_count + 1, updated_at = CURRENT_TIMESTAMP WHERE normalized_text = $1',
    [normalized]
  );
  const value = {
    category: result.rows[0].category,
    confidence: Number(result.rows[0].confidence),
    source: result.rows[0].source,
  };
  memoryCache.set(normalized, value);
  return value;
}

async function saveClassification(normalized, result) {
  memoryCache.set(normalized, result);
  if (!isPgConnected()) return;
  await query(
    `INSERT INTO status_classifications
      (normalized_text, category, confidence, source, hit_count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (normalized_text) DO UPDATE SET
       category = EXCLUDED.category,
       confidence = EXCLUDED.confidence,
       source = EXCLUDED.source,
       updated_at = CURRENT_TIMESTAMP,
       hit_count = status_classifications.hit_count + 1`,
    [normalized, result.category, result.confidence, result.source]
  );
}

function parseJsonResponse(text) {
  const parsed = JSON.parse(String(text).replace(/```json|```/gi, '').trim());
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'unknown';
  const confidence = Number(parsed.confidence);
  return {
    category: confidence >= CONFIDENCE_THRESHOLD ? category : 'unknown',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    source: 'ai',
  };
}

async function classifyWithAi(rawText) {
  if (aiClassifierOverride) {
    const result = await aiClassifierOverride(rawText);
    return result.confidence >= CONFIDENCE_THRESHOLD
      ? result
      : { ...result, category: 'unknown' };
  }
  const system = `You classify call-center operator statuses. Valid categories are:
link_sent, repeat_sent, declined, already_registered, wrong_person, unknown.
Return ONLY valid JSON: {"category":"repeat_sent","confidence":0.0}.
Use unknown when the text is ambiguous. Never include explanations.`;
  const payload = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ text: rawText }) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };
  aiCalls++;
  try {
    const response = await generateGeminiContent(payload, 'StatusClassifier');
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    return parseJsonResponse(text);
  } catch (geminiError) {
    const key = String(process.env.OPENAI_COMPATIBLE_API_KEY || '').trim();
    const baseUrl = String(process.env.OPENAI_COMPATIBLE_BASE_URL || '').trim();
    if (!key || !baseUrl) throw geminiError;
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ text: rawText }) }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible classifier HTTP ${response.status}`);
    const data = await response.json();
    return parseJsonResponse(data.choices?.[0]?.message?.content || '');
  }
}

async function classifyBatchWithAi(texts) {
  const system = `You classify each call-center status. Valid categories are:
link_sent, repeat_sent, declined, already_registered, wrong_person, unknown.
Return ONLY a JSON array with one object per input in the same order:
[{"category":"repeat_sent","confidence":0.0}].
Use unknown when ambiguous. Never include explanations.`;
  const payload = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ texts }) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };
  aiCalls++;
  let text = '';
  try {
    const response = await generateGeminiContent(payload, 'StatusClassifierBatch');
    text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  } catch (geminiError) {
    const key = String(process.env.OPENAI_COMPATIBLE_API_KEY || '').trim();
    const baseUrl = String(process.env.OPENAI_COMPATIBLE_BASE_URL || '').trim();
    if (!key || !baseUrl) throw geminiError;
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ texts }) }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible classifier HTTP ${response.status}`);
    const data = await response.json();
    text = data.choices?.[0]?.message?.content || '';
  }
  const parsed = JSON.parse(String(text).replace(/```json|```/gi, '').trim());
  const values = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(values)) throw new Error('Batch classifier returned invalid JSON');
  return texts.map((_, index) => {
    const value = values[index] || {};
    const rawConfidence = Number(value.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
    const category = CATEGORIES.includes(value.category) && confidence >= CONFIDENCE_THRESHOLD
      ? value.category
      : 'unknown';
    return { category, confidence, source: 'ai' };
  });
}

async function classifyStatus(rawText, existingRules = {}) {
  const normalized = normalizedText(rawText);
  const ruleResult = ruleClassify(rawText, existingRules);
  if (ruleResult) {
    await saveClassification(normalized, ruleResult);
    return ruleResult;
  }
  if (!normalized) return { category: 'unknown', confidence: 0, source: 'rule' };
  const cached = await getCached(normalized);
  if (cached) return cached;
  try {
    const result = await classifyWithAi(rawText);
    await saveClassification(normalized, result);
    return result;
  } catch (error) {
    console.warn('[StatusClassifier] AI fallback unavailable:', error.message || error);
    return { category: 'unknown', confidence: 0, source: 'ai' };
  }
}

async function classifyBatch(texts) {
  const unique = [...new Set(texts.map((text) => String(text || '').trim()).filter(Boolean))];
  const pending = [];
  const results = [];
  for (const text of unique) {
    const normalized = normalizedText(text);
    const ruleResult = ruleClassify(text, { category: 'unknown' });
    if (ruleResult) {
      await saveClassification(normalized, ruleResult);
      results.push({ text, result: ruleResult });
      continue;
    }
    const cached = await getCached(normalized);
    if (cached) {
      cacheHits++;
      results.push({ text, result: cached });
      continue;
    }
    pending.push({ text, normalized });
  }
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    try {
      const aiResults = await classifyBatchWithAi(batch.map((item) => item.text));
      for (let index = 0; index < batch.length; index++) {
        await saveClassification(batch[index].normalized, aiResults[index]);
        results.push({ text: batch[index].text, result: aiResults[index] });
      }
    } catch (error) {
      console.warn('[StatusClassifier] batch AI fallback unavailable:', error.message || error);
      for (const item of batch) {
        const result = { category: 'unknown', confidence: 0, source: 'ai' };
        await saveClassification(item.normalized, result);
        results.push({ text: item.text, result });
      }
    }
  }
  console.log(JSON.stringify({
    event: 'status_classifier_metrics',
    aiCalls,
    cacheHits,
    uniqueTexts: unique.length,
    cacheHitRate: unique.length ? Number((cacheHits / unique.length).toFixed(3)) : 1,
  }));
  return results;
}

module.exports = {
  normalizeText,
  collapseRepeatedChars,
  transliterateCyrillicToLatin,
  normalizedText,
  classifyStatus,
  classifyBatch,
  saveClassification,
  getCached,
  CONFIDENCE_THRESHOLD,
  setAiClassifierForTests: (handler) => { aiClassifierOverride = handler; },
};
