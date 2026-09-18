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
  services.push({ name: 'telegram', status: config.telegram.botToken ? 'configured' : 'disabled', latencyMs: 0 });
  const failed = services.some((service) => service.status === 'error');
  res.status(failed ? 503 : 200).json({ status: failed ? 'degraded' : 'ok', timestamp: new Date().toISOString(), services });
});
module.exports = router;
