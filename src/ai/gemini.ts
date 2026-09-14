/**
 * Gemini generateContent with key failover.
 * Keys come only from env — never hardcode.
 *
 * Railway names:
 *   GEMINI_API_KEY     — аккаунт 1 (основной, уже есть)
 *   GEMINI_API_KEY_2   — аккаунт 2
 *   GEMINI_API_KEY_3   — аккаунт 3
 *   GEMINI_API_KEY_4   — аккаунт 4
 */

const MODELS_TO_TRY = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

function getGeminiApiKeys() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
  ]
    .map((k) => (k || '').trim())
    .filter(Boolean);
}

function envNameForIndex(index) {
  return index === 0 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${index + 1}`;
}

function isQuotaOrRateLimit(status, body) {
  if (status === 429) return true;
  const message = body?.error?.message || '';
  const reason = body?.error?.status || body?.error?.reason || '';
  return (
    status === 403 &&
    (String(reason).includes('RESOURCE_EXHAUSTED') ||
      /quota|rate.?limit|exceeded|limit/i.test(message))
  );
}

async function generateGeminiContent(payload, label = 'AI') {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    throw Object.assign(new Error('GEMINI_API_KEY не задан на сервере'), { statusCode: 500 });
  }

  let lastError = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const keyName = envNameForIndex(i);
    let skipToNextKey = false;

    for (const model of MODELS_TO_TRY) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          const data = await response.json();
          return { data, modelUsed: model, keyName };
        }

        lastError = await response.json().catch(() => ({}));
        const message = lastError?.error?.message || `HTTP ${response.status}`;
        console.warn(`[${label}] ${keyName} / ${model}: ${response.status} ${message}`);

        if (isQuotaOrRateLimit(response.status, lastError)) {
          skipToNextKey = true;
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[${label}] ${keyName} / ${model} fetch:`, err.message);
      }
    }

    if (skipToNextKey) {
      console.warn(`[${label}] Лимит на ${keyName}, переключаюсь на следующий ключ`);
    }
  }

  const msg =
    lastError?.error?.message ||
    (lastError instanceof Error ? lastError.message : 'Все ключи Gemini недоступны');
  throw Object.assign(new Error(msg), { statusCode: 502 });
}

module.exports = {
  MODELS_TO_TRY,
  getGeminiApiKeys,
  generateGeminiContent,
};
