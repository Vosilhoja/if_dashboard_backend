const jwt = require('jsonwebtoken');
const config = require('../config');
const UserModel = require('../models/User');

// Middleware проверки подлинности JWT токена
async function authenticateToken(req, res, next) {
  try {
    let token = null;

    // 1. Проверяем заголовок Authorization (Bearer token)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    // 2. Либо проверяем x-access-token
    else if (req.headers['x-access-token']) {
      token = req.headers['x-access-token'];
    }

    if (!token) {
      return res.status(401).json({
        status: 'fail',
        error: 'Доступ запрещен: отсутствует токен авторизации'
      });
    }

    // Верификация токена
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          status: 'fail',
          error: 'Срок действия сессии истек. Пожалуйста, выполните вход повторно.'
        });
      }
      return res.status(401).json({
        status: 'fail',
        error: 'Недействительный токен безопасности'
      });
    }

    // Проверяем существование и активность пользователя в БД
    const user = await UserModel.findById(decoded.id);
    if (!user) {
      return res.status(401).json({
        status: 'fail',
        error: 'Пользователь больше не существует'
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        status: 'fail',
        error: 'Учетная запись заблокирована администратором'
      });
    }

    // Сохраняем пользователя в объекте запроса для последующих middleware и контроллеров
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

// Middleware разграничения доступа по ролям (RBAC)
// Использование: authorizeRoles('super_admin', 'admin')
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'fail',
        error: 'Пользователь не авторизован'
      });
    }

    // Роль super_admin имеет безусловный доступ ко всем эндпоинтам
    if (req.user.role === 'super_admin') {
      return next();
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'fail',
        error: `Доступ запрещен: требуется роль [${allowedRoles.join(', ')}], ваша текущая роль: [${req.user.role}]`
      });
    }

    next();
  };
}

module.exports = {
  authenticateToken,
  authorizeRoles
};
