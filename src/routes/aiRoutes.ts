const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimiter');
const { chat, insights, history, clearHistory } = require('../controllers/aiController');

router.get('/history', authenticateToken, history);
router.delete('/history', authenticateToken, clearHistory);

/**
 * POST /api/ai/chat
 * Multi-turn Gemini conversation with dashboard context.
 * Body: { messages: [{role, content}], metrics?, selectedRegion?, period? }
 */
router.post('/chat', authenticateToken, aiLimiter, chat);

/**
 * POST /api/ai/insights
 * One-shot AI analysis of dashboard metrics.
 * Body: { metrics, question? }
 */
router.post('/insights', authenticateToken, aiLimiter, insights);

module.exports = router;
