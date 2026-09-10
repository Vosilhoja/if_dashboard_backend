const express = require('express');
const router = express.Router();
const config = require('../config');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated
} = require('../services/googleSheets');
const { getAnalyticsData } = require('../services/analyticsService');

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
 * GET /api/data/analytics
 * Демографическая аналитика и агрегаты (пол, возраст, регионы, образования)
 */
router.get('/analytics', authenticateToken, async (req, res, next) => {
  try {
    const { startDate, endDate, refresh } = req.query;
    const analytics = await getAnalyticsData({
      startDate,
      endDate,
      refresh: refresh === 'true'
    });
    return res.status(200).json(analytics);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/data/settings-info
 * Метаданные и ссылки на таблицы
 */
router.get('/settings-info', authenticateToken, (req, res) => {
  const mainId = config.google.sheetMain;
  const numbersId = config.google.sheetNumbers;
  const eskizId = config.google.sheetEskiz;
  const notCompletedId = config.google.sheetNotCompleted;

  const statusSettingsUrl = `https://docs.google.com/spreadsheets/d/${numbersId}#gid=538596832`;

  const sheets = [
    {
      key: 'main',
      name: 'main_base',
      title: 'Основная база респондентов',
      url: `https://docs.google.com/spreadsheets/d/${mainId}`,
      sheetId: mainId,
    },
    {
      key: 'numbers',
      name: 'numbers',
      title: 'Звонки службы поддержки',
      url: `https://docs.google.com/spreadsheets/d/${numbersId}`,
      sheetId: numbersId,
    },
    {
      key: 'eskiz',
      name: 'eskiz',
      title: 'SMS шлюз Eskiz',
      url: `https://docs.google.com/spreadsheets/d/${eskizId}`,
      sheetId: eskizId,
    },
    {
      key: 'not_completed',
      name: 'not_completed',
      title: 'Не завершившие регистрацию',
      url: `https://docs.google.com/spreadsheets/d/${notCompletedId}`,
      sheetId: notCompletedId,
    },
  ];

  return res.status(200).json({
    settingsUrl: statusSettingsUrl,
    sheets,
  });
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
