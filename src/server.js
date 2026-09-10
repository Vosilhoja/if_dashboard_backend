const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const { initDatabase } = require('./db');
const { seedDefaultUsers } = require('./db/seed');
const { apiLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

// Маршруты
const authRoutes = require('./routes/authRoutes');
const roleRoutes = require('./routes/roleRoutes');
const dataRoutes = require('./routes/dataRoutes');

// Инициализация Telegram Бота
const { initTelegramBot } = require('./bot/telegramBot');

const app = express();

// ==========================================
// 🛡️ SECURITY & UTILITY MIDDLEWARES
// ==========================================

// 1. Helmet — защита заголовков HTTP
app.use(helmet());

// 2. CORS — строгая политика источников (разрешаем Next.js фронтенд на Vercel и локально)
const allowedOrigins = [
  config.clientUrl,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://if-dashboard.vercel.app',
  'https://if-dashboard-git-main-vosilhoja.vercel.app',
  'https://if-dashboard-backend.fly.dev'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    // Check direct matches
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }

    // Check dynamic Vercel preview deployments (*.vercel.app)
    if (/^https:\/\/if-dashboard.*\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }

    if (config.nodeEnv === 'development') {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked request from origin: ${origin}`);
    callback(new Error('Запрос заблокирован политикой CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token']
}));

// 3. Request Logging
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// 4. Body Parsers с защитой от больших payload
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 5. Global API Rate Limiter
app.use('/api', apiLimiter);

// ==========================================
// 🌐 API ROUTES
// ==========================================

// Health Check / Ping
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    timestamp: new Date().toISOString(),
    service: 'HURMO UZ Backend API',
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// Модуль Авторизации (Login, JWT, Profile)
app.use('/api/auth', authRoutes);

// Модуль Управления Ролями и Пользователями (RBAC)
app.use('/api/admin', roleRoutes);

// Модуль Данных Дашборда (Google Sheets Metrics, Period Details, CRUD)
app.use('/api/data', dataRoutes);

// 404 & Centralized Error Handlers
app.use(notFoundHandler);
app.use(errorHandler);

// ==========================================
// 🚀 SERVER LAUNCH & INITIALIZATION
// ==========================================

async function startServer() {
  try {
    console.log('🔄 [Bootstrap] Инициализация баз данных и системных служб...');
    
    // Подключение к БД
    await initDatabase();

    // Наполнение пользователями по умолчанию
    await seedDefaultUsers();

    // Запуск сервера
    app.listen(config.port, '0.0.0.0', () => {
      console.log('====================================================');
      console.log(`🚀 [HURMO Backend] Сервер успешно запущен на порту: ${config.port}`);
      console.log(`📡 URL API: http://localhost:${config.port}`);
      console.log(`🛡️ Режим: ${config.nodeEnv.toUpperCase()}`);
      console.log(`🔐 Авторизация: JWT + Bcrypt + Rate-Limiting + RBAC`);
      console.log('====================================================');

      // Запуск Telegram Бота
      initTelegramBot();
    });
  } catch (error) {
    console.error('❌ Фатальная ошибка при запуске сервера:', error);
    process.exit(1);
  }
}

// Запуск
if (require.main === module) {
  startServer();
}

module.exports = app;
