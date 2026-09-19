const UserModel = require('../models/User');
const config = require('../config');
const { pool, isPgConnected, inMemoryStore } = require('./index');

/**
 * Инициализация системных учетных записей по умолчанию
 * Создаются защищенные учетные записи с хешированными паролями через bcrypt
 */
async function seedDefaultUsers() {
  if (!config.auth.adminPassword) {
    console.warn(
      '⚠️ [Seed] ADMIN_PASSWORD не задан. Стандартный аккаунт не создается; существующие аккаунты PostgreSQL доступны.'
    );
    await seedDemoTasks();
    return;
  }

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
  await seedDemoTasks();
}

async function seedDemoTasks() {
  // Без токена Todoist создаем демо-задачи в локальной таблице/хранилище
  if (process.env.TODOIST_API_TOKEN) return;

  const definitions = Array.from({ length: 10 }, (_, index) => ({
    title: `Задача ${index + 1}`,
    notes: `Демонстрационная задача ${index + 1}`,
    status: index % 4 === 0 ? 'done' : index % 5 === 0 ? 'in_progress' : 'open',
    priority: ['urgent', 'high', 'medium', 'low'][index % 4],
    dueAt: new Date(Date.now() + (index - 1) * 24 * 60 * 60 * 1000).toISOString(),
    tags: [`demo`, `группа-${(index % 3) + 1}`],
  }));

  if (isPgConnected() && pool) {
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM tasks');
    if (count.rows[0].count > 0) return;
    const admin = await UserModel.findByUsername(config.auth.adminUsername);
    for (const task of definitions) {
      await pool.query(
        `INSERT INTO tasks (title, notes, status, priority, due_at, tags, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [task.title, task.notes, task.status, task.priority, task.dueAt, task.tags, admin?.id || null],
      );
    }
    console.log('📝 [Seed] Созданы 10 демонстрационных задач в PostgreSQL');
  } else if (Array.isArray(inMemoryStore.tasks) && inMemoryStore.tasks.length === 0) {
    const now = new Date().toISOString();
    inMemoryStore.tasks = definitions.map((task, idx) => ({
      id: idx + 1,
      ...task,
      category: 'Демо',
      comments: [],
      assigneeId: null,
      linkedPhone: null,
      linkedUserId: null,
      createdBy: 1,
      createdAt: now,
      updatedAt: now,
    }));
    console.log('📝 [Seed] Созданы 10 демонстрационных задач в локальной памяти');
  }
}

module.exports = { seedDefaultUsers, seedDemoTasks };
