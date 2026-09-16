const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { adminStatusLimiter } = require('../middleware/rateLimiter');
const { enqueueUnmatchedClassification } = require('../services/statusClassificationQueue');
const { approveSuggestion, listPendingSuggestions, assignSuggestion } = require('../services/statusSuggestionService');
const {
  getEditableStatusCategories,
  updateLearnedPhrase,
  renameLearnedPhrase,
} = require('../utils/statusMatcher');

router.get('/statuses', authenticateToken, authorizeRoles('super_admin', 'admin'), (req, res) => {
  return res.json({ categories: getEditableStatusCategories() });
});

router.get('/statuses/suggestions', authenticateToken, authorizeRoles('super_admin', 'admin'), async (req, res, next) => {
  try {
    return res.json({ suggestions: await listPendingSuggestions() });
  } catch (error) {
    next(error);
  }
});

router.post('/statuses/phrases', authenticateToken, authorizeRoles('super_admin', 'admin'), async (req, res, next) => {
  try {
    const { categoryId, phrase } = req.body || {};
    return res.status(201).json({
      category: await updateLearnedPhrase(categoryId, phrase, 'add'),
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/statuses/phrases', authenticateToken, authorizeRoles('super_admin', 'admin'), async (req, res, next) => {
  try {
    const { categoryId, phrase } = req.body || {};
    return res.json({
      category: await updateLearnedPhrase(categoryId, phrase, 'remove'),
    });
  } catch (error) {
    next(error);
  }
});

router.put('/statuses/phrases', authenticateToken, authorizeRoles('super_admin', 'admin'), async (req, res, next) => {
  try {
    const { categoryId, oldPhrase, newPhrase } = req.body || {};
    return res.json({
      category: await renameLearnedPhrase(categoryId, oldPhrase, newPhrase),
    });
  } catch (error) {
    next(error);
  }
});

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

router.post('/suggested-phrases/:id/assign', authenticateToken, authorizeRoles('super_admin', 'admin'), async (req, res, next) => {
  try {
    const result = await assignSuggestion(req.params.id, req.body?.category);
    if (!result) return res.status(404).json({ error: 'Предложение не найдено или уже обработано' });
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
