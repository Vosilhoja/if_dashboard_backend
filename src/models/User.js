const bcrypt = require('bcryptjs');
const { pool, isPgConnected, inMemoryStore } = require('../db');

class UserModel {
  // Поиск пользователя по логину
  static async findByUsername(username) {
    const cleanUsername = String(username).trim().toLowerCase();
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.*, r.permissions FROM users u LEFT JOIN roles r ON u.role = r.name WHERE LOWER(u.username) = $1',
          [cleanUsername]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка findByUsername в PG:', e.message);
      }
    }
    
    // In-memory fallback
    const user = inMemoryStore.users.find(u => u.username.toLowerCase() === cleanUsername);
    if (!user) return null;
    const roleInfo = inMemoryStore.roles.find(r => r.name === user.role);
    return {
      ...user,
      permissions: roleInfo ? roleInfo.permissions : []
    };
  }

  // Поиск пользователя по ID
  static async findById(id) {
    const numId = Number(id);
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.telegram_id, u.last_login, u.created_at, r.permissions FROM users u LEFT JOIN roles r ON u.role = r.name WHERE u.id = $1',
          [numId]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка findById в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => u.id === numId);
    if (!user) return null;
    const roleInfo = inMemoryStore.roles.find(r => r.name === user.role);
    return {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      telegram_id: user.telegram_id,
      last_login: user.last_login,
      created_at: user.created_at,
      permissions: roleInfo ? roleInfo.permissions : []
    };
  }

  // Поиск по Telegram ID (для бота)
  static async findByTelegramId(telegramId) {
    const cleanTgId = String(telegramId).trim();
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.telegram_id FROM users u WHERE u.telegram_id = $1',
          [cleanTgId]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка findByTelegramId в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => String(u.telegram_id) === cleanTgId);
    return user || null;
  }

  // Создание нового пользователя
  static async create({ username, password, fullName, role = 'viewer', telegramId = null }) {
    const cleanUsername = String(username).trim().toLowerCase();
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);

    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          `INSERT INTO users (username, password_hash, full_name, role, telegram_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, username, full_name, role, is_active, telegram_id, created_at`,
          [cleanUsername, passwordHash, fullName || cleanUsername, role, telegramId ? String(telegramId) : null]
        );
        return res.rows[0];
      } catch (e) {
        console.error('Ошибка создания пользователя в PG:', e.message);
      }
    }

    const newUser = {
      id: inMemoryStore.users.length + 1,
      username: cleanUsername,
      password_hash: passwordHash,
      full_name: fullName || cleanUsername,
      role,
      is_active: true,
      telegram_id: telegramId ? String(telegramId) : null,
      last_login: null,
      created_at: new Date()
    };
    inMemoryStore.users.push(newUser);
    return {
      id: newUser.id,
      username: newUser.username,
      full_name: newUser.full_name,
      role: newUser.role,
      is_active: newUser.is_active,
      telegram_id: newUser.telegram_id,
      created_at: newUser.created_at
    };
  }

  // Обновление даты последнего входа
  static async updateLastLogin(id) {
    const now = new Date();
    if (isPgConnected() && pool) {
      try {
        await pool.query('UPDATE users SET last_login = $1 WHERE id = $2', [now, Number(id)]);
        return;
      } catch (e) {
        console.error('Ошибка updateLastLogin в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => u.id === Number(id));
    if (user) {
      user.last_login = now;
    }
  }

  // Привязка telegram ID к пользователю
  static async linkTelegramId(username, telegramId) {
    const cleanUsername = String(username).trim().toLowerCase();
    const cleanTgId = String(telegramId).trim();

    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'UPDATE users SET telegram_id = $1 WHERE LOWER(username) = $2 RETURNING id, username, role, telegram_id',
          [cleanTgId, cleanUsername]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка linkTelegramId в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => u.username.toLowerCase() === cleanUsername);
    if (user) {
      user.telegram_id = cleanTgId;
      return user;
    }
    return null;
  }

  // Список всех пользователей
  static async getAllUsers() {
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.telegram_id, u.last_login, u.created_at FROM users u ORDER BY u.id ASC'
        );
        return res.rows;
      } catch (e) {
        console.error('Ошибка getAllUsers в PG:', e.message);
      }
    }

    return inMemoryStore.users.map(u => ({
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      role: u.role,
      is_active: u.is_active,
      telegram_id: u.telegram_id,
      last_login: u.last_login,
      created_at: u.created_at
    }));
  }

  // Обновление роли пользователя
  static async updateUserRole(userId, newRole) {
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, role',
          [newRole, Number(userId)]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка updateUserRole в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => u.id === Number(userId));
    if (user) {
      user.role = newRole;
      return { id: user.id, username: user.username, role: user.role };
    }
    return null;
  }

  // Проверка совпадения пароля
  static async comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  }
}

module.exports = UserModel;
