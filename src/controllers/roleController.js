const UserModel = require('../models/User');
const { inMemoryStore, isPgConnected, pool } = require('../db');

class RoleController {
  // Получить список всех доступных ролей
  static async getRoles(req, res) {
    try {
      if (isPgConnected() && pool) {
        const result = await pool.query('SELECT * FROM roles ORDER BY id ASC');
        return res.status(200).json({ status: 'success', roles: result.rows });
      }
      return res.status(200).json({ status: 'success', roles: inMemoryStore.roles });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }

  // Получить список всех пользователей системы с их ролями
  static async getUsers(req, res) {
    try {
      const users = await UserModel.getAllUsers();
      return res.status(200).json({ status: 'success', users });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }

  // Создать нового оператора/пользователя (только для админа/суперадмина)
  static async createUser(req, res) {
    try {
      const { username, password, fullName, role, permissions } = req.body;
      if (!username || !password) {
        return res.status(400).json({ status: 'fail', error: 'Логин и пароль обязательны' });
      }

      const existing = await UserModel.findByUsername(username);
      if (existing) {
        return res.status(400).json({ status: 'fail', error: 'Пользователь с таким логином уже существует' });
      }

      const validRoles = ['super_admin', 'admin', 'manager', 'operator', 'viewer'];
      const targetRole = validRoles.includes(role) ? role : 'operator';

      // Если создается пользователь, можно передать массив разрешенных страниц/прав
      const userPermissions = Array.isArray(permissions) ? permissions : [];

      const newUser = await UserModel.create({
        username,
        password,
        fullName,
        role: targetRole,
        permissions: userPermissions
      });

      return res.status(201).json({
        status: 'success',
        message: 'Пользователь успешно создан',
        user: newUser
      });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }

  // Обновление прав / разрешенных страниц пользователя
  static async updatePermissions(req, res) {
    try {
      const { userId } = req.params;
      const { permissions } = req.body;

      if (!Array.isArray(permissions)) {
        return res.status(400).json({ status: 'fail', error: 'Поле permissions должно быть массивом строк' });
      }

      const targetUser = await UserModel.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ status: 'fail', error: 'Пользователь не найден' });
      }

      if (targetUser.role === 'super_admin' && req.user.role !== 'super_admin') {
        return res.status(403).json({ status: 'fail', error: 'Только Главный администратор может менять права super_admin' });
      }

      const updated = await UserModel.updateUserPermissions(userId, permissions);
      return res.status(200).json({
        status: 'success',
        message: 'Права пользователя успешно обновлены',
        user: updated
      });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }

  // Удаление пользователя
  static async deleteUser(req, res) {
    try {
      const { userId } = req.params;
      const targetUser = await UserModel.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ status: 'fail', error: 'Пользователь не найден' });
      }

      if (targetUser.role === 'super_admin') {
        return res.status(403).json({ status: 'fail', error: 'Нельзя удалить учетную запись Главного администратора' });
      }

      if (targetUser.id === req.user.id) {
        return res.status(400).json({ status: 'fail', error: 'Нельзя удалить собственный аккаунт' });
      }

      const deleted = await UserModel.deleteUser(userId);
      if (!deleted) {
        return res.status(500).json({ status: 'error', error: 'Не удалось удалить пользователя' });
      }

      return res.status(200).json({
        status: 'success',
        message: `Пользователь ${targetUser.username} успешно удален`
      });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }

  // Изменить роль пользователя (только для super_admin и admin)
  static async assignRole(req, res) {
    try {
      const { userId } = req.params;
      const { role } = req.body;

      const validRoles = ['super_admin', 'admin', 'manager', 'operator', 'viewer'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({
          status: 'fail',
          error: `Недопустимая роль. Возможные варианты: ${validRoles.join(', ')}`
        });
      }

      // Нельзя понизить супер-админа обычному админу
      const targetUser = await UserModel.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ status: 'fail', error: 'Пользователь не найден' });
      }

      if (targetUser.role === 'super_admin' && req.user.role !== 'super_admin') {
        return res.status(403).json({ status: 'fail', error: 'Только Главный администратор может менять роль super_admin' });
      }

      const updated = await UserModel.updateUserRole(userId, role);
      return res.status(200).json({
        status: 'success',
        message: `Роль пользователя ${targetUser.username} успешно обновлена на ${role}`,
        user: updated
      });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }
  // Деактивировать / активировать пользователя (только для super_admin и admin)
  static async toggleUserActive(req, res) {
    try {
      const { userId } = req.params;
      const { is_active } = req.body;

      if (typeof is_active !== 'boolean') {
        return res.status(400).json({ status: 'fail', error: 'Поле is_active обязательно (boolean)' });
      }

      const targetUser = await UserModel.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ status: 'fail', error: 'Пользователь не найден' });
      }

      // Нельзя деактивировать super_admin через admin
      if (targetUser.role === 'super_admin' && req.user.role !== 'super_admin') {
        return res.status(403).json({ status: 'fail', error: 'Нельзя изменить статус Главного администратора' });
      }

      // Нельзя деактивировать самого себя
      if (targetUser.id === req.user.id) {
        return res.status(400).json({ status: 'fail', error: 'Нельзя деактивировать собственный аккаунт' });
      }

      const updated = await UserModel.setUserActive(userId, is_active);
      return res.status(200).json({
        status: 'success',
        message: `Пользователь ${targetUser.username} ${is_active ? 'активирован' : 'деактивирован'}`,
        user: updated
      });
    } catch (error) {
      return res.status(500).json({ status: 'error', error: error.message });
    }
  }
}

module.exports = RoleController;
