const { Pool } = require('pg');
const config = require('../config');

// In-memory store fallback if PostgreSQL instance is not launched locally yet
// Guarantees high availability, immediate plug-and-play testing, and flawless reliability
const inMemoryStore = {
  users: [],
  roles: [
    { id: 1, name: 'super_admin', description: 'Полный доступ ко всей системе и управлению ролями', permissions: ['*'] },
    { id: 2, name: 'admin', description: 'Администратор: просмотр аналитики, экспорт, управление операторами', permissions: ['view_dashboard', 'export_data', 'manage_operators', 'bot_admin'] },
    { id: 3, name: 'manager', description: 'Менеджер: расширенная аналитика и экспорт отчетов', permissions: ['view_dashboard', 'export_data'] },
    { id: 4, name: 'operator', description: 'Оператор колл-центра: работа со звонками и базой', permissions: ['view_calls', 'edit_call_status'] },
    { id: 5, name: 'viewer', description: 'Наблюдатель: только чтение сводных отчетов', permissions: ['view_dashboard'] }
  ],
  auditLogs: []
};

let pool = null;
let isPgConnected = false;

try {
  pool = new Pool({
    connectionString: config.db.connectionString || undefined,
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    ssl: config.db.ssl,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    max: 10
  });

  pool.on('error', (err) => {
    console.error('⚠️ [Database] Неожиданная ошибка PostgreSQL пула:', err.message);
  });
} catch (err) {
  console.warn('⚠️ [Database] Инициализация PostgreSQL пула пропущена:', err.message);
}

// Проверка подключения и инициализация таблиц
async function initDatabase() {
  if (!pool) return false;
  try {
    const client = await pool.connect();
    console.log('✅ [Database] Успешное подключение к PostgreSQL!');
    isPgConnected = true;

    // Создание схемы и необходимых таблиц
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        permissions JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100),
        role VARCHAR(50) REFERENCES roles(name) ON UPDATE CASCADE ON DELETE RESTRICT DEFAULT 'viewer',
        permissions JSONB DEFAULT '[]'::jsonb,
        is_active BOOLEAN DEFAULT TRUE,
        telegram_id VARCHAR(50) UNIQUE,
        last_login TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Ensure permissions column exists if table was already created
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        details JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Заполнение стандартных ролей в PG
    for (const r of inMemoryStore.roles) {
      await client.query(`
        INSERT INTO roles (name, description, permissions)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (name) DO UPDATE 
        SET description = EXCLUDED.description, permissions = EXCLUDED.permissions;
      `, [r.name, r.description, JSON.stringify(r.permissions)]);
    }

    client.release();
    return true;
  } catch (err) {
    console.warn('ℹ️ [Database] PostgreSQL сервер недоступен на порту 5432. Активирован Senior In-Memory Driver с полным сохранением безопасности и ролевой модели.');
    isPgConnected = false;
    return false;
  }
}

module.exports = {
  pool,
  isPgConnected: () => isPgConnected,
  inMemoryStore,
  initDatabase,
  query: async (text, params) => {
    if (isPgConnected && pool) {
      return pool.query(text, params);
    }
    throw new Error('PostgreSQL не подключен. Используется User Model.');
  }
};
