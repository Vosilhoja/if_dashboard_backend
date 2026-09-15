const fs = require('fs');
const path = require('path');
const { query, isPgConnected } = require('../db');
const { normalizedText } = require('./statusClassifier');
const config = require('../config');

const learnedPath = path.join(process.cwd(), 'src', 'config', 'learned-phrases.json');

async function createSuggestions() {
  if (!isPgConnected()) return [];
  const result = await query(`
    SELECT category, normalized_text AS phrase, hit_count AS occurrences
    FROM status_classifications sc
    WHERE source = 'ai' AND confidence > 0.85 AND hit_count >= 3
      AND NOT EXISTS (
        SELECT 1 FROM suggested_phrases sp
        WHERE sp.category = sc.category AND sp.phrase = sc.normalized_text
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
    `UPDATE suggested_phrases SET status = 'approved', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending' RETURNING id, category, phrase`,
    [id]
  );
  const suggestion = result.rows[0];
  if (!suggestion) return null;

  let dictionary = {};
  try {
    dictionary = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  } catch {
    dictionary = {};
  }
  dictionary[suggestion.category] = Array.isArray(dictionary[suggestion.category])
    ? dictionary[suggestion.category]
    : [];
  const phrase = normalizedText(suggestion.phrase);
  if (phrase && !dictionary[suggestion.category].includes(phrase)) {
    dictionary[suggestion.category].push(phrase);
    fs.writeFileSync(learnedPath, `${JSON.stringify(dictionary, null, 2)}\n`, 'utf8');
  }
  return suggestion;
}

module.exports = { createSuggestions, approveSuggestion };
