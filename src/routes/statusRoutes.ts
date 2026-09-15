const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { normalizedText, classifyStatus, getCached } = require('../services/statusClassifier');

router.get('/:normalizedText', authenticateToken, async (req, res, next) => {
  try {
    const text = decodeURIComponent(req.params.normalizedText || '');
    const normalized = normalizedText(text);
    const cached = await getCached(normalized);
    const result = cached || await classifyStatus(text, { category: 'unknown' });
    return res.json({
      category: result.category,
      confidence: result.confidence,
      source: result.source,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
