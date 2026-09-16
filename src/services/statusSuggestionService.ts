const { query, isPgConnected } = require('../db');
const { updateLearnedPhrase } = require('../utils/statusMatcher');
const config = require('../config');

async function createSuggestions() {
  if (!isPgConnected()) return [];
  const result = await query(`
    SELECT category, normalized_text AS phrase, hit_count AS occurrences
    FROM status_classifications sc
    WHERE category = 'unknown' AND hit_count >= 1
      AND NOT EXISTS (
        SELECT 1 FROM suggested_phrases sp
        WHERE sp.phrase = sc.normalized_text
      )
    ORDER BY hit_count DESC
  `);
  for (const row of result.rows) {
    await query(
      `INSERT INTO suggested_phrases (category, phrase, occurrences)
       VALUES ($1, $2, $3) ON CONFLICT (category, phrase) DO NOTHING`,
      [row.category, row.phrase, row.occurrences]
    );
  }
  if (result.rows.length > 0 && config.telegram.botToken && config.telegram.adminIds.length > 0) {
    const lines = result.rows.slice(0, 30).map((row) =>
      `• ${row.category}: ${row.phrase} (${row.occurrences})`
    );
    const text = `Новые предложения словаря статусов:\n${lines.join('\n')}`;
    for (const chatId of config.telegram.adminIds) {
      await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      }).catch((error) => console.warn('[StatusClassifier] Telegram notification failed:', error.message));
    }
  }
  return result.rows;
}

async function approveSuggestion(id) {
  if (!isPgConnected()) throw new Error('PostgreSQL не подключен');
  const result = await query(
    `SELECT id, category, phrase FROM suggested_phrases
     WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  const suggestion = result.rows[0];
  if (!suggestion) return null;

  await updateLearnedPhrase(suggestion.category, suggestion.phrase, 'add');
  await query(
    `UPDATE suggested_phrases SET status = 'approved', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  return suggestion;
}

async function listPendingSuggestions() {
  if (!isPgConnected()) return [];
  const result = await query(
    `SELECT id, phrase, occurrences, created_at
     FROM suggested_phrases
     WHERE status = 'pending'
     ORDER BY occurrences DESC, created_at DESC`
  );
  return result.rows;
}

async function assignSuggestion(id, category) {
  if (!isPgConnected()) throw new Error('PostgreSQL не подключен');
  const allowed = ['link_sent', 'repeat_sent', 'declined', 'already_registered', 'wrong_person'];
  if (!allowed.includes(category)) throw new Error('Недопустимая категория статуса');
  const result = await query(
    `SELECT id, phrase, occurrences
     FROM suggested_phrases
     WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  const suggestion = result.rows[0];
  if (!suggestion) return null;
  await updateLearnedPhrase(category, suggestion.phrase, 'add');
  await query(
    `UPDATE suggested_phrases
     SET category = $2, status = 'approved', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'`,
    [id, category]
  );
  await query(
    `UPDATE status_classifications
     SET category = $2, confidence = 1, source = 'manual', updated_at = CURRENT_TIMESTAMP
     WHERE normalized_text = $1`,
    [suggestion.phrase, category]
  );
  return { ...suggestion, category, status: 'approved' };
}

module.exports = { createSuggestions, approveSuggestion, listPendingSuggestions, assignSuggestion };
