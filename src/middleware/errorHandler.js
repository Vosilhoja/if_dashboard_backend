// Centralized Error Handling Middleware (Senior-level production standard)

function notFoundHandler(req, res, next) {
  res.status(404).json({
    status: 'fail',
    error: `Маршрут ${req.originalUrl} не найден на этом сервере`
  });
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const status = err.status || 'error';

  // Логирование критических ошибок
  if (statusCode === 500) {
    console.error('💥 [Server Internal Error]:', err);
  }

  res.status(statusCode).json({
    status,
    error: err.message || 'Внутренняя ошибка сервера',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

module.exports = {
  notFoundHandler,
  errorHandler
};
