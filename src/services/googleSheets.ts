const { fetchSheetRaw, fetchSheetDelta, rowsToObjects, getSheetMetadata } = require('./sheetsClient');
const config = require('../config');
const { parseSheetDate, isDateInRange } = require('../utils/dateUtils');
const { normalizePhoneWithDiagnostics, normalizePhone } = require('../utils/phoneUtils');
const Redis = require('ioredis');
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
const configuredRefreshInterval = parseInt(process.env.DATA_REFRESH_INTERVAL_MS || '', 10);
const BACKGROUND_REFRESH_MS =
  Number.isFinite(configuredRefreshInterval) && configuredRefreshInterval >= 0
    ? configuredRefreshInterval
    : 10 * 60 * 1000;
const SHEET_REQUEST_RETRY_LIMIT = 4;
const SHEET_REQUEST_BACKOFF_BASE_MS = 1000;
const cache = {};
const recordChangeHistory = [];
const inFlight = {};
const REDIS_CACHE_PREFIX = 'hurmo:sheetcache:';
const REDIS_CACHE_TTL_SEC = 24 * 60 * 60;
const redisCache = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null })
  : null;
let sheetReadQueue = Promise.resolve();
let backgroundRefreshInProgress = false;
let backgroundRefreshTimer = null;
let backgroundRefreshIntervalMs = BACKGROUND_REFRESH_MS;
const dashboardMetricsCache = new Map();
const dashboardMetricsInFlight = new Map();
const registrationClassificationCache = new Map();
const MAX_DASHBOARD_METRICS_CACHE_ENTRIES = 32;
const DASHBOARD_METRICS_CACHE_TTL_MS =
  parseInt(process.env.DASHBOARD_METRICS_CACHE_TTL_MS || '', 10) || 4 * 60 * 1000;
let dashboardMetricsActive = 0;
const dashboardMetricsWaiters = [];
let syncInFlight = null;
const syncProgress = {
  active: false,
  current: 0,
  total: 5,
  label: 'Готово',
  error: null,
  startedAt: null,
  completedAt: null,
};
// A metrics calculation keeps several large sheet snapshots alive while it
// builds phone/date indexes. Running two calculations concurrently can exceed
// Railway's memory limit with the production-sized sheets.
const MAX_DASHBOARD_METRICS_CONCURRENCY = 1;

async function persistSheetCache(type) {
  const entry = cache[`sheet_${type}`];
  if (!entry || !redisCache) return;
  try {
    await redisCache.set(
      REDIS_CACHE_PREFIX + type,
      JSON.stringify({
        data: entry.data,
        headers: entry.headers,
        sourceRowCount: entry.sourceRowCount,
        timestamp: entry.timestamp,
      }),
      'EX',
      REDIS_CACHE_TTL_SEC,
    );
  } catch (error) {
    console.warn(`[Redis persist] Не удалось сохранить кэш "${type}":`, error.message || error);
  }
}

async function restoreSheetCacheFromRedis() {
  if (!redisCache) return;
  const sheetTypes = ['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts'];
  await Promise.all(sheetTypes.map(async (type) => {
    try {
      const raw = await redisCache.get(REDIS_CACHE_PREFIX + type);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.data) || !Array.isArray(parsed.headers)) return;
      cache[`sheet_${type}`] = parsed;
      console.log(`[Redis restore] "${type}": ${parsed.data.length} строк восстановлено`);
    } catch (error) {
      console.warn(`[Redis restore] Не удалось восстановить "${type}":`, error.message || error);
    }
  }));
}

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

/**
 * The call outcome is stored in column D of the numbers sheet.
 * Row objects preserve the sheet header order, so index 3 is the
 * source-of-truth value immediately after a forced synchronization.
 */
function getColumnDText(row) {
  if (!row || typeof row !== 'object') return '';
  // 1. If explicit _columnD or _column3 exists
  if (row._columnD !== undefined) return String(row._columnD ?? '').trim().replace(/\s+/g, ' ');
  // 2. Direct named lookup for Column D headers
  const commentVal = row['Коментарий'] ?? row['Комментарий'] ?? row['comment'] ?? row['Comment'] ?? row['результат звонка'] ?? row['Результат звонка'];
  if (commentVal !== undefined && String(commentVal).trim()) {
    return String(commentVal).trim().replace(/\s+/g, ' ');
  }
  // 3. Fallback to index 3 in Object.values
  const value = Object.values(row)[3];
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function getCallStatus(row) {
  const columnDStatus = getColumnDText(row);
  if (columnDStatus) return columnDStatus;

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

function classifyRegistrationSource(source) {
  const value = String(source ?? '').trim().toLowerCase();
  if (!value) return null;
  return /(bot|бот|telegram|телеграм|o'?zi|o`zi|сам(остоятельно)?|сайт(а|ом)?)/i.test(value);
}

const mainDerivedCache = {
  timestamp: 0,
  phoneDiagnostics: null,
  registrationsByPhone: null,
  mainPhones: null,
  unknownSource: null,
};

function getMainDerived(mainRows, snapshotTimestamp) {
  if (mainDerivedCache.timestamp === snapshotTimestamp && mainDerivedCache.registrationsByPhone) {
    return mainDerivedCache;
  }
  const phoneDiagnostics = { corrupted: 0, truncated: 0, invalid: 0, foreign: 0 };
  const registrationsByPhone = new Map();
  const mainPhones = new Set();
  const unknownSource = new Set();

  for (const row of mainRows) {
    const diag = normalizePhoneWithDiagnostics(getPhone(row));
    if (diag.status === 'corrupted_scientific') phoneDiagnostics.corrupted++;
    else if (diag.status === 'truncated') phoneDiagnostics.truncated++;
    else if (diag.status === 'invalid') phoneDiagnostics.invalid++;
    else if (diag.status === 'foreign') phoneDiagnostics.foreign++;
    if (!diag.normalized) continue;
    mainPhones.add(diag.normalized);
    const sourceClass = classifyRegistrationSource(getMainRegistrationSource(row));
    if (sourceClass === null) unknownSource.add(diag.normalized);
    const date = parseSheetDate(getMainRegistrationDate(row));
    if (!date) continue;
    const registrations = registrationsByPhone.get(diag.normalized) || [];
    registrations.push({ date, fromBot: sourceClass === true, sourceUnknown: sourceClass === null });
    registrationsByPhone.set(diag.normalized, registrations);
  }

  mainDerivedCache.timestamp = snapshotTimestamp;
  mainDerivedCache.phoneDiagnostics = phoneDiagnostics;
  mainDerivedCache.registrationsByPhone = registrationsByPhone;
  mainDerivedCache.mainPhones = mainPhones;
  mainDerivedCache.unknownSource = unknownSource;
  return mainDerivedCache;
}

/**
 * Keeps the three registration outcomes mutually exclusive:
 * - support: a call was made and a non-bot registration happened in the
 *   selected period after that call;
 * - repeat: a repeat call was made and the registration happened after it;
 * - already registered: the operator explicitly marked the call as such.
 *
 * This is shared by dashboard metrics and raw tables so both surfaces show
 * the same people for the same date range.
 */
function buildRegistrationClassification(mainRows, numbersRows, startDate = '', endDate = '') {
  const numbersInPeriod = (startDate || endDate)
    ? numbersRows.filter((row) => isDateInRange(parseSheetDate(getCallDate(row)), startDate, endDate))
    : numbersRows;
  const periodEnd = parseSheetDate(endDate);
  const registrationsByPhone = new Map();
  const mainPhones = new Set();

  for (const row of mainRows) {
    const phone = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
    if (!phone) continue;
    mainPhones.add(phone);
    const registrationDate = parseSheetDate(getMainRegistrationDate(row));
    if (!registrationDate) continue;
    const sourceClass = classifyRegistrationSource(getMainRegistrationSource(row));
    const registrations = registrationsByPhone.get(phone) || [];
    registrations.push({
      date: registrationDate,
      fromBot: sourceClass === true,
    });
    registrationsByPhone.set(phone, registrations);
  }

  const alreadyRegisteredPhones = new Set();
  const repeatContactCount = numbersInPeriod.reduce((count, row) => {
    const comment = getCallStatus(row);
    if (isAlreadyRegisteredStatus(comment, STATUS_CONFIG.alreadyRegistered)) {
      const phone = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
      if (phone) alreadyRegisteredPhones.add(phone);
    }
    return count + (isRepeatSentStatus(comment, STATUS_CONFIG.repeatSent) ? 1 : 0);
  }, 0);

  const repeatPhones = new Set();
  for (const row of numbersInPeriod) {
    const comment = getCallStatus(row);
    if (!isRepeatSentStatus(comment, STATUS_CONFIG.repeatSent) ||
        isAlreadyRegisteredStatus(comment, STATUS_CONFIG.alreadyRegistered)) continue;
    const phone = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
    const callDate = parseSheetDate(getCallDate(row));
    const registration = (registrationsByPhone.get(phone) || [])
      .filter((item) =>
        !item.fromBot &&
        item.date >= (callDate || item.date) &&
        (!startDate || isDateInRange(item.date, startDate, endDate)) &&
        (!periodEnd || item.date <= periodEnd)
      )
      .sort((a, b) => a.date - b.date)[0];
    if (phone && registration) repeatPhones.add(phone);
  }

  const supportPhones = new Set();
  const calledPhones = new Set();
  for (const row of numbersInPeriod) {
    const phone = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
    if (!phone) continue;
    calledPhones.add(phone);
    const comment = getCallStatus(row);
    if (isAlreadyRegisteredStatus(comment, STATUS_CONFIG.alreadyRegistered) || repeatPhones.has(phone)) continue;
    const callDate = parseSheetDate(getCallDate(row));
    const registration = (registrationsByPhone.get(phone) || [])
      .filter((item) =>
        !item.fromBot &&
        item.date >= (callDate || item.date) &&
        (!startDate || isDateInRange(item.date, startDate, endDate)) &&
        (!periodEnd || item.date <= periodEnd)
      )
      .sort((a, b) => a.date - b.date)[0];
    if (registration) supportPhones.add(phone);
  }

  return {
    numbersInPeriod,
    mainPhones,
    supportPhones,
    repeatPhones,
    alreadyRegisteredPhones,
    repeatContactCount,
    calledPhones,
  };
}

function getCachedRegistrationClassification(mainRows, numbersRows, startDate = '', endDate = '') {
  const mainSnapshot = cache['sheet_main']?.timestamp || 0;
  const numbersSnapshot = cache['sheet_numbers']?.timestamp || 0;
  const key = `${mainSnapshot}:${numbersSnapshot}:${startDate}:${endDate}`;
  const cached = registrationClassificationCache.get(key);
  if (cached) return cached;

  const classification = buildRegistrationClassification(mainRows, numbersRows, startDate, endDate);
  registrationClassificationCache.set(key, classification);
  if (registrationClassificationCache.size > 16) {
    const oldestKey = registrationClassificationCache.keys().next().value;
    registrationClassificationCache.delete(oldestKey);
  }
  return classification;
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
    throw new Error(`Google Sheet ID not configured for type "${type}". Please set the appropriate environment variable (e.g., GOOGLE_SHEET_MAIN).`);
  }
  return id;
}

async function fetchAllRowsForSheet(type, forceRefresh = false) {
  const cacheKey = `sheet_${type}`;
  const now = Date.now();

  if (!forceRefresh && !cache[cacheKey]) {
    if (!inFlight[cacheKey]) {
      void fetchAllRowsForSheet(type, true);
    }
    const timeoutMs = 15_000;
    const waitForWarmup = inFlight[cacheKey] || Promise.reject(new Error(`Прогрев таблицы "${type}" не запущен`));
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(
        new Error(`Timeout waiting for sheet "${type}" to warm up. Please check your Google Sheet configuration and try again.`),
        { status: 503 },
      )), timeoutMs);
    });
    return Promise.race([waitForWarmup, timeout]);
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
        const sheetId = getSheetId(type);
        const sheetHint = type === 'numbers_repeat' ? 'Повторные' : undefined;
        const { headers, rows } = await fetchSheetRaw(sheetId, sheetHint);
        const data = rowsToObjects(headers, rows);

        console.log(`[GoogleSheets API] Успешно загружено ${data.length} строк для "${type}"`);
        const oldData = cache[cacheKey]?.data;
        if (oldData) {
          const keyFields = ['id', 'ID', 'Ид', 'Номер', 'Телефон', 'Номер телефона', 'phone', 'Phone'];
          const keyOf = (row, index) => {
            const key = keyFields.map((field) => row?.[field]).find((value) => String(value ?? '').trim());
            return String(key ?? `row:${index}`);
          };
          const before = new Map(oldData.map((row, index) => [keyOf(row, index), row]));
          data.forEach((row, index) => {
            const key = keyOf(row, index);
            const previous = before.get(key);
            if (!previous) return;
            const changedFields = Object.keys(row).filter((field) => String(previous[field] ?? '') !== String(row[field] ?? ''));
            if (changedFields.length) {
              recordChangeHistory.unshift({
                id: `${Date.now()}-${type}-${index}`,
                sheet: type,
                rowKey: key,
                changedFields: changedFields.map((field) => ({
                  field,
                  before: previous[field] ?? null,
                  after: row[field] ?? null,
                })),
                source: 'google_sync',
                changedAt: new Date().toISOString(),
              });
            }
          });
          if (recordChangeHistory.length > 5000) recordChangeHistory.length = 5000;
        }
        cache[cacheKey] = {
          data,
          headers,
          sourceRowCount: rows.length + 1,
          timestamp: Date.now(),
        };
        void persistSheetCache(type);
        if (oldData) oldData.length = 0;
        return data;
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

async function fetchNewRowsForSheet(type) {
  const cacheKey = `sheet_${type}`;
  const current = cache[cacheKey];
  if (!current) {
    // Do not turn a manual status check into a full 64k+ row download after
    // a process restart. A complete refresh is an explicit table action.
    return { rows: [], isInitial: true };
  }

  const sheetId = getSheetId(type);
  const sheetHint = type === 'numbers_repeat' ? 'Повторные' : undefined;
  const delta = await fetchSheetDelta(sheetId, current.sourceRowCount + 1, sheetHint);
  const rows = rowsToObjects(current.headers || [], delta.rows);

  if (rows.length > 0) {
    cache[cacheKey] = {
      data: current.data.concat(rows),
      headers: current.headers,
      sourceRowCount: Math.max(current.sourceRowCount, delta.rowCount),
      timestamp: Date.now(),
    };
  } else {
    current.sourceRowCount = Math.max(current.sourceRowCount, delta.rowCount);
    current.timestamp = Date.now();
  }
  console.log(`[GoogleSheets API] Загружено новых строк для "${type}": ${rows.length}`);
  return { rows, isInitial: false };
}

async function syncSheet(type) {
  const cacheKey = `sheet_${type}`;
  const sheetId = getSheetId(type);
  const sheetHint = type === 'numbers_repeat' ? 'Повторные' : undefined;
  const current = cache[cacheKey];

  if (!current) {
    const { headers, rows } = await fetchSheetRaw(sheetId, sheetHint);
    const data = rowsToObjects(headers, rows);
    cache[cacheKey] = { data, headers, sourceRowCount: rows.length + 1, timestamp: Date.now() };
    void persistSheetCache(type);
    return { type, added: data.length, total: data.length, initialized: true };
  }

  const startRow = current.sourceRowCount + 1;
  const delta = await fetchSheetDelta(sheetId, startRow, sheetHint);
  const addedRows = rowsToObjects(current.headers || [], delta.rows);
  if (addedRows.length > 0) current.data.push(...addedRows);
  current.sourceRowCount = Math.max(current.sourceRowCount, delta.rowCount);
  current.timestamp = Date.now();
  void persistSheetCache(type);
  return { type, added: addedRows.length, total: current.data.length, initialized: false };
}

async function synchronizeSheets() {
  if (syncInFlight) return syncInFlight;
  const sheetTypes = ['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts'];
  syncProgress.active = true;
  syncProgress.current = 0;
  syncProgress.total = sheetTypes.length;
  syncProgress.label = 'Подготовка';
  syncProgress.error = null;
  syncProgress.startedAt = new Date().toISOString();
  syncProgress.completedAt = null;

  syncInFlight = Promise.all(
    sheetTypes.map(async (type) => {
      try {
        const result = await syncSheet(type);
        syncProgress.current += 1;
        syncProgress.label = type;
        return result;
      } catch (error) {
        console.error(`[Sheets sync] Ошибка синхронизации ${type}:`, error.message || error);
        syncProgress.current += 1;
        syncProgress.label = type;
        syncProgress.error = syncProgress.error || error.message || `Ошибка синхронизации ${type}`;
        return { type, added: 0, error: error.message || `Ошибка синхронизации ${type}` };
      }

    }),
  ).then((results) => {
    dashboardMetricsCache.clear();
    syncProgress.active = false;
    syncProgress.current = syncProgress.total;
    syncProgress.label = syncProgress.error ? 'Завершено с ошибками' : 'Завершено';
    syncProgress.completedAt = new Date().toISOString();
    return { synchronizedAt: new Date().toISOString(), results };
  }).catch((error) => {
    syncProgress.active = false;
    syncProgress.error = error.message || 'Ошибка синхронизации';
    syncProgress.label = 'Ошибка';
    syncProgress.completedAt = new Date().toISOString();
    throw error;
  }).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function synchronizeSheet(type) {
  if (!['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts'].includes(type)) {
    throw Object.assign(new Error(`Неизвестный тип таблицы: "${type}"`), { status: 400 });
  }
  const startedAt = new Date().toISOString();
  if (!syncProgress.active) {
    syncProgress.active = true;
    syncProgress.current = 0;
    syncProgress.total = 1;
    syncProgress.label = 'Подготовка';
    syncProgress.error = null;
    syncProgress.startedAt = startedAt;
    syncProgress.completedAt = null;
  }
  try {
    const result = await syncSheet(type);
    dashboardMetricsCache.clear();
    if (syncProgress.total === 1) {
      syncProgress.current = 1;
      syncProgress.label = type;
      syncProgress.active = false;
      syncProgress.completedAt = new Date().toISOString();
    }
    return { synchronizedAt: new Date().toISOString(), results: [result] };
  } catch (error) {
    if (syncProgress.total === 1) {
      syncProgress.active = false;
      syncProgress.error = error.message || `Ошибка синхронизации ${type}`;
    }
    throw error;
  }
}

// Export function for manual sync trigger
async function triggerSync() {
  return synchronizeSheets();
}

function getSyncStatus() {
  return {
    ...syncProgress,
    current: Math.min(syncProgress.current, syncProgress.total),
  };
}

function getEffectiveSheetRowCount(rawCount, loadedRowsLength = 0) {
  const numericRawCount = Number(rawCount);
  const numericLoadedRowsLength = Number(loadedRowsLength);

  if (!Number.isFinite(numericRawCount) && !Number.isFinite(numericLoadedRowsLength)) {
    return 0;
  }

  const rawCountValue = Number.isFinite(numericRawCount) ? numericRawCount : 0;
  const loadedRowsValue = Number.isFinite(numericLoadedRowsLength) ? numericLoadedRowsLength : 0;

  if (loadedRowsValue > 0) {
    return Math.max(rawCountValue, loadedRowsValue);
  }

  return rawCountValue;
}

async function getSheetSummary(type, refresh = false) {
  const cacheKey = `sheet_${type}`;

  const cachedData = cache[cacheKey]?.data;
  if (cachedData) {
    return {
      type,
      total: cachedData.length,
      cachedAt: cache[cacheKey]?.timestamp
        ? new Date(cache[cacheKey].timestamp).toISOString()
        : null,
      refreshing: false,
    };
  }

  return {
    type,
    total: cachedData ? cachedData.length : 0,
    cachedAt: cache[cacheKey]?.timestamp
      ? new Date(cache[cacheKey].timestamp).toISOString()
      : null,
    refreshing: false,
  };
}

async function fetchSheetPage(type, page, pageSize) {
  const snapshot = cache[`sheet_${type}`];
  const headers = snapshot?.headers || [];
  const allRawRows = snapshot?.data || [];
  const offset = (page - 1) * pageSize;
  const rows = allRawRows.slice(offset, offset + pageSize);

  return {
    headers,
    rows,
    total: allRawRows.length,
  };
}

async function refreshSheet(type) {
  try {
    await syncSheet(type);
  } catch (error) {
    console.error(`[Data refresh error] ${type}:`, error.message || error);
  }
}

async function reloadSheetFully(type) {
  const cacheKey = `sheet_${type}`;
  if (inFlight[cacheKey]) return inFlight[cacheKey];

  inFlight[cacheKey] = (async () => {
    const sheetId = getSheetId(type);
    const sheetHint = type === 'numbers_repeat' ? 'Повторные' : undefined;
    const { headers, rows } = await fetchSheetRaw(sheetId, sheetHint);
    const data = rowsToObjects(headers, rows);
    cache[cacheKey] = {
      data,
      headers,
      sourceRowCount: rows.length + 1,
      timestamp: Date.now(),
    };
    void persistSheetCache(type);
    dashboardMetricsCache.clear();
    return {
      type,
      total: data.length,
      loadedAt: new Date(cache[cacheKey].timestamp).toISOString(),
    };
  })().finally(() => {
    delete inFlight[cacheKey];
  });

  return inFlight[cacheKey];
}

async function checkSheetConnection(type) {
  const startedAt = Date.now();
  const sheetId = getSheetId(type);
  const sheetHint = type === 'numbers_repeat' ? 'Повторные' : undefined;
  const metadata = await getSheetMetadata(sheetId, sheetHint);
  return {
    type,
    status: 'success',
    latencyMs: Date.now() - startedAt,
    title: metadata.title,
    totalRows: Math.max(0, metadata.rowCount - 1),
    checkedAt: new Date().toISOString(),
  };
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
  const timeoutMs = parseInt(process.env.DATA_PREWARM_TIMEOUT_MS || '', 10) || 10_000;
  console.log(`[Data prewarm] Начальная синхронизация запущена, лимит ожидания ${timeoutMs}мс.`);
  const syncPromise = synchronizeSheets();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([syncPromise, timeoutPromise]);
  if (result === 'timeout') {
    console.warn('[Data prewarm] Синхронизация продолжается в фоне.');
    syncPromise.then(
      () => console.log('[Data prewarm] Фоновая синхронизация завершена.'),
      (error) => console.error('[Data prewarm] Ошибка фоновой синхронизации:', error),
    );
    return;
  }
  console.log('[Data prewarm] Кэш успешно прогрет до истечения лимита.');
}

function startBackgroundDataRefresh() {
  if (backgroundRefreshIntervalMs <= 0) {
    console.log('[Data refresh] Автоматическая синхронизация отключена настройкой DATA_REFRESH_INTERVAL_MS.');
    return null;
  }

  const refresh = async () => {
    if (backgroundRefreshInProgress || syncInFlight) return;
    backgroundRefreshInProgress = true;
    try {
      const result = await synchronizeSheets();
      const added = result.results.reduce((total, item) => total + (item.added || 0), 0);
      console.log(`[Data refresh] Синхронизация завершена: добавлено ${added} новых строк.`);
    } catch (error) {
      console.error('[Data refresh] Ошибка автоматической синхронизации:', error);
    } finally {
      backgroundRefreshInProgress = false;
    }
  };

  backgroundRefreshTimer = setInterval(() => {
    void refresh();
  }, backgroundRefreshIntervalMs);
  backgroundRefreshTimer.unref?.();
  console.log(`[Data refresh] Автоматическая синхронизация включена: каждые ${Math.round(backgroundRefreshIntervalMs / 60000)} мин.`);
  return backgroundRefreshTimer;
}

function getAutoRefreshSettings() {
  return {
    enabled: backgroundRefreshIntervalMs > 0,
    intervalMinutes: backgroundRefreshIntervalMs > 0 ? backgroundRefreshIntervalMs / 60000 : 0,
  };
}

function setAutoRefreshSettings(intervalMinutes) {
  const minutes = Number(intervalMinutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw Object.assign(new Error('intervalMinutes must be an integer from 0 to 1440'), { status: 400 });
  }
  backgroundRefreshIntervalMs = minutes * 60000;
  if (backgroundRefreshTimer) {
    clearInterval(backgroundRefreshTimer);
    backgroundRefreshTimer = null;
  }
  if (backgroundRefreshIntervalMs > 0) startBackgroundDataRefresh();
  return getAutoRefreshSettings();
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
  // `refresh` is kept for API compatibility, but Google Sheets synchronization
  // is now explicit via POST /api/data/sync. Never discard a valid snapshot
  // cache just because a page requested fresh data.
  if (cachedMetrics && Date.now() - cachedMetrics.timestamp < DASHBOARD_METRICS_CACHE_TTL_MS) {
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

  const loadSheet = async (type, assignRows, assignError) => {
    try {
      assignRows(await fetchAllRowsForSheet(type, false));
    } catch (err) {
      console.error(`Ошибка загрузки ${type === 'main' ? 'main_base' : type}:`, err.message);
      assignError(err.message || `Ошибка загрузки ${type}`);
    }
  };

  await Promise.all([
    loadSheet('main', (rows) => { mainRows = rows; }, (error) => { mainError = error; }),
    loadSheet('numbers', (rows) => { numbersRows = rows; }, (error) => { numbersError = error; }),
    loadSheet('eskiz', (rows) => { eskizRows = rows; }, (error) => { eskizError = error; }),
    loadSheet('not_completed', (rows) => { notCompletedRows = rows; }, (error) => { notCompletedError = error; }),
    loadSheet('survey_attempts', (rows) => { surveyAttemptRows = rows; }, (error) => { surveyAttemptsError = error; }),
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
  const derived = mainError
    ? { phoneDiagnostics: { corrupted: 0, truncated: 0, invalid: 0, foreign: 0 }, registrationsByPhone: new Map(), mainPhones: new Set(), unknownSource: new Set() }
    : getMainDerived(mainRows, cache['sheet_main']?.timestamp || 0);
  const phoneDiagnostics = {
    ...derived.phoneDiagnostics,
  };
  const mainRegistrationsByPhone = derived.registrationsByPhone;
  const mainPhones = derived.mainPhones;
  const mainHasUnknownSourceRegistration = derived.unknownSource;

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

  const registrationClassification = (!numbersError && !mainError)
    ? buildRegistrationClassification(mainRows, numbersRows, startDate, endDate)
    : null;
  const matchedRepeatPhones = registrationClassification?.repeatPhones || new Set();
  const matchedPhonesSupport = registrationClassification?.supportPhones || new Set();
  const calledUniquePhones = registrationClassification?.calledPhones || new Set();
  const alreadyRegisteredPhones = registrationClassification?.alreadyRegisteredPhones || new Set();
  const repeatStatusesFoundInPeriod = registrationClassification?.repeatContactCount || 0;

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
      diagnostics: (numbersError || mainError) ? undefined : {
        unknownSourceCount: mainHasUnknownSourceRegistration.size,
        excludedRepeatCount: matchedRepeatPhones.size,
        excludedBotRegisteredCount: alreadyRegisteredPhones.size,
      },
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
      value: numbersError ? '—' : Math.max(alreadyRegisteredVal, alreadyRegisteredPhones.size),
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
async function getSheetPaginated(
  type,
  page = 1,
  pageSize = 25,
  search = '',
  forceRefresh = false,
  sortBy = '',
  sortDirection = 'asc',
  filterColumn = '',
  filterValue = '',
  filterValues = [],
  filterOptionsColumn = '',
  startDate = '',
  endDate = '',
) {
  const safePage = Number.isFinite(Number(page)) && Number(page) > 0
    ? Math.floor(Number(page))
    : 1;
  const safePageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.min(Math.floor(Number(pageSize)), 100000)
    : 25;
  const cacheKey = `sheet_${type}`;
  const allRows = cache[cacheKey]?.data || [];
  if (type === 'not_completed' || type === 'main') {
    const numbersRows = cache['sheet_numbers']?.data || [];
    const classification = getCachedRegistrationClassification(allRows, numbersRows, startDate, endDate);
    const matchedPhonesSupport = classification.supportPhones;

    // Mark main_base rows using the exact same classification as the KPI.
    for (const row of allRows) {
      const phone = normalizePhoneWithDiagnostics(getPhone(row)).normalized;
      row['ОТ поддержки?'] = phone && matchedPhonesSupport.has(phone) ? 'Да' : 'Нет';
    }

  }

  // Фильтрация по выбранным датам (startDate / endDate), если указаны даты
  let baseRows = allRows;
  if (startDate || endDate) {
    if (type === 'main') {
      baseRows = allRows.filter((row) => {
        const d = parseSheetDate(getMainRegistrationDate(row));
        return isDateInRange(d, startDate, endDate);
      });
    } else if (type === 'numbers' || type === 'numbers_repeat') {
      baseRows = allRows.filter((row) => {
        const d = parseSheetDate(getCallDate(row));
        return isDateInRange(d, startDate, endDate);
      });
    } else if (type === 'not_completed') {
      baseRows = allRows.filter((row) => {
        const dateStr = getRowValue(
          row,
          ['Дата создания', 'Start date', 'Дата', 'Creation date'],
          (key) => /(датасоздания|startdate|дата|creationdate)/.test(key)
        );
        const d = parseSheetDate(dateStr);
        return isDateInRange(d, startDate, endDate);
      });
    } else {
      baseRows = allRows.filter((row) => {
        const dateStr = getRowValue(row, ['Дата', 'Date', 'Дата создания'], (key) => /(дата|date)/.test(key));
        const d = parseSheetDate(dateStr);
        return isDateInRange(d, startDate, endDate);
      });
    }
  }

  const pageData = await fetchSheetPage(type, safePage, safePageSize);
  let headers = [];
  if (pageData.headers.length > 0) {
    headers = pageData.headers;
  } else if (allRows.length > 0) {
    headers = Object.keys(allRows[0]);
  }
  if ((type === 'not_completed' || type === 'main') && !headers.includes('ОТ поддержки?')) {
    headers = [...headers, 'ОТ поддержки?'];
  }

  let filteredRows = baseRows;
  if (search) {
    const searchNorm = normalizePhone(search);
    const searchLower = search.toLowerCase();
    filteredRows = filteredRows.filter((row) => {
      const phone = getPhone(row);
      if (phone) {
        const normPhone = normalizePhone(phone);
        if (normPhone.includes(searchNorm) || phone.includes(search)) return true;
      }
      return Object.values(row).some((value) =>
        String(value).toLowerCase().includes(searchLower)
      );
    });
  }
  if (filterColumn && filterValues.length > 0) {
    const selected = new Set(filterValues.map((value) => String(value)));
    filteredRows = filteredRows.filter((row) => selected.has(String(row[filterColumn] ?? '')));
  } else if (filterColumn && filterValue) {
    const filterLower = filterValue.toLowerCase();
    filteredRows = filteredRows.filter((row) =>
      String(row[filterColumn] ?? '').toLowerCase().includes(filterLower)
    );
  }
  if (sortBy && headers.includes(sortBy)) {
    filteredRows = [...filteredRows].sort((a, b) => {
      const left = String(a[sortBy] ?? '');
      const right = String(b[sortBy] ?? '');
      const leftNumber = Number(left.replace(',', '.'));
      const rightNumber = Number(right.replace(',', '.'));
      const comparison =
        left !== '' && right !== '' && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
          ? leftNumber - rightNumber
          : left.localeCompare(right, 'ru', { numeric: true, sensitivity: 'base' });
      return sortDirection === 'desc' ? -comparison : comparison;
    });
  }

  const total = filteredRows.length;
  const totalPages = Math.ceil(total / safePageSize);
  const offset = (safePage - 1) * safePageSize;
  const paginatedRows = filteredRows.slice(offset, offset + safePageSize);

  return {
    type,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages,
    headers,
    rows: paginatedRows,
    filterOptions: (filterColumn || filterOptionsColumn)
      ? Array.from(new Set(baseRows.map((row) => String(row[filterColumn || filterOptionsColumn] ?? ''))))
      : undefined,
    cachedAt: new Date().toISOString(),
  };
}

async function searchSheetRecords({ query = '', sheets = [], limit = 100 } = {}) {
  const needle = String(query).trim();
  if (!needle) return { query: '', sheets: [], total: 0, records: [] };
  const selected = (Array.isArray(sheets) ? sheets : [sheets])
    .map(String)
    .filter((type, index, list) => list.indexOf(type) === index);
  const types = selected.length ? selected : ['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts'];
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 500);
  const phoneNeedle = normalizePhone(needle);
  const lowerNeedle = needle.toLowerCase();
  const records = [];
  for (const type of types) {
    if (!['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts'].includes(type)) continue;
    const rows = cache[`sheet_${type}`]?.data || [];
    for (const row of rows) {
      const phone = normalizePhone(String(getPhone(row) || ''));
      const valuesMatch = Object.values(row).some((value) =>
        String(value ?? '').toLowerCase().includes(lowerNeedle)
      );
      if ((phoneNeedle && phone.includes(phoneNeedle)) || valuesMatch) {
        records.push({ sheet: type, record: row });
        if (records.length >= safeLimit) {
          return { query: needle, sheets: types, total: records.length, records };
        }

      }
    }
  }
  return { query: needle, sheets: types, total: records.length, records };
}

function getCachedSheetRows(type) {
  return cache[`sheet_${type}`]?.data || [];
}

function getSheetsCacheHealth() {
  const sheets = ['main', 'numbers', 'eskiz'].map((type) => ({
    type,
    available: Array.isArray(cache[`sheet_${type}`]?.data),
    rows: cache[`sheet_${type}`]?.data?.length || 0,
    cachedAt: cache[`sheet_${type}`]?.timestamp ? new Date(cache[`sheet_${type}`].timestamp).toISOString() : null,
  }));
  return { configured: Boolean(config.google.credentials || config.google.serviceAccountJson), sheets };
}

function getRowChangeHistory(type, query = '') {
  const needle = String(query).trim().toLowerCase();
  return recordChangeHistory.filter((item) => {
    if (type && item.sheet !== type) return false;
    return !needle || item.rowKey.toLowerCase().includes(needle);
  }).slice(0, 200);
}

module.exports = {
  fetchAllRowsForSheet,
  fetchNewRowsForSheet,
  synchronizeSheets,
  synchronizeSheet,
  triggerSync,
  getColumnDText,
  clearSheetCache,
  withDashboardMetricsSlot,
  prewarmDataCache,
  startBackgroundDataRefresh,
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated,
  getSheetSummary,
  reloadSheetFully,
  checkSheetConnection,
  classifyRegistrationSource,
  getSyncStatus,
  restoreSheetCacheFromRedis,
  getAutoRefreshSettings,
  setAutoRefreshSettings,
  searchSheetRecords,
  getCachedSheetRows,
  getSheetsCacheHealth,
  getRowChangeHistory,
  getCallDate,
  getMainRegistrationDate,
};
