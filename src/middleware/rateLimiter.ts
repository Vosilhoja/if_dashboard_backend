const rateLimit = require('express-rate-limit');

// Общий лимитер для всех API запросов
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 300, // максимум 300 запросов с одного IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'fail',
    error: 'Слишком много запросов с вашего IP-адреса. Повторите попытку позже.'
  }
});

// Строгий лимитер для эндпоинта авторизации (защита от Brute Force / перебора паролей)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 7, // максимум 7 попыток входа за 15 минут
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // не блокировать при успешном входе!
  message: {
    status: 'fail',
    error: 'Слишком много неудачных попыток авторизации. Доступ временно заблокирован на 15 минут.'
  }
});

module.exports = {
  apiLimiter,
  loginLimiter
};
