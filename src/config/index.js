require('dotenv').config();

// Ensure required environment variables exist without unsafe fallbacks
function requireEnv(key) {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    throw new Error(`CRITICAL CONFIG ERROR: Required environment variable "${key}" is not set.`);
  }
  return val.trim();
}

const jwtSecret = process.env.JWT_SECRET || 'hurmo_super_secure_jwt_secret_key_2026_senior_backend_production_ready';
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
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'hurmo_dashboard',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
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
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY
  },
  roles: {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    MANAGER: 'manager',
    OPERATOR: 'operator',
    VIEWER: 'viewer'
  }
};
