const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const config = require('./config');
const { initDatabase } = require('./db');
const { loadLearnedPhrasesFromDb } = require('./utils/statusMatcher');
const { seedDefaultUsers } = require('./db/seed');
const { apiLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const roleRoutes = require('./routes/roleRoutes');
const dataRoutes = require('./routes/dataRoutes');
const statsRoutes = require('./routes/statsRoutes');
const callRoutes = require('./routes/callRoutes');
const statusRoutes = require('./routes/statusRoutes');
const statusAdminRoutes = require('./routes/statusAdminRoutes');
const taskRoutes = require('./routes/taskRoutes');
const systemRoutes = require('./routes/systemRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const { initTelegramBot } = require('./bot/telegramBot');
const {
  prewarmDataCache,
  startBackgroundDataRefresh,
  restoreSheetCacheFromRedis,
} = require('./services/googleSheets');
const { startCallWorker } = require('./services/worker.service');
const {
  startStatusClassifierWorker,
  startStatusSuggestionScheduler,
} = require('./services/statusClassificationQueue');

const app = express();

let telegramBots = [];

const supervisorState = {
  dbReconnectAttempts: 0,
  lastDbReconnect: 0,
  restartCount: Number(process.env.SUPERVISOR_RESTART_COUNT || 0),
  maxRestarts: 5,
  restartWindowMs: 300_000,
  restartsTimestamps: [],
};

async function ensureDatabaseConnection() {
  const { pool, initDatabase, isPgConnected } = require('./db');
  if (isPgConnected() && pool) {
    try {
      await pool.query('SELECT 1');
      supervisorState.dbReconnectAttempts = 0;
      return true;
    } catch (pingError) {
      console.warn('[Supervisor] PostgreSQL пинг не прошел: ' + pingError.message);
    }
  }
  const now = Date.now();
  const backoff = Math.min(60_000, 2_000 * Math.pow(2, Math.min(supervisorState.dbReconnectAttempts, 6)));
  if (now - supervisorState.lastDbReconnect < backoff) return false;
  supervisorState.lastDbReconnect = now;
  supervisorState.dbReconnectAttempts += 1;
  console.log('[Supervisor] Попытка переподключения к PostgreSQL #' + supervisorState.dbReconnectAttempts);
  try {
    const ok = await initDatabase();
    if (ok) {
      console.log('[Supervisor] PostgreSQL восстановлен');
      supervisorState.dbReconnectAttempts = 0;
      return true;
    }
  } catch (err) {
    console.warn('[Supervisor] Не удалось восстановить БД: ' + err.message);
  }
  return false;
}

function startSupervisor() {
  const { restoreSheetCacheFromRedis: restore } = require('./services/googleSheets');
  console.log('[Supervisor] Запущен мониторинг подсистем');
  setInterval(async () => {
    await ensureDatabaseConnection();
  }, 15_000);
  if (process.env.REDIS_URL) {
    setInterval(() => {
      restore().catch((err) =>
        console.warn('[Supervisor] Redis restore warning: ' + err.message)
      );
    }, 5 * 60_000);
  }
}

app.set('trust proxy', 1);

app.use(helmet());

const allowedOrigins = [
  config.clientUrl,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://if-dashboard.vercel.app',
  'https://if-dashboard-git-main-vosilhoja.vercel.app',
  'https://if-dashboard-six.vercel.app',
  'https://ifdashboardbackend-production.up.railway.app',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    if (config.nodeEnv === 'development') {
      return callback(null, true);
    }
    console.warn('[CORS] Blocked request from origin: ' + origin);
    callback(new Error('Запрос заблокирован политикой CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token']
}));

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

app.use(express.json({ limit: config.requestBodyLimit || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: config.requestBodyLimit || '10mb', parameterLimit: 50000 }));

app.use('/api', apiLimiter);

app.get('/health', async (req, res) => {
  const memory = process.memoryUsage();
  const { isPgConnected, pool } = require('./db');
  let dbOk = false;
  try {
    if (isPgConnected() && pool) { await pool.query('SELECT 1'); dbOk = true; }
  } catch (_) { dbOk = false; }
  const subsystems = {
    postgres: dbOk ? 'healthy' : (config.db.enabled ? 'degraded' : 'disabled'),
    cache: 'healthy',
    telegram: (() => {
      const bots = config.telegram.bots || [];
      if (bots.length === 0) return 'disabled';
      const healthyBots = bots.filter((b) => b.token && b.allowedIds.length > 0).length;
      if (healthyBots === bots.length) return 'healthy';
      if (healthyBots > 0) return 'degraded';
      return 'disabled';
    })(),
  };
  const overallDegraded = Object.values(subsystems).some(value => value === 'degraded');
  res.status(200).json({
    status: overallDegraded ? 'DEGRADED' : 'OK',
    timestamp: new Date().toISOString(),
    service: 'HURMO UZ Backend API',
    version: '1.1.0',
    uptime: process.uptime(),
    supervisor: {
      restartCount: supervisorState.restartCount,
      dbReconnectAttempts: supervisorState.dbReconnectAttempts,
    },
    subsystems,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', roleRoutes);
app.use('/api/admin', statusAdminRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/settings', settingsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  try {
    console.log('[Bootstrap] Инициализация баз данных и системных служб...');
    await initDatabase();
    await loadLearnedPhrasesFromDb();
    await seedDefaultUsers();
    await restoreSheetCacheFromRedis();
    startBackgroundDataRefresh();
    startCallWorker();
    startStatusClassifierWorker();
    startStatusSuggestionScheduler();

    app.listen(config.port, '0.0.0.0', async () => {
      console.log('====================================================');
      console.log('[HURMO Backend] Сервер успешно запущен на порту: ' + config.port);
      console.log('URL API: http://localhost:' + config.port);
      console.log('Режим: ' + String(config.nodeEnv).toUpperCase());
      console.log('Авторизация: JWT + Bcrypt + Rate-Limiting + RBAC');
      console.log('====================================================');
      telegramBots = await initTelegramBot();
    });

    startSupervisor();

    prewarmDataCache().catch((error) => {
      console.error('[Bootstrap] Начальная синхронизация не выполнена:', error);
    });
  } catch (error) {
    console.error('Фатальная ошибка при запуске сервера:', error);
    process.exit(1);
  }
}

process.on('uncaughtException', (error: any) => {
  console.error('[UNCAUGHT EXCEPTION] Необработанное исключение:', error);
  console.error('[UNCAUGHT EXCEPTION] Stack:', error && error.stack);
  const now = Date.now();
  supervisorState.restartsTimestamps = supervisorState.restartsTimestamps.filter(ts => now - ts < supervisorState.restartWindowMs);
  supervisorState.restartsTimestamps.push(now);
  const errCode = String((error && error.code) || '');
  if (supervisorState.restartsTimestamps.length < supervisorState.maxRestarts && errCode !== 'ERR_HTTP_HEADERS_SENT') {
    console.warn('[Supervisor] Попытка самовосстановления (' + supervisorState.restartsTimestamps.length + '/' + supervisorState.maxRestarts + ')...');
    ensureDatabaseConnection();
    return;
  }
  console.error('[Supervisor] Превышен лимит рестартов, аварийное завершение');
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason: any, promise) => {
  console.error('[UNHANDLED REJECTION] Необработанное отклонение промиса:', reason);
  console.error('[UNHANDLED REJECTION] Promise:', promise);
  const msg = String((reason && reason.message) || reason || '');
  if (/postgres|database|pg_|connection|ECONN|ETIMEDOUT/i.test(msg)) {
    console.warn('[Supervisor] DB-related rejection, запуск восстановления БД');
    ensureDatabaseConnection();
  }
});

if (require.main === module) {
  startServer();
}

module.exports = app;
