const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { chat, insights } = require('../controllers/aiController');

/**
 * POST /api/ai/chat
 * Multi-turn Gemini conversation with dashboard context.
 * Body: { messages: [{role, content}], metrics?, selectedRegion?, period? }
 */
router.post('/chat', authenticateToken, chat);

/**
 * POST /api/ai/insights
 * One-shot AI analysis of dashboard metrics.
 * Body: { metrics, question? }
 */
router.post('/insights', authenticateToken, insights);

module.exports = router;
