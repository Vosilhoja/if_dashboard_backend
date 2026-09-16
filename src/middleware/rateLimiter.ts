const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const { RedisStore } = require('rate-limit-redis');

let redisClient;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}

const limiterOptions = (name, message) => {
  const store = redisClient
    ? new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: `hurmo:rate-limit:${name}:`,
    })
    : undefined;
  return {
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store } : {}),
    message,
  };
};

// Общий лимитер для всех API запросов
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 600, // обычные GET-запросы не должны блокировать общую работу команды
  ...limiterOptions('api', {
    status: 'fail',
    error: 'Слишком много запросов с вашего IP-адреса. Повторите попытку позже.'
  })
});

// Expensive dashboard aggregations are protected separately from lightweight
// health/settings requests. This prevents one browser or a shared proxy IP
// from consuming all backend capacity.
const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  ...limiterOptions('dashboard', {
    status: 'fail',
    error: 'Слишком много обновлений дашборда. Подождите немного.'
  })
});

// Строгий лимитер для эндпоинта авторизации (защита от Brute Force / перебора паролей)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 7, // максимум 7 попыток входа за 15 минут
  skipSuccessfulRequests: true, // не блокировать при успешном входе!
  ...limiterOptions('login', {
    status: 'fail',
    error: 'Слишком много неудачных попыток авторизации. Доступ временно заблокирован на 15 минут.'
  })
});

// Защитный лимитер для ИИ аналитика (разумный лимит 120 запросов в час)
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 120, // максимум 120 запросов в час с одного IP
  ...limiterOptions('ai', {
    status: 'fail',
    error: 'Превышен лимит запросов к ИИ-аналитику (максимум 120 запросов в час). Пожалуйста, повторите попытку позже.'
  })
});

const adminStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  ...limiterOptions('admin-status', {
    status: 'fail',
    error: 'Слишком много запусков классификации статусов. Повторите позже.'
  })
});

module.exports = {
  apiLimiter,
  dashboardLimiter,
  loginLimiter,
  aiLimiter,
  adminStatusLimiter
};
