const fs = require('fs');
const { initDatabase, pool, isPgConnected } = require('./index');

async function migrate() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    throw new Error('Pass an external learned-phrases JSON path as the first argument');
  }
  const dictionary = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

  await initDatabase();
  if (!isPgConnected() || !pool) {
    throw new Error('PostgreSQL is not connected; learned phrases were not migrated');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [categoryId, phrases] of Object.entries(dictionary)) {
      if (categoryId === '_disabled' || !Array.isArray(phrases)) continue;
      for (const phrase of phrases) {
        await client.query(
          `INSERT INTO learned_phrases (category_id, phrase, is_disabled)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (category_id, phrase) DO UPDATE SET is_disabled = FALSE`,
          [categoryId, String(phrase)]
        );
      }
    }
    for (const [categoryId, phrases] of Object.entries(dictionary._disabled || {})) {
      if (!Array.isArray(phrases)) continue;
      for (const phrase of phrases) {
        await client.query(
          `INSERT INTO learned_phrases (category_id, phrase, is_disabled)
           VALUES ($1, $2, TRUE)
           ON CONFLICT (category_id, phrase) DO UPDATE SET is_disabled = TRUE`,
          [categoryId, String(phrase)]
        );
      }
    }
    await client.query('COMMIT');
    console.log(`Migrated learned phrases from ${sourcePath}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(`[learned-phrases] Migration failed: ${error.message || error}`);
  process.exitCode = 1;
});
