const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const config = require('../config');
const UserModel = require('../models/User');
const { listManagedBots, createManagedBot, updateManagedBot, deleteManagedBot } = require('../services/telegramBotStore');
const { startTelegramBot, stopTelegramBot, getTelegramRuntimeStatus } = require('../bot/telegramBot');
const router = express.Router();

// Get Telegram bot configurations (super_admin only)
router.get('/telegram', authenticateToken, authorizeRoles('super_admin'), async (req, res) => {
  try {
    const bots = config.telegram.bots || [];
    const runtime = getTelegramRuntimeStatus();
    const envBots = bots.map(bot => ({
      id: bot.id,
      token: bot.token ? `${bot.token.slice(0, 8)}...${bot.token.slice(-4)}` : '',
      userId: bot.userId,
      allowedIds: bot.allowedIds,
      source: 'env',
      status: runtime.find((item) => String(item.id) === String(bot.id))?.status || 'configured',
      features: config.telegram.features,
    }));
    const managed = await listManagedBots();
    return res.json({
      bots: [
        ...envBots,
        ...managed.map((bot) => ({
          id: bot.id,
          name: bot.name,
          token: bot.tokenMask,
          chatId: bot.chat_id,
          allowedIds: bot.allowedIds,
          source: 'database',
          status: runtime.find((item) => String(item.id) === String(bot.id))?.status || (bot.is_active ? 'configured' : 'stopped'),
          isActive: bot.is_active,
          enabledFeatures: bot.enabledFeatures,
          createdAt: bot.created_at,
        })),
      ],
      runtime,
    });
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
router.post('/telegram', authenticateToken, authorizeRoles('super_admin'), async (req, res) => {
  try {
    const { name, token, chatId, allowedIds, enabledFeatures } = req.body || {};
    if (!token || !String(token).trim()) {
      return res.status(400).json({ error: 'Укажите токен бота из @BotFather' });
    }
    const check = await fetch(`https://api.telegram.org/bot${encodeURIComponent(String(token).trim())}/getMe`);
    const payload = await check.json();
    if (!check.ok || !payload.ok) return res.status(400).json({ error: payload.description || 'Telegram token не прошёл проверку' });
    const bot = await createManagedBot({ name: name || payload.result?.username || 'Telegram bot', token: String(token).trim(), chatId, allowedIds, enabledFeatures });
    const runtimeBot = await startTelegramBot({
      id: bot.id,
      token: String(token).trim(),
      userId: bot.chatId,
      allowedIds: bot.allowedIds,
      enabledFeatures: bot.enabledFeatures,
    });
    return res.status(201).json({ bot: { ...bot, token: bot.tokenMask, username: payload.result?.username, status: runtimeBot ? 'starting' : 'error' } });
  } catch (error) {
    console.error('[Settings Routes] Error creating Telegram bot:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.patch('/telegram/:id', authenticateToken, authorizeRoles('super_admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid bot ID' });
    const current = (await listManagedBots()).find((bot) => Number(bot.id) === id);
    if (!current) return res.status(404).json({ error: 'Управляемый бот не найден' });
    const patch = req.body || {};
    const updated = await updateManagedBot(id, patch);
    if (patch.isActive === false || updated?.is_active === false) await stopTelegramBot(id);
    if (patch.isActive === true || (updated?.is_active && !getTelegramRuntimeStatus().some((item) => Number(item.id) === id && item.status === 'running'))) {
      await startTelegramBot({ id, token: current.token, userId: updated.chat_id, allowedIds: updated.allowedIds, enabledFeatures: updated.enabledFeatures });
    }
    return res.json({ bot: updated });
  } catch (error) {
    console.error('[Settings Routes] Error updating Telegram bot:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/telegram/:id', authenticateToken, authorizeRoles('super_admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await stopTelegramBot(id);
    if (!await deleteManagedBot(id)) return res.status(404).json({ error: 'Управляемый бот не найден' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('[Settings Routes] Error deleting Telegram bot:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Test Telegram bot (super_admin only)
router.post('/telegram/:id/test', authenticateToken, authorizeRoles('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const botId = parseInt(id, 10);
    
    if (isNaN(botId)) {
      return res.status(400).json({ error: 'Invalid bot ID' });
    }
    
    const envBot = (config.telegram.bots || []).find((item) => item.id === botId);
    const managedBot = (await listManagedBots()).find((item) => Number(item.id) === botId);
    const bot = envBot || (managedBot && { ...managedBot, userId: managedBot.chat_id, token: managedBot.token });
    if (!bot?.token) return res.status(404).json({ error: 'Бот не найден в конфигурации' });
    try {
      const telegramResponse = await fetch(`https://api.telegram.org/bot${bot.token}/getMe`);
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
    } catch (error) {
      return res.status(502).json({ error: `Не удалось проверить Telegram API: ${error.message}` });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
