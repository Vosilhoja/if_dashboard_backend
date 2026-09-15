const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const config = require('../config');
const { parseSheetDate, isDateInRange } = require('../utils/dateUtils');
const { normalizePhoneWithDiagnostics, normalizePhone } = require('../utils/phoneUtils');
const {
  STATUS_CONFIG,
  isLinkSentStatus,
  isRepeatSentStatus,
  isDeclinedStatus,
  isAlreadyRegisteredStatus,
  isWrongPersonStatus
} = require('../utils/statusMatcher');

// Keep complete snapshots long enough to avoid repeatedly materializing all
// Google Sheets rows on a small production instance.
const CACHE_TTL_MS = 5 * 60 * 1000;
const BACKGROUND_REFRESH_MS = 5 * 60 * 1000;
const SHEET_REQUEST_RETRY_LIMIT = 4;
const SHEET_REQUEST_BACKOFF_BASE_MS = 1000;
const cache = {};
const inFlight = {};
let sheetReadQueue = Promise.resolve();
let backgroundRefreshInProgress = false;
const dashboardMetricsCache = new Map();
const dashboardMetricsInFlight = new Map();
const MAX_DASHBOARD_METRICS_CACHE_ENTRIES = 32;
const DASHBOARD_METRICS_CACHE_TTL_MS = 60 * 1000;
const MIN_FORCED_SHEET_REFRESH_MS = 60 * 1000;
let dashboardMetricsActive = 0;
const dashboardMetricsWaiters = [];
const MAX_DASHBOARD_METRICS_CONCURRENCY = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaExceededError(error) {
  const code = Number(error?.code ?? error?.status ?? error?.response?.status ?? 0);
  const message = String(error?.message || error || '');
  return code === 429 || /quota|rate limit|too many requests/i.test(message);
}

async function withSheetReadLock(task) {
  const queued = sheetReadQueue.then(() => task(), () => task());
  sheetReadQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function getJwtClient() {
  const email = config.google.clientEmail;
  let privateKey = config.google.privateKey;

  if (!email || !privateKey) {
    throw new Error('Отсутствуют GOOGLE_SERVICE_ACCOUNT_EMAIL или GOOGLE_PRIVATE_KEY в конфигурации сервера.');
  }

  if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
    privateKey = privateKey.slice(1, -1);
  }
  if (privateKey.startsWith("'") && privateKey.endsWith("'")) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\\n/g, '\n');

  return new JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function getSheetId(type) {
  let id = '';
  switch (type) {
    case 'main':
      id = config.google.sheetMain;
      break;
    case 'numbers':
    case 'numbers_repeat':
      id = config.google.sheetNumbers;
      break;
    case 'eskiz':
      id = config.google.sheetEskiz;
      break;
    case 'not_completed':
      id = config.google.sheetNotCompleted;
      break;
    case 'survey_attempts':
      id = config.google.sheetSurveyAttempts;
      break;
    default:
      throw new Error(`Неизвестный тип таблицы: "${type}"`);
  }

  if (!id) {
    throw new Error(`ID Google таблицы для типа "${type}" не настроен в .env.`);
  }
  return id;
}

async function fetchAllRowsForSheet(type, forceRefresh = false) {
  const cacheKey = `sheet_${type}`;
  const now = Date.now();

  if (forceRefresh && cache[cacheKey] &&
      now - cache[cacheKey].timestamp < MIN_FORCED_SHEET_REFRESH_MS) {
    return cache[cacheKey].data;
  }

  if (!forceRefresh && cache[cacheKey]) {
    const age = now - cache[cacheKey].timestamp;
    if (age < CACHE_TTL_MS) {
      return cache[cacheKey].data;
    }

    // Serve the last complete snapshot immediately and refresh it in the
    // background. The next page request never waits for Google Sheets.
    void refreshSheet(type);
    return cache[cacheKey].data;
  }

  if (inFlight[cacheKey]) {
    return inFlight[cacheKey];
  }

  inFlight[cacheKey] = (async () => {
    let attempt = 0;

    while (true) {
      try {
        return await withSheetReadLock(async () => {
          const auth = getJwtClient();
          const sheetId = getSheetId(type);
          const doc = new GoogleSpreadsheet(sheetId, auth);

          await doc.loadInfo();
          let sheet = doc.sheetsByIndex[0];
          if (type === 'numbers_repeat') {
            sheet = doc.sheetsByTitle['Повторные'] || doc.sheetsByTitle['повторные'] || doc.sheetsByIndex[1] || sheet;
          }
          if (!sheet) {
            throw new Error(`Лист не найден в документе Google Таблицы для "${type}"`);
          }

          await sheet.loadHeaderRow();
          let rawRows = await sheet.getRows();

          const data = rawRows.map((row) => {
            const obj = {};
            for (const h of sheet.headerValues || []) {
              obj[h] = row.get(h) ?? '';
            }
            return obj;
          });
          // Release google-spreadsheet row wrappers before storing the
          // normalized snapshot. This materially lowers the peak heap during
          // large-sheet refreshes.
          rawRows = null;

          console.log(`[GoogleSheets API] Успешно загружено ${data.length} строк для "${type}"`);
          cache[cacheKey] = { data, timestamp: Date.now() };
          return data;
        });
      } catch (err) {
        if (!isQuotaExceededError(err) || attempt >= SHEET_REQUEST_RETRY_LIMIT) {
          console.error(`[GoogleSheets API Error] Ошибка загрузки таблицы "${type}":`, {
            code: err.code || err.status,
            message: err.message || String(err),
          });
          throw err;
        }

        const delayMs = Math.min(30_000, SHEET_REQUEST_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * 500);
        attempt += 1;
        console.warn(`[GoogleSheets API] Квота Google Sheets исчерпана для "${type}". Повтор через ${Math.round(delayMs)}мс (попытка ${attempt}/${SHEET_REQUEST_RETRY_LIMIT})`);
        await sleep(delayMs);
      }
    }
  })();

  try {
    return await inFlight[cacheKey];
  } finally {
    delete inFlight[cacheKey];
  }
}

async function refreshSheet(type) {
  try {
    await fetchAllRowsForSheet(type, true);
  } catch (error) {
    console.error(`[Data refresh error] ${type}:`, error.message || error);
  }
}

function clearSheetCache() {
  for (const k of Object.keys(cache)) {
    delete cache[k];
  }
  dashboardMetricsCache.clear();
}

function getDashboardMetricsCacheKey(query) {
  return JSON.stringify({
    startDate: query.startDate || '',
    endDate: query.endDate || '',
    anomalyThreshold: query.anomalyThreshold || '',
    attemptFilter: query.attemptFilter || 'all',
    attemptRegion: query.attemptRegion || 'all',
    attemptStatus: query.attemptStatus || 'all',
  });
}

async function withDashboardMetricsSlot(task) {
  if (dashboardMetricsActive >= MAX_DASHBOARD_METRICS_CONCURRENCY) {
    await new Promise((resolve) => dashboardMetricsWaiters.push(resolve));
  }

  dashboardMetricsActive += 1;
  try {
    return await task();
  } finally {
    dashboardMetricsActive -= 1;
    dashboardMetricsWaiters.shift()?.();
  }
}

async function prewarmDataCache() {
  if (String(process.env.DATA_PREWARM_ENABLED || '').toLowerCase() !== 'true') {
    console.log('[Data prewarm] Отключен по умолчанию; таблицы загрузятся по первому запросу и будут закэшированы.');
    return;
  }

  const types = ['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts'];
  const timeoutMs = Number(process.env.DATA_PREWARM_TIMEOUT_MS || 10_000);
  let timeoutId;
  const prewarm = Promise.allSettled(types.map((type) => fetchAllRowsForSheet(type, true)));
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([prewarm, timeout]);
  clearTimeout(timeoutId);

  if (outcome === 'timeout') {
    console.warn(`[Data prewarm] Таймаут ${timeoutMs} мс; сервер продолжит запуск, обновление данных выполнится в фоне.`);
    return;
  }

  const results = outcome;
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    console.warn(`[Data prewarm] Не удалось загрузить ${failed.length} таблиц; API повторит запрос при обращении.`);
  }
}

function startBackgroundDataRefresh() {
  if (String(process.env.DATA_BACKGROUND_REFRESH_ENABLED || '').toLowerCase() !== 'true') {
    console.log('[Data refresh] Фоновое обновление отключено по умолчанию; используйте ручной refresh или включите DATA_BACKGROUND_REFRESH_ENABLED=true.');
    return null;
  }

  const timer = setInterval(() => {
    if (backgroundRefreshInProgress) return;
    backgroundRefreshInProgress = true;

    // Refresh one sheet at a time to avoid holding old and newly materialized
    // snapshots for every source simultaneously.
    void (async () => {
      try {
        for (const type of ['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts']) {
          await refreshSheet(type);
        }
      } finally {
        backgroundRefreshInProgress = false;
      }
    })();
  }, BACKGROUND_REFRESH_MS);
  timer.unref?.();
  return timer;
}

const SURVEY_REGION_NAMES = {
  1: 'Республика Каракалпакстан',
  2: 'Андижанская область',
  3: 'Бухарская область',
  4: 'Джизакская область',
  5: 'Кашкадарьинская область',
  6: 'Навоийская область',
  7: 'Наманганская область',
  8: 'Самаркандская область',
  9: 'Сурхандарьинская область',
  10: 'Сырдарьинская область',
  11: 'Ташкентская область',
  12: 'Ферганская область',
  13: 'Хорезмская область',
  14: 'г. Ташкент',
};

function normalizeSurveyRegion(value) {
  const raw = String(value ?? '').trim();
  const code = Number(raw);
  if (Number.isInteger(code) && SURVEY_REGION_NAMES[code]) return SURVEY_REGION_NAMES[code];
  return raw || 'Не указан';
}

function surveyWeekStart(year, week) {
  const date = new Date(Date.UTC(year, 0, 1));
  date.setUTCDate(date.getUTCDate() + (week - 1) * 7);
  return date;
}

function isSurveyColumnInRange(column, startDate, endDate) {
  const match = String(column).match(/^(20\d{2})_w(\d+)(?:_|$)/i);
  if (!match || (!startDate && !endDate)) return Boolean(match);
  const weekDate = match ? surveyWeekStart(Number(match[1]), Number(match[2])) : null;
  if (!weekDate) return false;
  return isDateInRange(weekDate, startDate, endDate);
}

function calculateSurveyAttemptMetrics(
  rows,
  startDate,
  endDate,
  attemptFilter = '',
  attemptRegion = 'all',
  attemptStatus = 'all'
) {
  const users = new Map();
  const columns = rows.length > 0
    ? Object.keys(rows[0]).filter((key) => /^\d{4}_w\d+(?:_|$)/i.test(key))
    : [];
  const selectedColumns = columns.filter((column) => isSurveyColumnInRange(column, startDate, endDate));
  const normalizedRegionFilter = String(attemptRegion || 'all').trim().toLowerCase();
  const normalizedStatusFilter = String(attemptStatus || 'all').trim().toLowerCase();

  for (const row of rows) {
    const phone = normalizePhone(row.Phone || row.phone || row['Телефон']);
    const id = String(row.id || row.ID || row['ID пользователя'] || '').trim();
    const identity = phone || id;
    if (!identity) continue;

    const region = normalizeSurveyRegion(row.Region || row.region || row['Регион']);
    if (
      normalizedRegionFilter !== 'all' &&
      region.toLowerCase() !== normalizedRegionFilter
    ) {
      continue;
    }

    const user = users.get(identity) || { attempts: 0, region, statusCounts: {} };
    let rowAttempts = 0;
    for (const column of selectedColumns) {
      const status = String(row[column] ?? '').trim();
      if (!status || status.toLowerCase() === 'created') continue;
      const normalizedStatus = status.toLowerCase();
      if (
        normalizedStatusFilter !== 'all' &&
        normalizedStatus !== normalizedStatusFilter
      ) {
        continue;
      }

      rowAttempts++;
      user.statusCounts[normalizedStatus] = (user.statusCounts[normalizedStatus] || 0) + 1;
    }

    if (rowAttempts === 0) continue;

    user.attempts += rowAttempts;
    if (user.region === 'Не указан' && region !== 'Не указан') user.region = region;
    users.set(identity, user);
  }

  const matchesFilter = (attempts) => {
    if (!attemptFilter || attemptFilter === 'all') return true;
    if (attemptFilter === '4+') return attempts >= 4;
    const exact = Number(attemptFilter);
    return Number.isInteger(exact) && exact > 0 ? attempts === exact : true;
  };

  const filteredUsers = [...users.values()].filter((user) => matchesFilter(user.attempts));
  const regionUsers = new Map();
  for (const user of filteredUsers) {
    const region = regionUsers.get(user.region) || { people: 0, attempts: 0 };
    region.people++;
    region.attempts += user.attempts;
    regionUsers.set(user.region, region);
  }

  const distribution = { '1': 0, '2': 0, '3': 0, '4+': 0 };
  for (const user of filteredUsers) {
    const bucket = user.attempts >= 4 ? '4+' : String(user.attempts);
    distribution[bucket] = (distribution[bucket] || 0) + 1;
  }

  const statusCounts = {};
  for (const user of filteredUsers) {
    for (const [status, count] of Object.entries(user.statusCounts || {})) {
      statusCounts[status] = (statusCounts[status] || 0) + count;
    }
  }

  return {
    people: filteredUsers.length,
    attempts: filteredUsers.reduce((sum, user) => sum + user.attempts, 0),
    repeatPeople: filteredUsers.filter((user) => user.attempts > 1).length,
    distribution,
    regions: [...regionUsers.entries()]
      .map(([region, values]) => ({ region, people: values.people, attempts: values.attempts }))
      .sort((a, b) => b.people - a.people || b.attempts - a.attempts),
    statuses: Object.entries(statusCounts)
      .map(([status, count]) => ({ status, count: Number(count) }))
      .sort((a, b) => b.count - a.count),
    columns: selectedColumns,
    selectedRegion: attemptRegion,
    selectedStatus: attemptStatus,
  };
}

/**
 * Расчет всех операционных метрик (интерфейс DashboardMetrics)
 */
async function calculateDashboardMetrics(query: any = {}) {
  const {
    startDate = '',
    endDate = '',
    refresh = false,
    anomalyThreshold: customThreshold,
    attemptFilter = 'all',
    attemptRegion = 'all',
    attemptStatus = 'all',
  } = query;

  const cacheKey = getDashboardMetricsCacheKey(query);
  const cachedMetrics = dashboardMetricsCache.get(cacheKey);
  if (!refresh && cachedMetrics && Date.now() - cachedMetrics.timestamp < DASHBOARD_METRICS_CACHE_TTL_MS) {
    return cachedMetrics.data;
  }
  if (dashboardMetricsInFlight.has(cacheKey)) {
    return dashboardMetricsInFlight.get(cacheKey);
  }

  const calculation = withDashboardMetricsSlot(async () => {
    let mainRows = [];
  let numbersRows = [];
  let eskizRows = [];
  let notCompletedRows = [];
  let surveyAttemptRows = [];

  let mainError = null;
  let numbersError = null;
  let eskizError = null;
  let notCompletedError = null;
  let surveyAttemptsError = null;

  await Promise.all([
    fetchAllRowsForSheet('main', refresh)
      .then((res) => { mainRows = res; })
      .catch((err) => {
        console.error('Ошибка загрузки main_base:', err.message);
        mainError = err.message || 'Ошибка загрузки main_base';
      }),
    fetchAllRowsForSheet('numbers', refresh)
      .then((res) => { numbersRows = res; })
      .catch((err) => {
        console.error('Ошибка загрузки numbers:', err.message);
        numbersError = err.message || 'Ошибка загрузки numbers';
      }),
    fetchAllRowsForSheet('eskiz', refresh)
      .then((res) => { eskizRows = res; })
      .catch((err) => {
        console.error('Ошибка загрузки eskiz:', err.message);
        eskizError = err.message || 'Ошибка загрузки eskiz';
      }),
    fetchAllRowsForSheet('not_completed', refresh)
      .then((res) => { notCompletedRows = res; })
      .catch((err) => {
        console.error('Ошибка загрузки not_completed:', err.message);
        notCompletedError = err.message || 'Ошибка загрузки not_completed';
      }),
    fetchAllRowsForSheet('survey_attempts', refresh)
      .then((res) => { surveyAttemptRows = res; })
      .catch((err) => {
        console.error('Ошибка загрузки survey_attempts:', err.message);
        surveyAttemptsError = err.message || 'Ошибка загрузки survey_attempts';
      }),
  ]);

  const surveyAttemptDetails = surveyAttemptsError
    ? null
    : calculateSurveyAttemptMetrics(
      surveyAttemptRows,
      startDate,
      endDate,
      attemptFilter,
      attemptRegion,
      attemptStatus
    );

  // 1. Быстрый поиск номеров main_base и сбор телефонной диагностики
  const phoneDiagnostics = {
    corrupted: 0,
    truncated: 0,
    invalid: 0,
    foreign: 0,
  };

  if (!mainError) {
    for (const row of mainRows) {
      const rawP = row['Phone'] || row['phone'] || row['Телефон'];
      const diag = normalizePhoneWithDiagnostics(rawP);
      if (diag.status === 'corrupted_scientific') phoneDiagnostics.corrupted++;
      else if (diag.status === 'truncated') phoneDiagnostics.truncated++;
      else if (diag.status === 'invalid') phoneDiagnostics.invalid++;
      else if (diag.status === 'foreign') phoneDiagnostics.foreign++;

    }
  }

  // Атрибуция «пришёл через поддержку»: регистрация должна произойти
  // в день звонка или позже. Регистрация до звонка считается отдельным
  // случаем «уже был зарегистрирован», а не результатом поддержки.
  const mainRegistrationDateByPhone = new Map();
  if (!mainError) {
    for (const row of mainRows) {
      const dateStr = row['Дата создания'] || row['date'] || row['Дата'];
      const registrationDate = parseSheetDate(dateStr);
      const phone = normalizePhoneWithDiagnostics(
        row['Phone'] || row['phone'] || row['Телефон']
      ).normalized;
      if (!phone || !registrationDate) continue;

      const previousDate = mainRegistrationDateByPhone.get(phone);
      if (!previousDate || registrationDate < previousDate) {
        mainRegistrationDateByPhone.set(phone, registrationDate);
      }
    }
  }

  // Метрика 1: Звонки за период
  let callsCountVal = 0;
  const numbersInPeriod = [];
  if (!numbersError) {
    for (const row of numbersRows) {
      const rawP = row['Телефон'] || row['Phone'];
      const diag = normalizePhoneWithDiagnostics(rawP);
      if (diag.status === 'corrupted_scientific') phoneDiagnostics.corrupted++;
      else if (diag.status === 'truncated') phoneDiagnostics.truncated++;
      else if (diag.status === 'invalid') phoneDiagnostics.invalid++;
      else if (diag.status === 'foreign') phoneDiagnostics.foreign++;

      const dateStr = row['Дата (формат xx.xx.xxxx)'] || row['Дата'] || row['date'];
      const d = parseSheetDate(dateStr);
      if (isDateInRange(d, startDate, endDate)) {
        callsCountVal++;
        numbersInPeriod.push(row);
      }
    }
  }

  // Метрика 2: SMS верификация
  let eskizCount = 0;
  if (!eskizError) {
    for (const row of eskizRows) {
      const dateStr = row['Дата'] || row['Отправлено в'] || row['date'];
      const status = (row['Статус'] || '').trim().toUpperCase();
      const d = parseSheetDate(dateStr);
      if (isDateInRange(d, startDate, endDate) && (status === 'DELIVERED' || status === 'ACCEPTED')) {
        eskizCount++;
      }
    }
  }

  let numbersLinkSentCount = 0;
  let declinedVal = 0;
  let alreadyRegisteredVal = 0;
  let wrongPersonVal = 0;

  if (!numbersError) {
    for (const row of numbersInPeriod) {
      const comment = (row['Коментарий'] || '').trim();

      if (isLinkSentStatus(comment, STATUS_CONFIG.linkSent)) {
        numbersLinkSentCount++;
      }
      if (isDeclinedStatus(comment, STATUS_CONFIG.declined)) {
        declinedVal++;
      }
      if (isAlreadyRegisteredStatus(comment, STATUS_CONFIG.alreadyRegistered)) {
        alreadyRegisteredVal++;
      }
      if (isWrongPersonStatus(comment, STATUS_CONFIG.wrongPerson)) {
        wrongPersonVal++;
      }
    }
  }

  const smsRatio = eskizCount > 0 ? numbersLinkSentCount / eskizCount : 1;
  const smsRatioPercent = (smsRatio * 100).toFixed(1);
  const smsIsAlert = eskizCount > 0 && smsRatio < STATUS_CONFIG.thresholds.smsMatchPercentage;

  // Метрика 3: Зарегистрировано в панели (main_base)
  let registeredMainVal = 0;
  if (!mainError) {
    for (const row of mainRows) {
      const dateStr = row['Дата создания'] || row['date'] || row['Дата'];
      const d = parseSheetDate(dateStr);
      if (isDateInRange(d, startDate, endDate)) {
        registeredMainVal++;
      }
    }
  }

  // Метрика 4: Зарегистрировано после контакта с поддержкой
  let totalSupportMatchesCount = 0;
  const matchedPhonesSupport = new Set();
  if (!numbersError && !mainError) {
    for (const row of numbersInPeriod) {
      const pDiag = normalizePhoneWithDiagnostics(row['Телефон'] || row['Phone']);
      const p = pDiag.normalized;
      const callDate = parseSheetDate(
        row['Дата (формат xx.xx.xxxx)'] || row['Дата'] || row['date']
      );
      const registrationDate = p ? mainRegistrationDateByPhone.get(p) : undefined;
      if (p && callDate && registrationDate && registrationDate >= callDate) {
        totalSupportMatchesCount++;
        matchedPhonesSupport.add(p);
      }
    }
  }

  // Метрика 5: Зарегистрировано после повторной ссылки
  let repeatStatusesFoundInPeriod = 0;
  let totalRepeatMatchesCount = 0;
  const matchedRepeatPhones = new Set();
  if (!numbersError && !mainError) {
    for (const row of numbersInPeriod) {
      const comment = (row['Коментарий'] || '').trim();
      if (isRepeatSentStatus(comment, STATUS_CONFIG.repeatSent)) {
        repeatStatusesFoundInPeriod++;
        const pDiag = normalizePhoneWithDiagnostics(row['Телефон'] || row['Phone']);
        const p = pDiag.normalized;
        const callDate = parseSheetDate(
          row['Дата (формат xx.xx.xxxx)'] || row['Дата'] || row['date']
        );
        const registrationDate = p ? mainRegistrationDateByPhone.get(p) : undefined;
        if (p && callDate && registrationDate && registrationDate >= callDate) {
          totalRepeatMatchesCount++;
          matchedRepeatPhones.add(p);
        }
      }
    }
  }

  // Метрика 9: Не завершили регистрацию
  let notCompletedInPeriodCount = 0;
  if (!notCompletedError) {
    for (const row of notCompletedRows) {
      const status = (row['Статус'] || row['status'] || '').trim().toLowerCase();
      if (status && !status.includes('not completed') && !status.includes('не заверш')) {
        continue;
      }

      const dateStr = row['Дата создания'] || row['Start date'] || row['Дата'] || row['Creation date'] || '';
      const d = parseSheetDate(dateStr);
      if (isDateInRange(d, startDate, endDate)) {
        notCompletedInPeriodCount++;
      }
    }
  }

  // Аномалии за последние 4 недели
  let anomalyData = undefined;
  const pStart = parseSheetDate(startDate);
  const pEnd = parseSheetDate(endDate);

  if (pStart && pEnd && !numbersError) {
    const activeDaysOfWeek = new Set();
    const cur = new Date(pStart);
    while (cur <= pEnd) {
      activeDaysOfWeek.add(cur.getDay());
      cur.setDate(cur.getDate() + 1);
    }

    const weekCounts = [];
    for (let w = 1; w <= 4; w++) {
      const wStart = new Date(pStart);
      wStart.setDate(wStart.getDate() - w * 7);
      const wEnd = new Date(pEnd);
      wEnd.setDate(wEnd.getDate() - w * 7);

      let wCalls = 0;
      let wDeclined = 0;

      for (const row of numbersRows) {
        const dateStr = row['Дата (формат xx.xx.xxxx)'] || row['Дата'] || row['date'];
        const d = parseSheetDate(dateStr);
        if (d && d >= wStart && d <= wEnd && activeDaysOfWeek.has(d.getDay())) {
          wCalls++;
          const comment = (row['Коментарий'] || '').trim();
          if (isDeclinedStatus(comment, STATUS_CONFIG.declined)) {
            wDeclined++;
          }
        }
      }
      weekCounts.push({ calls: wCalls, declined: wDeclined });
    }

    const avgCalls = Math.round(
      weekCounts.reduce((acc, curr) => acc + curr.calls, 0) / (weekCounts.length || 1)
    );
    const avgDeclined = Math.round(
      weekCounts.reduce((acc, curr) => acc + curr.declined, 0) / (weekCounts.length || 1)
    );

    const parsedThreshold = parseInt(customThreshold || '30', 10);
    const anomalyThreshold = isNaN(parsedThreshold) || parsedThreshold <= 0 ? 30 : parsedThreshold;

    const calcAnomaly = (current, baseline) => {
      if (baseline === 0) {
        const delta = current > 0 ? 100 : 0;
        const result = {
          current,
          baseline4WeeksAvg: baseline,
          deltaPercent: delta,
          isAnomaly: current > 5,
          direction: current > 0 ? 'up' : 'normal',
        };
        return result;
      }

      const deltaPercent = Math.round(((current - baseline) / baseline) * 100);
      const absDelta = Math.abs(deltaPercent);
      const isAnomaly = absDelta >= anomalyThreshold;
      const direction = deltaPercent > 0 ? 'up' : deltaPercent < 0 ? 'down' : 'normal';
      const result = {
        current,
        baseline4WeeksAvg: baseline,
        deltaPercent,
        isAnomaly,
        direction,
      };
      return result;
    };

    anomalyData = {
      callsAnomaly: calcAnomaly(callsCountVal, avgCalls),
      declinedAnomaly: calcAnomaly(declinedVal, avgDeclined),
    };
  }

  const result = {
    callsCount: {
      value: numbersError ? '—' : callsCountVal,
      subtext: numbersError ? undefined : `Всего звонков за выбранный период`,
      error: numbersError || undefined,
    },
    smsSentVerification: {
      value: (eskizError || numbersError) ? '—' : `${numbersLinkSentCount} / ${eskizCount}`,
      ratio: smsRatio,
      isAlert: smsIsAlert,
      statusText: (eskizError || numbersError)
        ? undefined
        : eskizCount === 0
        ? 'Нет SMS за период'
        : `Соотношение: ${smsRatioPercent}% ${smsIsAlert ? '⚠️ Ниже 90%' : '✅ В норме'}`,
      subtext: `Найдено в numbers: ${numbersLinkSentCount} | В eskiz (DELIVERED+ACCEPTED): ${eskizCount}`,
      error: (eskizError || numbersError) || undefined,
    },
    registeredMainBase: {
      value: mainError ? '—' : registeredMainVal,
      subtext: mainError ? undefined : `Новых пользователей в main_base за период`,
      error: mainError || undefined,
    },
    registeredFromSupport: {
      value: (numbersError || mainError) ? '—' : matchedPhonesSupport.size,
      subtext: (numbersError || mainError)
        ? undefined
        : `Звонок в выбранном периоде, регистрация в этот день или позже (совпадений: ${totalSupportMatchesCount})`,
      error: (numbersError || mainError) || undefined,
    },
    registeredAfterRepeat: {
      value: (numbersError || mainError)
        ? '—'
        : repeatStatusesFoundInPeriod === 0
        ? 0
        : matchedRepeatPhones.size,
      subtext: (numbersError || mainError)
        ? undefined
        : repeatStatusesFoundInPeriod === 0
        ? '0 (статусов повтора не найдено в данных)'
        : `Повторный контакт до регистрации (совпадений: ${totalRepeatMatchesCount})`,
      error: (numbersError || mainError) || undefined,
    },
    declinedCount: {
      value: numbersError ? '—' : declinedVal,
      subtext: numbersError ? undefined : `Отказов, нет времени, бросили трубку за период`,
      error: numbersError || undefined,
    },
    alreadyRegisteredCount: {
      value: numbersError ? '—' : alreadyRegisteredVal,
      subtext: numbersError ? undefined : `Уже зарегистрированы через бот (bot bor и др.)`,
      error: numbersError || undefined,
    },
    wrongPersonCount: {
      value: numbersError ? '—' : wrongPersonVal,
      subtext: numbersError ? undefined : `Не тот номер, другой человек, второй номер`,
      error: numbersError || undefined,
    },
    notCompletedCount: {
      value: notCompletedError ? '—' : notCompletedInPeriodCount,
      subtext: notCompletedError ? undefined : `Не завершили регистрацию за период`,
      error: notCompletedError || undefined,
    },
    surveyAttemptsPeople: {
      value: surveyAttemptsError ? '—' : surveyAttemptDetails.people,
      subtext: surveyAttemptsError
        ? undefined
        : `Уникальных людей с попыткой; фильтр: ${attemptFilter === 'all' ? 'все' : attemptFilter}`,
      error: surveyAttemptsError || undefined,
    },
    surveyAttemptsTotal: {
      value: surveyAttemptsError ? '—' : surveyAttemptDetails.attempts,
      subtext: surveyAttemptsError ? undefined : 'Всего попыток по недельным статусам',
      error: surveyAttemptsError || undefined,
    },
    surveyAttemptsRepeatPeople: {
      value: surveyAttemptsError ? '—' : surveyAttemptDetails.repeatPeople,
      subtext: surveyAttemptsError ? undefined : 'Людей с двумя и более попытками',
      error: surveyAttemptsError || undefined,
    },
    surveyAttemptDetails,
    phoneDiagnostics,
    period: {
      startDate,
      endDate,
    },
    totalRows: {
      main: mainRows.length,
      numbers: numbersRows.length,
      eskiz: eskizRows.length,
      not_completed: notCompletedRows.length,
      survey_attempts: surveyAttemptRows.length,
    },
    anomalyData,
    cachedAt: new Date().toISOString(),
  };

    dashboardMetricsCache.delete(cacheKey);
    dashboardMetricsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    while (dashboardMetricsCache.size > MAX_DASHBOARD_METRICS_CACHE_ENTRIES) {
      dashboardMetricsCache.delete(dashboardMetricsCache.keys().next().value);
    }
    return result;
  });

  dashboardMetricsInFlight.set(cacheKey, calculation);
  try {
    return await calculation;
  } finally {
    if (dashboardMetricsInFlight.get(cacheKey) === calculation) {
      dashboardMetricsInFlight.delete(cacheKey);
    }
  }
}

/**
 * Получение строк для детального отчета по периоду (GET /api/data/period)
 */
async function getPeriodDetails(startDate = '', endDate = '') {
  const [numbersRows, notCompletedRows] = await Promise.all([
    fetchAllRowsForSheet('numbers').catch((err) => {
      console.error('Failed to load numbers for period details:', err);
      return [];
    }),
    fetchAllRowsForSheet('not_completed').catch((err) => {
      console.error('Failed to load not_completed for period details:', err);
      return [];
    }),
  ]);

  const calls = numbersRows.filter((row) => {
    const dateStr = row['Дата (формат xx.xx.xxxx)'] || row['Дата'] || row['date'];
    const d = parseSheetDate(dateStr);
    return isDateInRange(d, startDate, endDate);
  });

  const notCompleted = notCompletedRows.filter((row) => {
    const status = (row['Статус'] || row['status'] || '').trim().toLowerCase();
    if (status && !status.includes('not completed') && !status.includes('не заверш')) {
      return false;
    }
    const dateStr =
      row['Дата создания'] ||
      row['Start date'] ||
      row['Дата'] ||
      row['Creation date'] ||
      '';
    const d = parseSheetDate(dateStr);
    return isDateInRange(d, startDate, endDate);
  });

  return {
    startDate,
    endDate,
    totalCalls: calls.length,
    totalNotCompleted: notCompleted.length,
    calls,
    notCompleted,
    cachedAt: new Date().toISOString(),
  };
}

/**
 * Пагинация и поиск по сырым таблицам
 */
async function getSheetPaginated(type, page = 1, pageSize = 25, search = '', forceRefresh = false) {
  const allRows = await fetchAllRowsForSheet(type, forceRefresh);
  let headers = [];
  if (allRows.length > 0) {
    headers = Object.keys(allRows[0]);
  }

  let filteredRows = allRows;
  if (search) {
    const searchNorm = normalizePhone(search);
    const searchLower = search.toLowerCase();

    filteredRows = allRows.filter((row) => {
      const phone = row['Phone'] || row['Телефон'] || row['Номер телефона'] || '';
      if (phone) {
        const normPhone = normalizePhone(phone);
        if (normPhone.includes(searchNorm) || phone.includes(search)) {
          return true;
        }
      }

      for (const [, v] of Object.entries(row)) {
        if (String(v).toLowerCase().includes(searchLower)) {
          return true;
        }
      }
      return false;
    });
  }

  const total = filteredRows.length;
  const totalPages = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  const paginatedRows = filteredRows.slice(offset, offset + pageSize);

  return {
    type,
    page,
    pageSize,
    total,
    totalPages,
    headers,
    rows: paginatedRows,
    cachedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchAllRowsForSheet,
  clearSheetCache,
  prewarmDataCache,
  startBackgroundDataRefresh,
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated
};
