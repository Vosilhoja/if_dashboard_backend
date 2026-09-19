const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const config = require('../config');
const UserModel = require('../models/User');
const router = express.Router();

// Get Telegram bot configurations (super_admin only)
router.get('/telegram', authenticateToken, authorizeRoles('super_admin'), (req, res) => {
  try {
    const bots = config.telegram.bots || [];
    const maskedBots = bots.map(bot => ({
      id: bot.id,
      token: bot.token ? `${bot.token.slice(0, 8)}...${bot.token.slice(-4)}` : '',
      userId: bot.userId,
      allowedIds: bot.allowedIds,
      status: 'configured',
      features: config.telegram.features,
    }));
    
    return res.json({ bots: maskedBots });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/telegram/capabilities', authenticateToken, authorizeRoles('super_admin'), async (req, res) => {
  try {
    const users = await UserModel.getAllUsers();
    return res.json({
      features: config.telegram.features,
      roles: users.reduce((result, user) => {
        const permissions = Array.isArray(user.permissions) ? user.permissions : [];
        result[user.role] = config.telegram.features
          .filter((feature) => user.role === 'super_admin' || permissions.includes('*') || permissions.includes(feature.key))
          .map((feature) => feature.key);
        return result;
      }, {}),
      linkedUsers: users.filter((user) => user.telegram_id).map((user) => ({
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        telegramId: user.telegram_id,
        isActive: user.is_active,
      })),
    });
  } catch (error) {
    console.error('[Settings Routes] Error getting Telegram capabilities:', error);
    return res.status(500).json({ error: 'Failed to get Telegram capabilities' });
  }
});

// Add new Telegram bot configuration (super_admin only)
router.post('/telegram', authenticateToken, authorizeRoles('super_admin'), (req, res) => {
  try {
    const { id, token, userId } = req.body || {};
    
    if (!id || !token || !userId) {
      return res.status(400).json({ error: 'Missing required fields: id, token, userId' });
    }
    
    return res.status(410).json({
      error: 'Токены не сохраняются через веб-панель. Добавьте TELEGRAM_TOKEN_N и TELEGRAM_USER_ID_N в защищённые переменные Railway, затем перезапустите сервис.',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Test Telegram bot (super_admin only)
router.post('/telegram/:id/test', authenticateToken, authorizeRoles('super_admin'), (req, res) => {
  try {
    const { id } = req.params;
    const botId = parseInt(id, 10);
    
    if (isNaN(botId)) {
      return res.status(400).json({ error: 'Invalid bot ID' });
    }
    
    const bot = (config.telegram.bots || []).find((item) => item.id === botId);
    if (!bot?.token) return res.status(404).json({ error: 'Бот не найден в конфигурации' });
    return fetch(`https://api.telegram.org/bot${bot.token}/getMe`)
      .then(async (telegramResponse) => {
        const payload = await telegramResponse.json();
        if (!telegramResponse.ok || !payload.ok) {
          return res.status(502).json({ error: payload.description || 'Telegram API недоступен' });
        }
        const chatId = String(bot.userId || '').trim();
        if (!/^-?\d+$/.test(chatId)) {
          return res.status(400).json({ error: 'Для тестовой отправки не настроен корректный TELEGRAM_USER_ID_N' });
        }
        const sendResponse = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: 'Test' }),
        });
        const sendPayload = await sendResponse.json();
        if (!sendResponse.ok || !sendPayload.ok) {
          return res.status(502).json({ error: sendPayload.description || 'Telegram не доставил тестовое сообщение' });
        }
        return res.json({
          ok: true,
          message: `Сообщение Test отправлено в Telegram пользователю ${chatId}`,
          bot: { id: payload.result?.id, username: payload.result?.username },
        });
      })
      .catch((error) => res.status(502).json({ error: `Не удалось проверить Telegram API: ${error.message}` }));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
