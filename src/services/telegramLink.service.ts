const crypto = require('crypto');
const Redis = require('ioredis');

const LINK_TTL_SECONDS = 5 * 60;
const LINK_ATTEMPT_LIMIT = 7;
const LINK_ATTEMPT_WINDOW_SECONDS = 15 * 60;

let redisClient;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}

function requireRedis() {
  if (!redisClient) {
    throw new Error('REDIS_URL is required for Telegram linking');
  }
  return redisClient;
}

async function createTelegramLinkCode(userId) {
  const client = requireRedis();
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  await client.set(`hurmo:telegram-link:${code}`, String(userId), 'EX', LINK_TTL_SECONDS);
  return { code, expiresInSeconds: LINK_TTL_SECONDS };
}

async function consumeTelegramLinkCode(code) {
  const client = requireRedis();
  const key = `hurmo:telegram-link:${String(code).trim().toUpperCase()}`;
  const userId = await client.eval(
    'local value = redis.call("GET", KEYS[1]); if value then redis.call("DEL", KEYS[1]); end; return value;',
    1,
    key
  );
  return userId ? String(userId) : null;
}

async function isTelegramLinkRateLimited(telegramId) {
  const client = requireRedis();
  const key = `hurmo:telegram-link-attempts:${String(telegramId)}`;
  const attempts = await client.incr(key);
  if (attempts === 1) {
    await client.expire(key, LINK_ATTEMPT_WINDOW_SECONDS);
  }
  return attempts > LINK_ATTEMPT_LIMIT;
}

module.exports = {
  createTelegramLinkCode,
  consumeTelegramLinkCode,
  isTelegramLinkRateLimited,
  LINK_TTL_SECONDS,
};
