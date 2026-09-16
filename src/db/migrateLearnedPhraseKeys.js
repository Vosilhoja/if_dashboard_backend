const { initDatabase, pool, isPgConnected } = require('./index');

function phraseKey(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[`'’‘ʻʽʼ′_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function migrate() {
  await initDatabase();
  if (!isPgConnected() || !pool) {
    throw new Error('PostgreSQL is not connected');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT id, category_id, phrase, created_at
      FROM learned_phrases
      ORDER BY created_at ASC NULLS LAST, id ASC
      FOR UPDATE
    `);
    const kept = new Map();
    let deleted = 0;

    for (const row of result.rows) {
      const key = `${row.category_id}\u0000${phraseKey(row.phrase)}`;
      if (!phraseKey(row.phrase) || kept.has(key)) {
        await client.query('DELETE FROM learned_phrases WHERE id = $1', [row.id]);
        deleted += 1;
        console.log(`[learned-phrases] deleted duplicate id=${row.id} category=${row.category_id} phrase=${JSON.stringify(row.phrase)}`);
      } else {
        kept.set(key, row.id);
      }
    }

    const constraints = await client.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'learned_phrases'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (category_id, phrase)'
    `);
    for (const constraint of constraints.rows) {
      await client.query(
        `ALTER TABLE learned_phrases DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraint.conname)}`
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS learned_phrases_normalized_key_idx
      ON learned_phrases (
        category_id,
        lower(
          btrim(
            regexp_replace(
              regexp_replace(phrase, $$[\`'’‘ʻʽʼ′_]$$, ' ', 'g'),
              $$\\s+$$, ' ', 'g'
            )
          )
        )
      )
    `);
    await client.query('COMMIT');
    console.log(`[learned-phrases] normalized migration complete; deleted=${deleted}, kept=${kept.size}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(`[learned-phrases] Normalization migration failed: ${error.message || error}`);
  process.exitCode = 1;
});
