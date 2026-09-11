const bcrypt = require('bcryptjs');
const { pool, isPgConnected, inMemoryStore } = require('../db');

class UserModel {
  // Поиск пользователя по логину
  static async findByUsername(username) {
    const cleanUsername = String(username).trim().toLowerCase();
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.*, COALESCE(u.permissions, r.permissions, \'[]\'::jsonb) as permissions FROM users u LEFT JOIN roles r ON u.role = r.name WHERE LOWER(u.username) = $1',
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
      permissions: (user.permissions && user.permissions.length > 0) ? user.permissions : (roleInfo ? roleInfo.permissions : [])
    };
  }

  // Поиск пользователя по ID
  static async findById(id) {
    const numId = Number(id);
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.telegram_id, u.last_login, u.created_at, COALESCE(u.permissions, r.permissions, \'[]\'::jsonb) as permissions FROM users u LEFT JOIN roles r ON u.role = r.name WHERE u.id = $1',
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
      permissions: (user.permissions && user.permissions.length > 0) ? user.permissions : (roleInfo ? roleInfo.permissions : [])
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

  // Создание нового пользователя с поддержкой прав (разрешенных страниц)
  static async create({ username, password, fullName, role = 'viewer', permissions = [], telegramId = null }) {
    const cleanUsername = String(username).trim().toLowerCase();
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);
    const userPermissions = Array.isArray(permissions) ? permissions : [];

    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          `INSERT INTO users (username, password_hash, full_name, role, permissions, telegram_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id, username, full_name, role, permissions, is_active, telegram_id, created_at`,
          [cleanUsername, passwordHash, fullName || cleanUsername, role, JSON.stringify(userPermissions), telegramId ? String(telegramId) : null]
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
      permissions: userPermissions,
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
      permissions: newUser.permissions,
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

  // Список всех пользователей с их правами
  static async getAllUsers() {
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'SELECT u.id, u.username, u.full_name, u.role, COALESCE(u.permissions, r.permissions, \'[]\'::jsonb) as permissions, u.is_active, u.telegram_id, u.last_login, u.created_at FROM users u LEFT JOIN roles r ON u.role = r.name ORDER BY u.id ASC'
        );
        return res.rows;
      } catch (e) {
        console.error('Ошибка getAllUsers в PG:', e.message);
      }
    }

    return inMemoryStore.users.map(u => {
      const roleInfo = inMemoryStore.roles.find(r => r.name === u.role);
      return {
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        role: u.role,
        permissions: (u.permissions && u.permissions.length > 0) ? u.permissions : (roleInfo ? roleInfo.permissions : []),
        is_active: u.is_active,
        telegram_id: u.telegram_id,
        last_login: u.last_login,
        created_at: u.created_at
      };
    });
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

  // Обновление прав (разрешенных страниц) пользователя
  static async updateUserPermissions(userId, permissions) {
    const userPermissions = Array.isArray(permissions) ? permissions : [];
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'UPDATE users SET permissions = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING id, username, role, permissions',
          [JSON.stringify(userPermissions), Number(userId)]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка updateUserPermissions в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => u.id === Number(userId));
    if (user) {
      user.permissions = userPermissions;
      return { id: user.id, username: user.username, role: user.role, permissions: user.permissions };
    }
    return null;
  }

  // Активация / деактивация пользователя
  static async setUserActive(userId, isActive) {
    if (isPgConnected() && pool) {
      try {
        const res = await pool.query(
          'UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, role, is_active',
          [isActive, Number(userId)]
        );
        return res.rows[0] || null;
      } catch (e) {
        console.error('Ошибка setUserActive в PG:', e.message);
      }
    }

    const user = inMemoryStore.users.find(u => u.id === Number(userId));
    if (user) {
      user.is_active = isActive;
      return { id: user.id, username: user.username, role: user.role, is_active: user.is_active };
    }
    return null;
  }

  // Удаление пользователя
  static async deleteUser(userId) {
    const numId = Number(userId);
    if (isPgConnected() && pool) {
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [numId]);
        return true;
      } catch (e) {
        console.error('Ошибка deleteUser в PG:', e.message);
      }
    }

    const index = inMemoryStore.users.findIndex(u => u.id === numId);
    if (index !== -1) {
      inMemoryStore.users.splice(index, 1);
      return true;
    }
    return false;
  }

  // Проверка совпадения пароля
  static async comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  }
}

module.exports = UserModel;
