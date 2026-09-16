const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const config = require('./config');
const { initDatabase } = require('./db');
const { seedDefaultUsers } = require('./db/seed');
const { apiLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

// Маршруты
const authRoutes = require('./routes/authRoutes');
const roleRoutes = require('./routes/roleRoutes');
const dataRoutes = require('./routes/dataRoutes');
const aiRoutes = require('./routes/aiRoutes');
const statsRoutes = require('./routes/statsRoutes');
const callRoutes = require('./routes/callRoutes');
const statusRoutes = require('./routes/statusRoutes');
const statusAdminRoutes = require('./routes/statusAdminRoutes');

// Инициализация Telegram Бота
const { initTelegramBot } = require('./bot/telegramBot');
const { prewarmDataCache, startBackgroundDataRefresh } = require('./services/googleSheets');
const { startCallWorker } = require('./services/worker.service');
const {
  startStatusClassifierWorker,
  startStatusSuggestionScheduler,
} = require('./services/statusClassificationQueue');

const app = express();

// Trust reverse proxy (Fly.io, Vercel) for accurate IP detection and rate limiting
app.set('trust proxy', 1);

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
  // Railway backend — self-requests allowed
  'https://ifdashboardbackend-production.up.railway.app',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    // Check direct matches
    if (allowedOrigins.indexOf(origin) !== -1) {
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

// 3. Structured request logging with automatic duration and status fields.
app.use(pinoHttp({
  level: config.nodeEnv === 'production' ? 'info' : 'silent',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-access-token"]',
    ],
    censor: '[REDACTED]',
  },
}));

// 4. Body Parsers: allow realistic dashboard / AI payloads without permitting unbounded uploads.
app.use(express.json({ limit: config.requestBodyLimit || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: config.requestBodyLimit || '10mb', parameterLimit: 50000 }));

// 5. Global API Rate Limiter
app.use('/api', apiLimiter);

// ==========================================
// 🌐 API ROUTES
// ==========================================

// Health Check / Ping
app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'HURMO UZ Backend API',
    version: '1.0.0',
    uptime: process.uptime(),
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
  });
});

// Модуль Авторизации (Login, JWT, Profile)
app.use('/api/auth', authRoutes);

// Модуль Управления Ролями и Пользователями (RBAC)
app.use('/api/admin', roleRoutes);
app.use('/api/admin', statusAdminRoutes);

// Модуль Данных Дашборда (Google Sheets Metrics, Period Details, CRUD)
app.use('/api/data', dataRoutes);
app.use('/api/calls', callRoutes);

// Модуль AI (Gemini) — все вызовы AI API только с бэкенда
app.use('/api/ai', aiRoutes);

// Модуль Агрегированной Статистики (Weekly, Monthly, Summary с in-memory кешем)
app.use('/api/stats', statsRoutes);
app.use('/api/status', statusRoutes);

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

    // Warm the Google Sheets cache before accepting traffic so the first
    // dashboard render uses ready data instead of waiting on four API calls.
    await prewarmDataCache();
    startBackgroundDataRefresh();
    // Google Sheets worker is optional at boot: API and health endpoint must
    // remain available while Railway variables are being configured.
    startCallWorker();
    startStatusClassifierWorker();
    startStatusSuggestionScheduler();

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

// ==========================================
// 🛡️ GLOBAL ERROR HANDLERS (prevent silent crashes)
// ==========================================
process.on('uncaughtException', (error) => {
  console.error('❌ [UNCAUGHT EXCEPTION] Необработанное исключение:', error);
  console.error('[UNCAUGHT EXCEPTION] Stack:', error.stack);
  // Give time to log before exit
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [UNHANDLED REJECTION] Необработанное отклонение промиса:', reason);
  console.error('[UNHANDLED REJECTION] Promise:', promise);
  // Don't exit — log and continue, some rejections are non-fatal (e.g. DB retry)
});

// Запуск
if (require.main === module) {
  startServer();
}

module.exports = app;
