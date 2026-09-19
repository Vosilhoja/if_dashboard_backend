const crypto = require('crypto');
const { pool, isPgConnected, inMemoryStore } = require('../db');

const memoryBots = [];

function encryptionKey() {
  const encoded = String(process.env.TELEGRAM_ENCRYPTION_KEY || '').trim();
  if (!encoded) throw new Error('TELEGRAM_ENCRYPTION_KEY не настроен');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('TELEGRAM_ENCRYPTION_KEY должен быть base64-ключом длиной 32 байта');
  return key;
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join('.');
}

function decryptToken(value) {
  const [ivRaw, tagRaw, ciphertextRaw] = String(value || '').split('.');
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error('Некорректный зашифрованный Telegram-токен');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64')), decipher.final()]).toString('utf8');
}

function maskToken(token) {
  const value = String(token || '');
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : '••••••••';
}

async function listManagedBots() {
  if (isPgConnected() && pool) {
    const result = await pool.query('SELECT id, name, token_encrypted, chat_id, allowed_ids, enabled_features, is_active, created_at, updated_at FROM telegram_bots ORDER BY id');
    return result.rows.map((row) => ({
      ...row,
      token: decryptToken(row.token_encrypted),
      tokenMask: maskToken(decryptToken(row.token_encrypted)),
      allowedIds: row.allowed_ids || [],
      enabledFeatures: Array.isArray(row.enabled_features) ? row.enabled_features : [],
    }));
  }
  return memoryBots.map((bot) => ({ ...bot, token: decryptToken(bot.token_encrypted), tokenMask: maskToken(decryptToken(bot.token_encrypted)) }));
}

async function createManagedBot({ name, token, chatId, allowedIds, enabledFeatures }) {
  const encrypted = encryptToken(token);
  const ids = [...new Set((allowedIds || []).map(String).filter((id) => /^\d+$/.test(id)))];
  if (chatId && !ids.includes(String(chatId))) ids.push(String(chatId));
  const features = Array.isArray(enabledFeatures) ? enabledFeatures : [];
  if (isPgConnected() && pool) {
    const result = await pool.query(
      `INSERT INTO telegram_bots (name, token_encrypted, chat_id, allowed_ids, enabled_features)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING id, name, chat_id, allowed_ids, enabled_features, is_active, created_at, updated_at`,
      [String(name || 'Telegram bot').trim(), encrypted, chatId ? String(chatId) : null, ids, JSON.stringify(features)]
    );
    return { ...result.rows[0], tokenMask: maskToken(token), allowedIds: result.rows[0].allowed_ids || [], enabledFeatures: result.rows[0].enabled_features || [] };
  }
  const bot = {
    id: memoryBots.length + 1,
    name: String(name || 'Telegram bot').trim(),
    token_encrypted: encrypted,
    chat_id: chatId ? String(chatId) : null,
    allowed_ids: ids,
    enabled_features: features,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  memoryBots.push(bot);
  return { ...bot, tokenMask: maskToken(token), allowedIds: ids, enabledFeatures: features };
}

async function updateManagedBot(id, patch) {
  const allowed = ['name', 'chatId', 'allowedIds', 'enabledFeatures', 'isActive'];
  if (isPgConnected() && pool) {
    const sets = [];
    const values = [];
    const map = { chatId: 'chat_id', allowedIds: 'allowed_ids', enabledFeatures: 'enabled_features', isActive: 'is_active' };
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      values.push(key === 'allowedIds' ? patch[key].map(String) : key === 'enabledFeatures' ? JSON.stringify(patch[key]) : patch[key]);
      const column = map[key] || key;
      sets.push(`${column} = $${values.length}${key === 'enabledFeatures' ? '::jsonb' : ''}`);
    }
    if (!sets.length) return (await listManagedBots()).find((bot) => String(bot.id) === String(id)) || null;
    values.push(Number(id));
    const result = await pool.query(`UPDATE telegram_bots SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING id, name, chat_id, allowed_ids, enabled_features, is_active, created_at, updated_at`, values);
    const row = result.rows[0];
    return row ? { ...row, allowedIds: row.allowed_ids || [], enabledFeatures: row.enabled_features || [] } : null;
  }
  const bot = memoryBots.find((item) => String(item.id) === String(id));
  if (!bot) return null;
  if (patch.name !== undefined) bot.name = String(patch.name);
  if (patch.chatId !== undefined) bot.chat_id = patch.chatId ? String(patch.chatId) : null;
  if (patch.allowedIds !== undefined) bot.allowed_ids = patch.allowedIds.map(String);
  if (patch.enabledFeatures !== undefined) bot.enabled_features = patch.enabledFeatures;
  if (patch.isActive !== undefined) bot.is_active = Boolean(patch.isActive);
  bot.updated_at = new Date().toISOString();
  return { ...bot, allowedIds: bot.allowed_ids, enabledFeatures: bot.enabled_features };
}

async function deleteManagedBot(id) {
  if (isPgConnected() && pool) return (await pool.query('DELETE FROM telegram_bots WHERE id = $1 RETURNING id', [Number(id)])).rowCount > 0;
  const index = memoryBots.findIndex((bot) => String(bot.id) === String(id));
  if (index < 0) return false;
  memoryBots.splice(index, 1);
  return true;
}

module.exports = {
  listManagedBots,
  createManagedBot,
  updateManagedBot,
  deleteManagedBot,
};
