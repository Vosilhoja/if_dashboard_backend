/**
 * src/controllers/aiController.js
 * Gemini AI integration — all Gemini API calls live here on the backend.
 * The frontend never touches Gemini directly.
 */
const { generateGeminiContent } = require('../ai/gemini');

async function callGemini(payload, label = 'AI') {
  const { data } = await generateGeminiContent(payload, label);
  return data;
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

const { runAIChat } = require('../ai/client');

const MAX_PERSISTED_CHAT_MESSAGES = 200;

function normalizePersistedMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => (
      (message?.role === 'user' || message?.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0
    ))
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 8_000),
    }));
}

async function getChatHistory(userId) {
  const { pool, isPgConnected, inMemoryStore } = require('../db');
  if (isPgConnected() && pool) {
    const result = await pool.query(
      `SELECT id, role, content, created_at
       FROM ai_chat_messages
       WHERE user_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [Number(userId), MAX_PERSISTED_CHAT_MESSAGES]
    );
    return result.rows.map((message) => ({
      id: String(message.id),
      role: message.role,
      content: message.content,
      timestamp: new Date(message.created_at).toISOString(),
    }));
  }

  const messages = inMemoryStore.aiChatMessages.get(Number(userId)) || [];
  return messages.slice(-MAX_PERSISTED_CHAT_MESSAGES);
}

async function appendChatHistory(userId, messages) {
  const normalized = normalizePersistedMessages(messages);
  if (normalized.length === 0) return;

  const { pool, isPgConnected, inMemoryStore } = require('../db');
  if (isPgConnected() && pool) {
    await pool.query(
      `INSERT INTO ai_chat_messages (user_id, role, content)
       VALUES ${normalized.map((_, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3})`).join(', ')}`,
      [Number(userId), ...normalized.flatMap((message) => [message.role, message.content])]
    );
    await pool.query(
      `DELETE FROM ai_chat_messages
       WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM ai_chat_messages
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       )`,
      [Number(userId), MAX_PERSISTED_CHAT_MESSAGES]
    );
    return;
  }

  const current = inMemoryStore.aiChatMessages.get(Number(userId)) || [];
  const next = [...current, ...normalized].slice(-MAX_PERSISTED_CHAT_MESSAGES).map((message, index) => ({
    ...message,
    id: message.id || `memory-${Number(userId)}-${Date.now()}-${index}`,
    timestamp: message.timestamp || new Date().toISOString(),
  }));
  inMemoryStore.aiChatMessages.set(Number(userId), next);
}

async function clearChatHistory(userId) {
  const { pool, isPgConnected, inMemoryStore } = require('../db');
  if (isPgConnected() && pool) {
    await pool.query('DELETE FROM ai_chat_messages WHERE user_id = $1', [Number(userId)]);
    return;
  }
  inMemoryStore.aiChatMessages.delete(Number(userId));
}

async function history(req, res, next) {
  try {
    return res.status(200).json({ messages: await getChatHistory(req.user.id) });
  } catch (err) {
    next(err);
  }
}

async function clearHistory(req, res, next) {
  try {
    await clearChatHistory(req.user.id);
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function chat(req, res, next) {
  try {
    const { messages, metrics, selectedRegion, period } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'История сообщений пуста' });
    }
    if (messages.length > 50) {
      return res.status(400).json({ error: 'История диалога слишком длинная' });
    }

    const { reply, modelUsed } = await runAIChat({
      messages,
      metricsContext: metrics,
      selectedRegion,
      period,
      userContext: {
        username: req.user?.username,
        role: req.user?.role,
      },
    });

    await appendChatHistory(req.user.id, [
      messages[messages.length - 1],
      { role: 'assistant', content: reply },
    ]);

    return res.status(200).json({
      reply,
      modelUsed,
      timestamp: new Date().toISOString(),
    });
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

module.exports = { chat, insights, history, clearHistory };
