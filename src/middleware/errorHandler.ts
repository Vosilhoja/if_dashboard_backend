// Centralized Error Handling Middleware (Senior-level production standard)

function notFoundHandler(req, res, next) {
  res.status(404).json({
    status: 'fail',
    error: `Маршрут ${req.originalUrl} не найден на этом сервере`
  });
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const status = statusCode >= 400 && statusCode < 500 ? 'fail' : 'error';

  if (err.type === 'entity.too.large' || statusCode === 413) {
    return res.status(413).json({
      status: 'fail',
      error: 'Запрос слишком большой. Сократите историю диалога или размер данных и повторите попытку.',
    });
  }

  const parseError = err as SyntaxError & { status?: number; body?: unknown; type?: string };
  if (err instanceof SyntaxError && parseError.status === 400 && parseError.body !== undefined) {
    return res.status(400).json({
      status: 'fail',
      error: 'Некорректный JSON в теле запроса.',
    });
  }

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
