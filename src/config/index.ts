require('dotenv').config();

// Ensure required environment variables exist without unsafe fallbacks
function requireEnv(key) {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    throw new Error(`CRITICAL CONFIG ERROR: Required environment variable "${key}" is not set.`);
  }
  return val.trim();
}

const jwtSecret = requireEnv('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('CRITICAL CONFIG ERROR: JWT_SECRET must contain at least 32 characters.');
}

const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
if (adminPassword && adminPassword.length < 12) {
  throw new Error('CRITICAL CONFIG ERROR: ADMIN_PASSWORD must contain at least 12 characters.');
}

// ============================================================
// Telegram Bot configuration — Railway-style multiple bots
// ============================================================
//
// Legacy (single bot, backward compatible):
//   TELEGRAM_BOT_TOKEN=123456:ABCdef
//   TELEGRAM_USER_ID=777000              (optional, per-bot allowed user)
//   TELEGRAM_ALLOWED_IDS=111,222,333
//   TELEGRAM_ADMIN_IDS=111,222
//
// Railway-style (multiple bots, N = 1,2,3...):
//   TELEGRAM_TOKEN_1=123456:ABCdef       (bot #1 token)
//   TELEGRAM_USER_ID_1=777000            (bot #1 primary user, auto-allowed)
//   TELEGRAM_TOKEN_2=789012:XYZghi       (bot #2 token)
//   TELEGRAM_USER_ID_2=888000            (bot #2 primary user, auto-allowed)
//   ...TELEGRAM_ALLOWED_IDS / TELEGRAM_ADMIN_IDS still apply globally
//
// Each bot record: { id, token, userId, allowedIds: [userId, ...globalAdmins] }
// Legacy single-bot data is exposed as telegram.bots[0] plus the old
// telegram.botToken / telegram.allowedIds / telegram.adminIds fields so
// existing code (statusSuggestionService, /health, etc.) keeps working.
// ============================================================

const legacyToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const legacyUserId = (process.env.TELEGRAM_USER_ID || '').trim();

const globalAllowedIds = [process.env.TELEGRAM_ALLOWED_IDS, process.env.TELEGRAM_ADMIN_IDS]
  .filter(Boolean)
  .join(',')
  .split(',')
  .map(id => id.trim())
  .filter(id => /^\d+$/.test(id))
  .filter((id, index, ids) => ids.indexOf(id) === index);

const telegramBots = [];

for (let n = 1; n <= 99; n++) {
  const token = (process.env[`TELEGRAM_TOKEN_${n}`] || '').trim();
  if (!token) break;
  const userId = (process.env[`TELEGRAM_USER_ID_${n}`] || '').trim();
  const allowedIds = new Set(globalAllowedIds);
  if (userId) allowedIds.add(userId);
  telegramBots.push({
    id: n,
    token,
    userId: userId || '',
    allowedIds: [...allowedIds],
  });
}

if (legacyToken && telegramBots.length === 0) {
  const allowedIds = new Set(globalAllowedIds);
  if (legacyUserId) allowedIds.add(legacyUserId);
  telegramBots.push({
    id: 0,
    token: legacyToken,
    userId: legacyUserId || '',
    allowedIds: [...allowedIds],
  });
}

const telegramBotToken = telegramBots[0]?.token || legacyToken || '';

const telegramFeatures = [
  { key: 'bot_view_summary', label: 'Сводка дашборда', description: 'Оперативные метрики и показатели' },
  { key: 'bot_view_calls', label: 'Статистика обзвонов', description: 'Показатели колл-центра' },
  { key: 'bot_search_users', label: 'Поиск пользователей', description: 'Поиск по номеру или идентификатору' },
  { key: 'bot_view_profile', label: 'Мой профиль', description: 'Профиль и статус сотрудника' },
  { key: 'bot_manage_tasks', label: 'Задачи', description: 'Просмотр и создание задач' },
  { key: 'bot_system_status', label: 'Статус системы', description: 'Проверка доступности API' },
  { key: 'bot_view_permissions', label: 'Мои права', description: 'Просмотр роли и доступных функций' },
];

module.exports = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || '10mb',
  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  db: {
    // Railway PostgreSQL is enabled when DATABASE_URL is connected.
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    enabled: process.env.DB_ENABLED !== 'false' && Boolean(
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.PGHOST
    ),
    host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.PGPORT, 10) || 5432,
    user: process.env.DB_USER || process.env.PGUSER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
    database: process.env.DB_NAME || process.env.PGDATABASE || 'hurmo_dashboard',
    ssl: process.env.DB_SSL !== 'false' && Boolean(
      process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGHOST
    )
      ? { rejectUnauthorized: true }
      : false
  },
  telegram: {
    bots: telegramBots,
    botToken: telegramBotToken,
    allowedIds: globalAllowedIds,
    adminIds: globalAllowedIds
    ,
    features: telegramFeatures
  },
  google: {
    sheetMain: process.env.GOOGLE_SHEET_MAIN,
    sheetNumbers: process.env.GOOGLE_SHEET_NUMBERS,
    sheetEskiz: process.env.GOOGLE_SHEET_ESKIZ,
    sheetNotCompleted: process.env.GOOGLE_SHEET_NOT_COMPLETED,
    sheetSurveyAttempts: process.env.GOOGLE_SHEET_SURVEY_ATTEMPTS,
    sheetCalls: process.env.GOOGLE_SHEET_CALLS,
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY
  },
  roles: {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    MANAGER: 'manager',
    OPERATOR: 'operator',
    VIEWER: 'viewer',
    telegramFeatures
  },
  auth: {
    storage: process.env.AUTH_STORAGE || (process.env.DATABASE_URL ? 'postgres' : 'memory'),
    maxUsers: 3,
    fixedUsers: process.env.FIXED_USERS === 'true',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword
  }
};
