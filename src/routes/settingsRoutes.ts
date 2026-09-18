const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const config = require('../config');
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
      status: 'active',
    }));
    
    return res.json({ bots: maskedBots });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Add new Telegram bot configuration (super_admin only)
router.post('/telegram', authenticateToken, authorizeRoles('super_admin'), (req, res) => {
  try {
    const { id, token, userId } = req.body || {};
    
    if (!id || !token || !userId) {
      return res.status(400).json({ error: 'Missing required fields: id, token, userId' });
    }
    
    // Note: This is a stub - actual configuration happens via Railway environment variables
    // This endpoint validates the format and returns success
    return res.status(201).json({
      message: 'Bot configuration validated. Add TELEGRAM_TOKEN_ and TELEGRAM_USER_ID_ to Railway environment variables.',
      bot: {
        id,
        token: `${token.slice(0, 8)}...${token.slice(-4)}`,
        userId,
        status: 'pending',
      }
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
    
    // Note: This is a stub - actual testing would require Telegram API integration
    return res.json({
      message: 'Bot test not implemented yet. Use Railway environment variables to configure bots.',
      ok: true,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
