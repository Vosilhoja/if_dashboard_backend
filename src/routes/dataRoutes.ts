const express = require('express');
const router = express.Router();
const config = require('../config');
const { dashboardLimiter, dashboardRefreshLimiter } = require('../middleware/rateLimiter');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated,
  getSyncStatus,
  synchronizeSheet,
  getAutoRefreshSettings,
  setAutoRefreshSettings,
  searchSheetRecords,
  getCachedSheetRows,
  getRowChangeHistory,
  getCallDate,
  getMainRegistrationDate,
} = require('../services/googleSheets');
const { parseSheetDate } = require('../utils/dateUtils');
const { getAnalyticsData } = require('../services/analyticsService');
const { synchronizeSheets } = require('../services/googleSheets');

router.post('/sync', authenticateToken, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    return res.status(200).json(await synchronizeSheets());
  } catch (error) {
    next(error);
  }
});

router.get('/sync/status', authenticateToken, dashboardLimiter, (req, res) => {
  return res.status(200).json(getSyncStatus());
});

router.post('/sync/status', authenticateToken, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    const { triggerSync } = require('../services/googleSheets');
    const result = await triggerSync();
    return res.status(200).json({ 
      message: 'Синхронизация запущена',
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

router.post('/sheets/:type/sync', authenticateToken, dashboardRefreshLimiter, async (req, res, next) => {
  try {
    return res.status(200).json(await synchronizeSheet(req.params.type));
  } catch (error) {
    next(error);
  }
});

router.get('/settings', authenticateToken, dashboardLimiter, (req, res) => {
  return res.status(200).json({ autoRefresh: getAutoRefreshSettings() });
});

router.put('/settings', authenticateToken, authorizeRoles('super_admin', 'admin'), (req, res, next) => {
  try {
    const intervalMinutes = req.body?.autoRefresh?.intervalMinutes ?? req.body?.intervalMinutes;
    return res.status(200).json({ autoRefresh: setAutoRefreshSettings(intervalMinutes) });
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

// Search only matching records in the selected cached sheets. This endpoint
// deliberately returns records, not a paginated/full-table payload.
router.get('/search', authenticateToken, dashboardLimiter, async (req, res, next) => {
  try {
    const sheets = String(req.query.sheets || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const query = req.query.q || req.query.query || req.query.phone || req.query.id || '';
    return res.status(200).json(await searchSheetRecords({
      query,
      sheets,
      limit: req.query.limit,
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/heatmap', authenticateToken, dashboardLimiter, (req, res) => {
  const startDate = String(req.query.startDate || '');
  const endDate = String(req.query.endDate || '');
  const buckets = {};
  for (const sheet of ['numbers', 'main', 'eskiz']) {
    for (const row of getCachedSheetRows(sheet)) {
      const raw = sheet === 'main' ? getMainRegistrationDate(row) : getCallDate(row);
      const date = parseSheetDate(raw);
      if (!date || Number.isNaN(date.getTime())) continue;
      const localParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
      const part = (type) => localParts.find((item) => item.type === type)?.value || '';
      const day = `${part('year')}-${part('month')}-${part('day')}`;
      if ((startDate && day < startDate) || (endDate && day > endDate)) continue;
      const hour = Number(part('hour'));
      const key = `${day} ${String(hour).padStart(2, '0')}:00`;
      if (!buckets[key]) buckets[key] = { day, hour, calls: 0, registrations: 0, errors: 0 };
      if (sheet === 'numbers') buckets[key].calls += 1;
      if (sheet === 'main') buckets[key].registrations += 1;
      if (sheet === 'eskiz') buckets[key].errors += Object.values(row).some((v) => /error|ошиб|failed|fail/i.test(String(v))) ? 1 : 0;
    }
  }
  res.json({ points: Object.values(buckets as any).sort((a: any, b: any) => `${a.day}${a.hour}`.localeCompare(`${b.day}${b.hour}`)) });
});

router.get('/history', authenticateToken, dashboardLimiter, (req, res) => {
  const sheet = String(req.query.sheet || 'numbers');
  const query = String(req.query.query || '').toLowerCase().trim();
  const changes = getRowChangeHistory(sheet, query);
  const rows = getCachedSheetRows(sheet);
  const matches = query ? rows.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(query))) : rows;
  res.json({
    sheet,
    query,
    total: matches.length,
    rows: matches.slice(-500).map((row, index) => ({ rowNumber: index + 2, ...row })),
    changes,
  });
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
    autoRefresh: getAutoRefreshSettings(),
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
    const parsedPage = Number.parseInt(String(req.query.page || '1'), 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const isExport = req.query.export === 'true';
    const parsedPageSize = Number.parseInt(String(req.query.pageSize || '25'), 10);
    const requestedPageSize = Number.isFinite(parsedPageSize) && parsedPageSize >= 10
      ? parsedPageSize
      : 25;
    const pageSize = Math.min(isExport ? 100000 : 500, requestedPageSize);
    const search = (req.query.search || '').trim();
    const refresh = req.query.refresh === 'true' || req.query.fresh === 'true';
    const sortBy = String(req.query.sortBy || '');
    const sortDirection = req.query.sortDirection === 'desc' ? 'desc' : 'asc';
    const filterColumn = String(req.query.filterColumn || '');
    const filterValue = String(req.query.filterValue || '');
    const filterOptionsColumn = String(req.query.filterOptionsColumn || '');
    const filterValues = String(req.query.filterValues || '')
      .split('|')
      .filter(Boolean);
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');

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
      filterValues,
      filterOptionsColumn,
      startDate,
      endDate,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
