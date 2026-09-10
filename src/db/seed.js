const UserModel = require('../models/User');

/**
 * Инициализация системных учетных записей по умолчанию
 * Создаются защищенные учетные записи с хешированными паролями через bcrypt
 */
async function seedDefaultUsers() {
  const defaultAccounts = [
    {
      username: 'admin',
      password: process.env.DASHBOARD_PASSWORD || 'hurmo_secure_pass_2026',
      fullName: 'Chief Administrator (HURMO)',
      role: 'super_admin'
    },
    {
      username: 'manager_dilshod',
      password: 'manager_secret_2026',
      fullName: 'Дилшод (Аналитик / Менеджер)',
      role: 'manager'
    },
    {
      username: 'operator_aziz',
      password: 'operator_secret_2026',
      fullName: 'Азиз (Колл-центр Оператор)',
      role: 'operator'
    }
  ];

  for (const account of defaultAccounts) {
    const existing = await UserModel.findByUsername(account.username);
    if (!existing) {
      await UserModel.create(account);
      console.log(`👤 [Seed] Создан аккаунт: ${account.username} (Роль: ${account.role})`);
    }
  }
}

module.exports = { seedDefaultUsers };
