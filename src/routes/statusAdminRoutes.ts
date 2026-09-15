const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { adminStatusLimiter } = require('../middleware/rateLimiter');
const { enqueueUnmatchedClassification } = require('../services/statusClassificationQueue');
const { approveSuggestion } = require('../services/statusSuggestionService');

router.post('/classify-unmatched', authenticateToken, authorizeRoles('super_admin', 'admin'), adminStatusLimiter, async (req, res, next) => {
  try {
    return res.status(202).json(await enqueueUnmatchedClassification());
  } catch (error) {
    next(error);
  }
});

router.post('/suggested-phrases/:id/approve', authenticateToken, authorizeRoles('super_admin', 'admin'), async (req, res, next) => {
  try {
    const result = await approveSuggestion(req.params.id);
    if (!result) return res.status(404).json({ error: 'Предложение не найдено или уже обработано' });
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
