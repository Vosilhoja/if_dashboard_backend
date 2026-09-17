const express = require('express');
const router = express.Router();
const config = require('../config');
const { dashboardLimiter, dashboardRefreshLimiter } = require('../middleware/rateLimiter');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated
} = require('../services/googleSheets');
const { getAnalyticsData } = require('../services/analyticsService');
const { synchronizeSheets } = require('../services/googleSheets');

router.post('/sync', authenticateToken, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    return res.status(200).json(await synchronizeSheets());
  } catch (error) {
    next(error);
  }
});

router.post('/sheets/:type/full-reload', authenticateToken, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    const { reloadSheetFully } = require('../services/googleSheets');
    return res.status(200).json(await reloadSheetFully(req.params.type));
  } catch (error) {
    next(error);
  }
});

router.get('/sheets/:type/connection', authenticateToken, dashboardLimiter, async (req, res, next) => {
  try {
    const { checkSheetConnection } = require('../services/googleSheets');
    return res.status(200).json(await checkSheetConnection(req.params.type));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/data
 * Возвращает реальные посчитанные метрики DashboardMetrics из Google Sheets
 * Query params: startDate, endDate, refresh/fresh, anomalyThreshold
 */
router.get('/', authenticateToken, dashboardLimiter, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    const {
      startDate,
      endDate,
      refresh,
      fresh,
      anomalyThreshold,
      attemptFilter,
      attemptRegion,
      attemptStatus
    } = req.query;
    const metrics = await calculateDashboardMetrics({
      startDate,
      endDate,
      refresh: refresh === 'true' || fresh === 'true',
      anomalyThreshold,
      attemptFilter,
      attemptRegion,
      attemptStatus
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
router.get('/period', authenticateToken, dashboardLimiter, async (req, res, next) => {
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
router.get('/analytics', authenticateToken, dashboardLimiter, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    const { startDate, endDate, refresh, fresh } = req.query;
    const analytics = await getAnalyticsData({
      startDate,
      endDate,
      refresh: refresh === 'true' || fresh === 'true'
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
  const surveyAttemptsId = config.google.sheetSurveyAttempts;

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
    {
      key: 'survey_attempts',
      name: 'survey_attempts',
      title: 'Попытки прохождения опроса',
      url: `https://docs.google.com/spreadsheets/d/${surveyAttemptsId}`,
      sheetId: surveyAttemptsId,
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
router.get('/sheets/:type', authenticateToken, dashboardLimiter, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    const { type } = req.params;
    if (req.query.summary === 'true') {
      const summary = await require('../services/googleSheets').getSheetSummary(
        type,
        req.query.fresh === 'true' || req.query.refresh === 'true'
      );
      return res.status(200).json(summary);
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const isExport = req.query.export === 'true';
    const requestedPageSize = Math.max(10, parseInt(req.query.pageSize || '25', 10));
    const pageSize = Math.min(isExport ? 100000 : 500, requestedPageSize);
    const search = (req.query.search || '').trim();
    const refresh = req.query.refresh === 'true' || req.query.fresh === 'true';
    const sortBy = String(req.query.sortBy || '');
    const sortDirection = req.query.sortDirection === 'desc' ? 'desc' : 'asc';
    const filterColumn = String(req.query.filterColumn || '');
    const filterValue = String(req.query.filterValue || '');

    const data = await getSheetPaginated(
      type,
      page,
      pageSize,
      search,
      refresh,
      sortBy,
      sortDirection,
      filterColumn,
      filterValue,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
