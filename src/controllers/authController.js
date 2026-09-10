const jwt = require('jsonwebtoken');
const config = require('../config');
const UserModel = require('../models/User');

class AuthController {
  /**
   * Вход в систему (Login)
   * Поддерживает как пароль команды HURMO, так и связку логин+пароль оператора/админа
   */
  static async login(req, res) {
    try {
      const { username, password } = req.body;

      // Валидация входных данных
      if (!password || typeof password !== 'string') {
        return res.status(400).json({
          status: 'fail',
          error: 'Поле пароля обязательно для заполнения'
        });
      }

      const targetUsername = (username && typeof username === 'string' && username.trim())
        ? username.trim().toLowerCase()
        : 'admin';

      const user = await UserModel.findByUsername(targetUsername);

      if (!user) {
        return res.status(401).json({
          status: 'fail',
          error: 'Неверные учетные данные'
        });
      }

      if (!user.is_active) {
        return res.status(403).json({
          status: 'fail',
          error: 'Учетная запись деактивирована'
        });
      }

      // Сравнение хеша пароля через bcrypt с защитой от тайминг-атак
      const isPasswordValid = await UserModel.comparePassword(password, user.password_hash);
      if (!isPasswordValid) {
        return res.status(401).json({
          status: 'fail',
          error: 'Неверный пароль доступа'
        });
      }

      // Обновляем время последнего входа
      await UserModel.updateLastLogin(user.id);

      // Генерируем подписанный JWT-токен с ролевой информацией
      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
      );

      return res.status(200).json({
        status: 'success',
        message: 'Авторизация успешно выполнена',
        token,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          role: user.role,
          permissions: user.permissions || [],
          telegramLinked: !!user.telegram_id
        }
      });
    } catch (error) {
      console.error('[Auth Controller Error]:', error);
      return res.status(500).json({
        status: 'error',
        error: 'Внутренняя ошибка сервера при авторизации'
      });
    }
  }

  /**
   * Получение профиля текущего пользователя
   */
  static async getMe(req, res) {
    return res.status(200).json({
      status: 'success',
      user: req.user
    });
  }

  /**
   * Выход из системы
   */
  static async logout(req, res) {
    return res.status(200).json({
      status: 'success',
      message: 'Сессия успешно завершена'
    });
  }
}

module.exports = AuthController;
