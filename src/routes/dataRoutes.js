const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated
} = require('../services/googleSheets');

/**
 * GET /api/data
 * Возвращает реальные посчитанные метрики DashboardMetrics из Google Sheets
 * Query params: startDate, endDate, refresh, anomalyThreshold
 */
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { startDate, endDate, refresh, anomalyThreshold } = req.query;
    const metrics = await calculateDashboardMetrics({
      startDate,
      endDate,
      refresh: refresh === 'true',
      anomalyThreshold
    });

    return res.status(200).json(metrics);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/data/period
 * Детальная выборка строк звонков и незавершивших регистрацию за период
 * Query params: start, end (или startDate, endDate)
 */
router.get('/period', authenticateToken, async (req, res, next) => {
  try {
    const startDate = req.query.start || req.query.startDate || '';
    const endDate = req.query.end || req.query.endDate || '';

    const details = await getPeriodDetails(startDate, endDate);
    return res.status(200).json(details);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/data/sheets/:type
 * Пагинация и поиск по сырым таблицам (main, numbers, eskiz, not_completed)
 */
router.get('/sheets/:type', authenticateToken, async (req, res, next) => {
  try {
    const { type } = req.params;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(500, Math.max(10, parseInt(req.query.pageSize || '25', 10)));
    const search = (req.query.search || '').trim();

    const data = await getSheetPaginated(type, page, pageSize, search);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
