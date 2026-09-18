const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { pool, isPgConnected } = require('../db');
const { getSheetsCacheHealth } = require('../services/googleSheets');
const Redis = require('ioredis');
const config = require('../config');
const router = express.Router();

async function timed(name, check) {
  const started = Date.now();
  try { const details = await check(); return { name, status: 'ok', latencyMs: Date.now() - started, ...details }; }
  catch (error) { return { name, status: 'error', latencyMs: Date.now() - started, error: error.message }; }
}
router.get('/health', authenticateToken, async (req, res) => {
  const services = [];
  services.push({ name: 'process', status: 'ok', latencyMs: 0, uptimeSec: Math.round(process.uptime()), memory: process.memoryUsage() });
  services.push(await timed('postgresql', async () => { if (!isPgConnected() || !pool) throw new Error('not configured or unavailable'); await pool.query('SELECT 1'); return {}; }));
  services.push(await timed('redis', async () => { if (!process.env.REDIS_URL) return { status: 'disabled' }; const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 }); await client.ping(); await client.quit(); return {}; }));
  const sheets = getSheetsCacheHealth();
  services.push({ name: 'googleSheets', status: sheets.sheets.some((s) => s.available) ? 'ok' : (sheets.configured ? 'degraded' : 'disabled'), latencyMs: 0, ...sheets });
  services.push({ name: 'telegram', status: config.telegram.bots && config.telegram.bots.length > 0 ? 'configured' : (config.telegram.botToken ? 'configured' : 'disabled'), latencyMs: 0, bots: config.telegram.bots || [] });
  const failed = services.some((service) => service.status === 'error');
  const criticalFailed = services.some((service) =>
    service.status === 'error' &&
    service.name !== 'postgresql' &&
    service.name !== 'redis'
  );
  res.status(criticalFailed ? 503 : 200).json({
    status: failed ? (criticalFailed ? 'down' : 'degraded') : 'ok',
    timestamp: new Date().toISOString(),
    services,
  });
});

// Get Telegram bot configurations (super_admin only)
router.get('/telegram/bots', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (user.rows[0]?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied. Super admin only.' });
    }

    const bots = config.telegram.bots || [];
    const maskedBots = bots.map(bot => ({
      id: bot.id,
      token: bot.token ? `${bot.token.slice(0, 8)}...${bot.token.slice(-4)}` : '',
      userId: bot.userId,
      allowedIds: bot.allowedIds,
    }));

    res.json({ bots: maskedBots });
  } catch (error) {
    console.error('[System Routes] Error getting telegram bots:', error);
    res.status(500).json({ error: 'Failed to get telegram bot configurations' });
  }
});
module.exports = router;
