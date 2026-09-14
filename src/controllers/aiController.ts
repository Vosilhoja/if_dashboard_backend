/**
 * src/controllers/aiController.js
 * Gemini AI integration — all Gemini API calls live here on the backend.
 * The frontend never touches Gemini directly.
 */
const config = require('../config');

const MODELS_TO_TRY = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function callGemini(payload, label = 'AI') {
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured on server'), { statusCode: 500 });
  }

  let lastError = null;
  for (const model of MODELS_TO_TRY) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return await response.json();
      }

      lastError = await response.json().catch(() => ({}));
      console.warn(`[${label}] Model ${model} returned HTTP ${response.status}:`, lastError?.error?.message || '');
    } catch (err) {
      lastError = err;
      console.warn(`[${label}] Model ${model} fetch error:`, err.message);
    }
  }

  const msg = lastError?.error?.message || (lastError instanceof Error ? lastError.message : 'All models failed');
  throw Object.assign(new Error(msg), { statusCode: 502 });
}

// ─────────────────────────────────────────────
// POST /api/ai/chat
// Body: { messages, metrics?, selectedRegion?, period? }
// ─────────────────────────────────────────────
const CHAT_SYSTEM_PROMPT = `Ты — встроенный старший дата-аналитик и стратегический консультант компании HURMO RESEARCH. Ты глубоко знаешь эту компанию и работаешь исключительно в её интересах.

=== ПОЛНЫЙ ПРОФИЛЬ КОМПАНИИ: HURMO RESEARCH ===

ОФИЦИАЛЬНОЕ НАЗВАНИЕ: ООО «HURMO RESEARCH» (HURMO RESEARCH LLC).
СТРАНА: Узбекистан, Центральная Азия.
САЙТ: hurmo.uz

ПРОФИЛЬ: Независимое полноцикловое агентство — маркетинговые, социологические и медиа-исследования.

=== ПЛАТФОРМА HURMO UZ — ДАШБОРД ОПЕРАЦИОННЫХ ДАННЫХ ===
Этот дашборд — внутренний инструмент HURMO RESEARCH для мониторинга операций колл-центра.
Данные: numbers, main_base, eskiz, not_completed.

КРИТИЧЕСКИЕ ПРАВИЛА:
1. НИКОГДА не называй себя "Gemini", "ChatGPT", "GPT", "языковая модель". Ты — «старший дата-аналитик платформы HURMO UZ».
2. Тональность: профессионально, авторитетно, структурированно. Пиши на русском языке.

НАВИГАЦИЯ:
- [Главная](/overview) | [Воронка](/dashboard) | [BI-аналитика](/analytics) | [Карта](/map) | [Сырые таблицы](/raw) | [Настройки](/settings) | [ИИ-Аналитик](/chat)`;

async function chat(req, res, next) {
  try {
    const { messages, metrics, selectedRegion, period } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'История сообщений пуста' });
    }

    // Build context summary from metrics
    let contextSummary = 'Данные за текущий период не переданы или ещё загружаются.';
    if (metrics) {
      const calls    = typeof metrics.callsCount?.value === 'number' ? metrics.callsCount.value : 0;
      const sms      = typeof metrics.smsSentVerification?.value === 'number' ? metrics.smsSentVerification.value : 0;
      const reg      = typeof metrics.registeredMainBase?.value === 'number' ? metrics.registeredMainBase.value : 0;
      const declined = typeof metrics.declinedCount?.value === 'number' ? metrics.declinedCount.value : 0;
      const callToSmsConv = calls > 0 ? ((sms / calls) * 100).toFixed(1) : '0';
      const smsToRegConv  = sms  > 0 ? ((reg / sms)  * 100).toFixed(1) : '0';
      const endToEndConv  = calls > 0 ? ((reg / calls) * 100).toFixed(1) : '0';

      contextSummary = `АКТУАЛЬНЫЕ МЕТРИКИ ДАШБОРДА HURMO UZ:
- Выбранный период: с ${metrics.period?.startDate || period?.startDate || 'н/д'} по ${metrics.period?.endDate || period?.endDate || 'н/д'}
${selectedRegion ? `- Географический фильтр: регион "${selectedRegion}"` : '- География: вся территория Узбекистана (14 областей)'}
ВОРОНКА:
1. Звонки: ${calls.toLocaleString('ru-RU')}
2. SMS верификации: ${sms.toLocaleString('ru-RU')} (конверсия из звонка: ${callToSmsConv}%)
3. Зарегистрировано в main_base: ${reg.toLocaleString('ru-RU')} (конверсия из SMS: ${smsToRegConv}%, сквозная: ${endToEndConv}%)
- Отказы: ${declined.toLocaleString('ru-RU')} (${calls > 0 ? ((declined / calls) * 100).toFixed(1) : '0'}% от звонков)
АНОМАЛИИ:
- Звонки: отклонение ${metrics.anomalyData?.callsAnomaly?.deltaPercent ?? 0}%, статус: ${metrics.anomalyData?.callsAnomaly?.isAnomaly ? 'АНОМАЛИЯ' : 'Норма'}
- Отказы: отклонение ${metrics.anomalyData?.declinedAnomaly?.deltaPercent ?? 0}%, статус: ${metrics.anomalyData?.declinedAnomaly?.isAnomaly ? 'КРИТИЧЕСКАЯ АНОМАЛИЯ' : 'Норма'}`;
    }

    const fullSystemPrompt = CHAT_SYSTEM_PROMPT + `\n\nКОНТЕКСТ РЕАЛЬНЫХ ДАННЫХ ПРЯМО СЕЙЧАС:\n${contextSummary}`;

    const serviceContents = messages.map((m) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const data = await callGemini({
      systemInstruction: { parts: [{ text: fullSystemPrompt }] },
      contents: serviceContents,
      generationConfig: { temperature: 0.5, maxOutputTokens: 3000 },
    }, 'AI Chat');

    const parts = data.candidates?.[0]?.content?.parts || [];
    const reply = parts.map((p) => p.text || '').join('\n').trim();

    if (!reply) {
      return res.status(502).json({ error: 'Ответ пуст или сработали ограничения безопасности' });
    }

    return res.status(200).json({ reply, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/ai/insights
// Body: { metrics, question? }
// ─────────────────────────────────────────────
const INSIGHTS_SYSTEM_PROMPT = `Ты — старший дата-аналитик, встроенный в дашборд поддержки/регистрации пользователей.

Тебе приходит JSON с РЕАЛЬНЫМИ цифрами за выбранный период. Твоя задача — думать над ними: искать причинно-следственные связи, сопоставлять метрики, находить узкие места воронки и аномалии.

Правила:
1. Никогда не используй шаблонные фразы вида «все показатели в норме» — если данные есть, находи в них сигнал.
2. Каждый вывод обязан ссылаться на конкретные цифры из входных данных.
3. Анализируй воронку целиком: звонки → SMS → регистрация → отказы.
4. Если isAnomaly=true — это приоритет №1.
5. Структура ответа (заголовки строго по-русски):
## Ключевые находки
## Разбор воронки и конверсий
## Аномалии и риски
## Рекомендации
6. Пиши на русском, кратко, используй маркированные списки.
7. Никогда не упоминай, что ты языковая модель.`;

async function insights(req, res, next) {
  try {
    const { metrics, question } = req.body || {};

    if (!metrics) {
      return res.status(400).json({ error: 'Не переданы данные метрик для анализа' });
    }

    const analysisPayload = {
      period: metrics.period,
      callsCount: metrics.callsCount,
      smsSentVerification: metrics.smsSentVerification,
      registeredMainBase: metrics.registeredMainBase,
      registeredFromSupport: metrics.registeredFromSupport,
      registeredAfterRepeat: metrics.registeredAfterRepeat,
      declinedCount: metrics.declinedCount,
      alreadyRegisteredCount: metrics.alreadyRegisteredCount,
      wrongPersonCount: metrics.wrongPersonCount,
      notCompletedCount: metrics.notCompletedCount,
      phoneDiagnostics: metrics.phoneDiagnostics,
      totalRows: metrics.totalRows,
      anomalyData: metrics.anomalyData,
    };

    let userContent = JSON.stringify(analysisPayload, null, 2);
    if (question && typeof question === 'string' && question.trim().length > 0) {
      userContent += `\n\nДополнительный вопрос от пользователя к анализу:\n${question.trim()}`;
    }

    const data = await callGemini({
      systemInstruction: { parts: [{ text: INSIGHTS_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }, 'AI Insights');

    const parts = data.candidates?.[0]?.content?.parts || [];
    const analysis = parts.map((p) => p.text || '').join('\n').trim();

    if (!analysis) {
      return res.status(502).json({ error: 'Не удалось получить анализ: ответ пуст или сработал фильтр безопасности' });
    }

    return res.status(200).json({ analysis, generatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

module.exports = { chat, insights };
