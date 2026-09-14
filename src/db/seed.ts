const UserModel = require('../models/User');
const config = require('../config');

/**
 * Инициализация системных учетных записей по умолчанию
 * Создаются защищенные учетные записи с хешированными паролями через bcrypt
 */
async function seedDefaultUsers() {
  const defaultAccounts = [
    {
      username: config.auth.adminUsername,
      password: config.auth.adminPassword,
      fullName: 'Chief Administrator (HURMO)',
      role: 'super_admin',
      permissions: ['*']
    }
  ];

  for (const account of defaultAccounts) {
    const existing = await UserModel.findByUsername(account.username);
    if (!existing) {
      await UserModel.create(account);
      console.log(`👤 [Seed] Создан аккаунт: ${account.username} (Роль: ${account.role})`);
    } else {
      if (!(await UserModel.comparePassword(account.password, existing.password_hash))) {
        await UserModel.updatePassword(existing.id, account.password);
        console.log(`🔐 [Seed] Пароль аккаунта ${account.username} синхронизирован с ADMIN_PASSWORD`);
      }
      if (existing.role === 'super_admin') {
        await UserModel.updateUserPermissions(existing.id, ['*']);
      }
    }
  }
}

module.exports = { seedDefaultUsers };
