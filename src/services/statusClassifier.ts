const {
  STATUS_CONFIG,
  getEditableStatusCategories,
  isLinkSentStatus,
  isRepeatSentStatus,
  isDeclinedStatus,
  isAlreadyRegisteredStatus,
  isWrongPersonStatus,
} = require('../utils/statusMatcher');
const { query, isPgConnected } = require('../db');

const CONFIDENCE_THRESHOLD = 0.6;
const CATEGORIES = ['link_sent', 'repeat_sent', 'declined', 'already_registered', 'wrong_person', 'unknown'];
const memoryCache = new Map();
let cacheHits = 0;

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[`'’‘ʻʽʼ′_]/g, ' ')
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

function matchesLearned(text, category) {
  const phrases = getEditableStatusCategories()
    .find((item) => item.id === category)?.phrases || [];
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

  const checks = [
    { category: 'already_registered', matcher: (value) => isAlreadyRegisteredStatus(value, STATUS_CONFIG.alreadyRegistered) },
    { category: 'repeat_sent', matcher: (value) => isRepeatSentStatus(value, STATUS_CONFIG.repeatSent) },
    { category: 'wrong_person', matcher: (value) => isWrongPersonStatus(value, STATUS_CONFIG.wrongPerson) },
    { category: 'declined', matcher: (value) => isDeclinedStatus(value, STATUS_CONFIG.declined) },
    { category: 'link_sent', matcher: (value) => isLinkSentStatus(value, STATUS_CONFIG.linkSent) },
  ];
  for (const item of checks) {
    if (item.matcher(rawText) || matchesLearned(text, item.category)) {
      return { category: item.category, confidence: 1, source: 'rule' };
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
  const result = { category: 'unknown', confidence: 0, source: 'rule' };
  await saveClassification(normalized, result);
  return result;
}

async function classifyBatch(texts) {
  const unique = [...new Set(texts.map((text) => String(text || '').trim()).filter(Boolean))];
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
    const result = { category: 'unknown', confidence: 0, source: 'rule' };
    await saveClassification(normalized, result);
    results.push({ text, result });
  }
  console.log(JSON.stringify({
    event: 'status_classifier_metrics',
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
  CATEGORIES,
  setAiClassifierForTests: () => {},
};
