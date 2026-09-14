/**
 * src/routes/statsRoutes.js
 * Aggregated stats endpoints — weekly, monthly, summary.
 * All heavy computation happens here on the backend; the frontend
 * only receives ready-to-render numbers.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { fetchAllRowsForSheet } = require('../services/googleSheets');
const { parseSheetDate, formatDateToISO, isDateInRange } = require('../utils/dateUtils');
const {
  isDeclinedStatus,
  isLinkSentStatus,
  STATUS_CONFIG,
} = require('../utils/statusMatcher');

// ─── helpers ────────────────────────────────────────────────────
function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday as first day
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isoWeekLabel(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function monthLabel(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ─── counters ────────────────────────────────────────────────────
function countNumbersRows(rows, startDate, endDate) {
  let calls = 0;
  let declined = 0;
  let linkSent = 0;

  for (const row of rows) {
    const dateStr = row['Дата (формат xx.xx.xxxx)'] || row['Дата'] || row['date'];
    const d = parseSheetDate(dateStr);
    if (!isDateInRange(d, startDate, endDate)) continue;

    calls++;
    const comment = (row['Коментарий'] || '').trim();
    if (isDeclinedStatus(comment, STATUS_CONFIG.declined)) declined++;
    if (isLinkSentStatus(comment, STATUS_CONFIG.linkSent)) linkSent++;
  }

  return { calls, declined, linkSent };
}

function countMainRows(rows, startDate, endDate) {
  let count = 0;
  for (const row of rows) {
    const dateStr = row['Дата создания'] || row['date'] || row['Дата'];
    const d = parseSheetDate(dateStr);
    if (isDateInRange(d, startDate, endDate)) count++;
  }
  return count;
}

function countEskizRows(rows, startDate, endDate) {
  let count = 0;
  for (const row of rows) {
    const dateStr = row['Дата'] || row['Отправлено в'] || row['date'];
    const status = (row['Статус'] || '').trim().toUpperCase();
    const d = parseSheetDate(dateStr);
    if (isDateInRange(d, startDate, endDate) && (status === 'DELIVERED' || status === 'ACCEPTED')) {
      count++;
    }
  }
  return count;
}

// ─── loaders (reuse Google Sheets cache) ─────────────────────────
async function loadSheets() {
  const [numbersRows, mainRows, eskizRows] = await Promise.all([
    fetchAllRowsForSheet('numbers').catch(() => []),
    fetchAllRowsForSheet('main').catch(() => []),
    fetchAllRowsForSheet('eskiz').catch(() => []),
  ]);
  return { numbersRows, mainRows, eskizRows };
}

// ─────────────────────────────────────────────────────────────────
// GET /api/stats/weekly
// Query: weeks=12 (default 12 past weeks)
// Returns: array of { weekStart, calls, declined, registered, sms }
// ─────────────────────────────────────────────────────────────────
router.get('/weekly', authenticateToken, async (req, res, next) => {
  try {
    const weeksCount = Math.min(52, Math.max(1, parseInt(req.query.weeks || '12', 10)));
    const { numbersRows, mainRows, eskizRows } = await loadSheets();

    const today = new Date();
    const thisWeekMonday = startOfWeek(today);
    const results = [];

    for (let w = weeksCount - 1; w >= 0; w--) {
      const weekStart = addDays(thisWeekMonday, -w * 7);
      const weekEnd   = addDays(weekStart, 6);
      const startStr  = formatDateToISO(weekStart);
      const endStr    = formatDateToISO(weekEnd);

      const { calls, declined, linkSent } = countNumbersRows(numbersRows, startStr, endStr);
      const registered = countMainRows(mainRows, startStr, endStr);
      const sms = countEskizRows(eskizRows, startStr, endStr);

      results.push({
        weekStart: startStr,
        weekEnd: endStr,
        label: `${isoWeekLabel(weekStart)}`,
        calls,
        declined,
        linkSent,
        registered,
        sms,
        callToSmsRate: calls > 0 ? +((linkSent / calls) * 100).toFixed(1) : 0,
        smsToRegRate:  sms  > 0 ? +((registered / sms) * 100).toFixed(1) : 0,
      });
    }

    return res.status(200).json({
      weeks: results,
      count: results.length,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/stats/monthly
// Query: months=12 (default 12 past months)
// Returns: array of { month, calls, declined, registered, sms }
// ─────────────────────────────────────────────────────────────────
router.get('/monthly', authenticateToken, async (req, res, next) => {
  try {
    const monthsCount = Math.min(36, Math.max(1, parseInt(req.query.months || '12', 10)));
    const { numbersRows, mainRows, eskizRows } = await loadSheets();

    const today = new Date();
    const results = [];

    for (let m = monthsCount - 1; m >= 0; m--) {
      const d = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const startStr = formatDateToISO(d);
      const endDate  = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const endStr   = formatDateToISO(endDate);

      const { calls, declined, linkSent } = countNumbersRows(numbersRows, startStr, endStr);
      const registered = countMainRows(mainRows, startStr, endStr);
      const sms = countEskizRows(eskizRows, startStr, endStr);

      results.push({
        month: monthLabel(d),
        monthStart: startStr,
        monthEnd: endStr,
        calls,
        declined,
        linkSent,
        registered,
        sms,
        callToSmsRate: calls > 0 ? +((linkSent / calls) * 100).toFixed(1) : 0,
        smsToRegRate:  sms  > 0 ? +((registered / sms) * 100).toFixed(1) : 0,
      });
    }

    return res.status(200).json({
      months: results,
      count: results.length,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/stats/summary
// Query: from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns: single period summary object
// ─────────────────────────────────────────────────────────────────
router.get('/summary', authenticateToken, async (req, res, next) => {
  try {
    const from = req.query.from || '';
    const to   = req.query.to   || '';

    const { numbersRows, mainRows, eskizRows } = await loadSheets();

    const { calls, declined, linkSent } = countNumbersRows(numbersRows, from, to);
    const registered = countMainRows(mainRows, from, to);
    const sms = countEskizRows(eskizRows, from, to);

    return res.status(200).json({
      period: { from, to },
      calls,
      declined,
      linkSent,
      registered,
      sms,
      callToSmsRate: calls > 0 ? +((linkSent / calls) * 100).toFixed(1) : 0,
      smsToRegRate:  sms  > 0 ? +((registered / sms) * 100).toFixed(1) : 0,
      endToEndRate:  calls > 0 ? +((registered / calls) * 100).toFixed(1) : 0,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
