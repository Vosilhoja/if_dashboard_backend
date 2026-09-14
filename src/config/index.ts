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
if (!adminPassword) {
  throw new Error('CRITICAL CONFIG ERROR: ADMIN_PASSWORD is not set.');
}
if (adminPassword.length < 12) {
  throw new Error('CRITICAL CONFIG ERROR: ADMIN_PASSWORD must contain at least 12 characters.');
}

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';

module.exports = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
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
    botToken: telegramBotToken,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
  },
  google: {
    sheetMain: process.env.GOOGLE_SHEET_MAIN,
    sheetNumbers: process.env.GOOGLE_SHEET_NUMBERS,
    sheetEskiz: process.env.GOOGLE_SHEET_ESKIZ,
    sheetNotCompleted: process.env.GOOGLE_SHEET_NOT_COMPLETED,
    sheetCalls: process.env.GOOGLE_SHEET_CALLS,
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY
  },
  // Gemini AI API key — used only on the backend (never exposed to frontend)
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  roles: {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    MANAGER: 'manager',
    OPERATOR: 'operator',
    VIEWER: 'viewer'
  },
  auth: {
    storage: process.env.AUTH_STORAGE || (process.env.DATABASE_URL ? 'postgres' : 'memory'),
    maxUsers: 3,
    fixedUsers: process.env.FIXED_USERS === 'true',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword
  }
};
