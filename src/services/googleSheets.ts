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
// A metrics calculation keeps several large sheet snapshots alive while it
// builds phone/date indexes. Running two calculations concurrently can exceed
// Railway's memory limit with the production-sized sheets.
const MAX_DASHBOARD_METRICS_CONCURRENCY = 1;

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function getRowValue(row, aliases = [], matcher) {
  const keys = Object.keys(row || {});
  const aliasKeys = new Set(aliases.map(normalizeHeader));
  const exactKey = keys.find((key) => aliasKeys.has(normalizeHeader(key)));
  if (exactKey) return row[exactKey];
  const matchedKey = keys.find((key) => matcher && matcher(normalizeHeader(key), key));
  return matchedKey ? row[matchedKey] : '';
}

function getCallStatus(row) {
  const directStatus = String(getRowValue(
    row,
    ['Коментарий', 'Комментарий', 'Comment', 'Status comment', 'Результат звонка'],
    (key) => /(комментар|коментар|comment|результат|result|outcome)/.test(key)
      && !/(статусзвонка|callstatus)/.test(key)
  ) || '').trim();
  if (directStatus) return directStatus;

  const statusKey = Object.keys(row).find((key) => {
    const normalized = normalizeHeader(key);
    return (
      /(статус|status|итог|outcome|причин)/.test(normalized) &&
      !/(статусзвонка|callstatus|дата|date|время|time)/.test(normalized)
    );
  });
  return statusKey ? String(row[statusKey] || '').trim() : '';
}

function getCallDate(row) {
  const directDate = getRowValue(
    row,
    ['Дата (формат xx.xx.xxxx)', 'Дата звонка', 'Дата', 'Date', 'Call date'],
    (key) => /(дата|date|время|time)/.test(key)
      && !/(регистрац|регист|registration|register|создан|created)/.test(key)
  );
  if (directDate) return directDate;

  const dateKeys = Object.keys(row).filter((key) => /(дата|date|time|время)/.test(normalizeHeader(key)));
  const dateKey =
    dateKeys.find((key) => /(звон|call|обращ|контакт)/.test(normalizeHeader(key))) ||
    dateKeys.find((key) => !/(регистрац|регист|registration|register|создан|created)/.test(normalizeHeader(key))) ||
    dateKeys[0];
  return dateKey ? row[dateKey] : '';
}

function getPhone(row) {
  return getRowValue(row, ['Телефон', 'Phone', 'phone', 'Номер телефона'], (key) =>
    /(телефон|phone|номертелефона)/.test(key)
  );
}

function getPersonIdentity(row, fallbackPrefix) {
  const phone = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
  if (phone) return `phone:${phone}`;

  const userId = getRowValue(
    row,
    ['ID пользователя', 'Result id', 'ID', 'id', 'Результат ID'],
    (key) => /^(идпользователя|resultid|id|результатид)$/.test(key)
  );
  const normalizedId = String(userId || '').trim();
  return normalizedId ? `${fallbackPrefix}:id:${normalizedId}` : '';
}

function getMainRegistrationDate(row) {
  return getRowValue(row, ['Дата создания', 'Дата регистрации', 'Creation date', 'Registration date', 'Дата', 'Date'], (key) =>
    /(датасоздания|датарегистрац|дата.*заполн|дата.*создан|creationdate|registrationdate|registeredat|createdat)/.test(key)
      && !/(звон|call|контакт|обращ)/.test(key)
  );
}

function getMainRegistrationSource(row) {
  return getRowValue(
    row,
    ['Откуда пришёл пользователь', 'Источник', 'Source'],
    (key) => /(откуда.*приш|источник|source)/.test(key)
  );
}

function isBotRegistrationSource(source) {
  const value = String(source || '').toLowerCase();
  return /(bot|бот|telegram|телеграм|o'?zi|o`zi|сам(остоятельно)?|сайт(а|ом)?)/i.test(value);
}

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

    // Keep serving the last complete snapshot until the user explicitly
    // requests synchronization with refresh=true.
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
  console.log('[Data prewarm] Отключен: данные загружаются только при первом запросе или ручной синхронизации.');
}

function startBackgroundDataRefresh() {
  console.log('[Data refresh] Фоновое обновление отключено; используйте ручной refresh=true.');
  return null;
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
    const phone = normalizePhone(getPhone(row));
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
      const rawP = getPhone(row);
      const diag = normalizePhoneWithDiagnostics(rawP);
      if (diag.status === 'corrupted_scientific') phoneDiagnostics.corrupted++;
      else if (diag.status === 'truncated') phoneDiagnostics.truncated++;
      else if (diag.status === 'invalid') phoneDiagnostics.invalid++;
      else if (diag.status === 'foreign') phoneDiagnostics.foreign++;

    }
  }

  // Для связи звонков с регистрациями сохраняем все регистрации каждого
  // телефона: даты нужны для строгой метрики повторных звонков.
  const mainRegistrationsByPhone = new Map();
  const mainPhones = new Set();
  const mainHasNonBotRegistration = new Set();
  if (!mainError) {
    for (const row of mainRows) {
      const dateStr = getMainRegistrationDate(row);
      const registrationDate = parseSheetDate(dateStr);
      const phone = normalizePhoneWithDiagnostics(
        getPhone(row)
      ).normalized;
      if (!phone) continue;
      mainPhones.add(phone);
      if (!isBotRegistrationSource(getMainRegistrationSource(row))) {
        mainHasNonBotRegistration.add(phone);
      }
      if (!registrationDate) continue;

      const registrations = mainRegistrationsByPhone.get(phone) || [];
      registrations.push({
        date: registrationDate,
        fromBot: isBotRegistrationSource(getMainRegistrationSource(row)),
      });
      mainRegistrationsByPhone.set(phone, registrations);
    }
  }

  // Метрика 1: Звонки за период
  let callsCountVal = 0;
  const numbersInPeriod = [];
  if (!numbersError) {
    for (const row of numbersRows) {
      const rawP = getPhone(row);
      const diag = normalizePhoneWithDiagnostics(rawP);
      if (diag.status === 'corrupted_scientific') phoneDiagnostics.corrupted++;
      else if (diag.status === 'truncated') phoneDiagnostics.truncated++;
      else if (diag.status === 'invalid') phoneDiagnostics.invalid++;
      else if (diag.status === 'foreign') phoneDiagnostics.foreign++;

      const dateStr = getCallDate(row);
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
      const dateStr = getRowValue(row, ['Дата', 'Отправлено в', 'Date'], (key) =>
        /(дата|отправленов|date)/.test(key)
      );
      const status = String(getRowValue(row, ['Статус', 'Status'], (key) =>
        /^(статус|status)$/.test(key)
      ) || '').trim().toUpperCase();
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
      const comment = getCallStatus(row);

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

  // Метрика 3: Зарегистрировано в панели (main_base).
  // The source can contain duplicate rows for one participant.
  let registeredMainVal = 0;
  const registeredPeopleInPeriod = new Set();
  if (!mainError) {
    for (const row of mainRows) {
      const dateStr = getMainRegistrationDate(row);
      const d = parseSheetDate(dateStr);
      if (isDateInRange(d, startDate, endDate)) {
        const identity = getPersonIdentity(row, 'main');
        if (identity) registeredPeopleInPeriod.add(identity);
      }
    }
    registeredMainVal = registeredPeopleInPeriod.size;
  }

  // Метрика 4: Зарегистрировано после контакта с поддержкой
  const matchedPhonesSupport = new Set();
  const calledUniquePhones = new Set(
    numbersInPeriod
      .map((row) => normalizePhoneWithDiagnostics(getPhone(row)).normalized)
      .filter(Boolean)
  );
  if (!numbersError && !mainError) {
    for (const row of numbersInPeriod) {
      const pDiag = normalizePhoneWithDiagnostics(getPhone(row));
      const p = pDiag.normalized;
      const comment = getCallStatus(row);
      if (
        p &&
        mainPhones.has(p) &&
        mainHasNonBotRegistration.has(p) &&
        !isAlreadyRegisteredStatus(comment, STATUS_CONFIG.alreadyRegistered) &&
        !isWrongPersonStatus(comment, STATUS_CONFIG.wrongPerson)
      ) {
        matchedPhonesSupport.add(p);
      }
    }
  }

  // Метрика 5: Зарегистрировано после повторной ссылки
  let repeatStatusesFoundInPeriod = 0;
  const matchedRepeatPhones = new Set();
  const periodEnd = parseSheetDate(endDate);
  if (!numbersError && !mainError) {
    for (const row of numbersInPeriod) {
      const comment = getCallStatus(row);
      if (!isRepeatSentStatus(comment, STATUS_CONFIG.repeatSent)) continue;
      if (isAlreadyRegisteredStatus(comment, STATUS_CONFIG.alreadyRegistered)) continue;

      repeatStatusesFoundInPeriod++;
      const p = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
      const callDate = parseSheetDate(getCallDate(row));
      const registrations = p ? mainRegistrationsByPhone.get(p) || [] : [];
      const registration = registrations
        .filter((item) =>
          item.date >= callDate &&
          (!periodEnd || item.date <= periodEnd) &&
          !item.fromBot
        )
        .sort((a, b) => a.date - b.date)[0];
      if (p && callDate && registration) {
        matchedRepeatPhones.add(p);
      }
    }
  }

  // Метрика 9: Не завершили регистрацию
  const notCompletedPeopleInPeriod = new Set();
  if (!notCompletedError) {
    for (const row of notCompletedRows) {
      const status = String(getRowValue(row, ['Статус', 'Status'], (key) =>
        /^(статус|status)$/.test(key)
      ) || '').trim().toLowerCase();
      if (status && !status.includes('not completed') && !status.includes('не заверш')) {
        continue;
      }

      const dateStr = getRowValue(
        row,
        ['Дата создания', 'Start date', 'Дата', 'Creation date'],
        (key) => /(датасоздания|startdate|дата|creationdate)/.test(key)
      );
      const d = parseSheetDate(dateStr);
      if (isDateInRange(d, startDate, endDate)) {
        const identity = getPersonIdentity(row, 'not_completed');
        if (identity) notCompletedPeopleInPeriod.add(identity);
      }
    }
  }
  const notCompletedInPeriodCount = notCompletedPeopleInPeriod.size;

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
        const dateStr = getCallDate(row);
        const d = parseSheetDate(dateStr);
        if (d && d >= wStart && d <= wEnd && activeDaysOfWeek.has(d.getDay())) {
          wCalls++;
          const comment = getCallStatus(row);
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
      statusText: (numbersError || mainError || numbersInPeriod.length === 0)
        ? undefined
        : `Конверсия: ${((matchedPhonesSupport.size / (calledUniquePhones.size || 1)) * 100).toFixed(1)}%`,
      subtext: (numbersError || mainError)
        ? undefined
        : `Уникальные зарегистрированные пользователи из ${calledUniquePhones.size.toLocaleString('ru-RU')} номеров`,
      error: (numbersError || mainError) || undefined,
    },
    supportContactsCount: {
      value: numbersError ? '—' : numbersInPeriod.length,
      subtext: numbersError ? undefined : 'Всего звонков поддержки за выбранный период',
      error: numbersError || undefined,
    },
    registeredAfterRepeat: {
      value: (numbersError || mainError)
        ? '—'
        : repeatStatusesFoundInPeriod === 0
        ? 0
        : matchedRepeatPhones.size,
      statusText: (numbersError || mainError || repeatStatusesFoundInPeriod === 0)
        ? undefined
        : `Конверсия: ${((matchedRepeatPhones.size / repeatStatusesFoundInPeriod) * 100).toFixed(1)}%`,
      subtext: (numbersError || mainError)
        ? undefined
        : repeatStatusesFoundInPeriod === 0
        ? '0 (статусов повтора не найдено в данных)'
        : `Уникальные регистрации из ${repeatStatusesFoundInPeriod.toLocaleString('ru-RU')} повторных звонков`,
      error: (numbersError || mainError) || undefined,
    },
    repeatContactsCount: {
      value: numbersError ? '—' : repeatStatusesFoundInPeriod,
      subtext: numbersError
        ? undefined
        : `За период; регистраций после повторного звонка: ${matchedRepeatPhones.size.toLocaleString('ru-RU')}`,
      error: numbersError || undefined,
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
    const dateStr = getCallDate(row);
    const d = parseSheetDate(dateStr);
    return isDateInRange(d, startDate, endDate);
  });

  const notCompleted = notCompletedRows.filter((row) => {
    const status = String(getRowValue(row, ['Статус', 'Status'], (key) =>
      /^(статус|status)$/.test(key)
    ) || '').trim().toLowerCase();
    if (status && !status.includes('not completed') && !status.includes('не заверш')) {
      return false;
    }
    const dateStr = getRowValue(
      row,
      ['Дата создания', 'Start date', 'Дата', 'Creation date'],
      (key) => /(датасоздания|startdate|дата|creationdate)/.test(key)
    );
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
      const phone = getPhone(row);
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
  withDashboardMetricsSlot,
  prewarmDataCache,
  startBackgroundDataRefresh,
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated
};
