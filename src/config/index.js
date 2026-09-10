require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback_secret_for_dev_only_change_in_prod_12345',
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
    botToken: process.env.TELEGRAM_BOT_TOKEN || '8947372834:AAFaBgNc0qNX12PSSPJ-hAuFYwfgLYi6J78',
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
  },
  roles: {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    MANAGER: 'manager',
    OPERATOR: 'operator',
    VIEWER: 'viewer'
  }
};
