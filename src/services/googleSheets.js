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

// Cache TTL in ms (3 minutes)
const CACHE_TTL_MS = 3 * 60 * 1000;
const cache = {};

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

  if (!forceRefresh && cache[cacheKey]) {
    if (now - cache[cacheKey].timestamp < CACHE_TTL_MS) {
      return cache[cacheKey].data;
    }
  }

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

  await sheet.loadHeaderRow().catch(() => {});
  const rawRows = await sheet.getRows().catch(() => []);

  const data = rawRows.map((row) => {
    const obj = {};
    for (const h of sheet.headerValues || []) {
      obj[h] = row.get(h) ?? '';
    }
    return obj;
  });

  cache[cacheKey] = {
    data,
    timestamp: now,
  };

  return data;
}

function clearSheetCache() {
  for (const k of Object.keys(cache)) {
    delete cache[k];
  }
}

/**
 * Расчет всех операционных метрик (интерфейс DashboardMetrics)
 */
async function calculateDashboardMetrics(query = {}) {
  const { startDate = '', endDate = '', refresh = false, anomalyThreshold: customThreshold } = query;

  if (refresh) {
    clearSheetCache();
  }

  let mainRows = [];
  let numbersRows = [];
  let eskizRows = [];
  let notCompletedRows = [];

  let mainError = null;
  let numbersError = null;
  let eskizError = null;
  let notCompletedError = null;

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
  ]);

  // 1. Быстрый поиск номеров main_base и сбор телефонной диагностики
  const mainPhoneSet = new Set();
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

      if (diag.normalized) {
        mainPhoneSet.add(diag.normalized);
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
      if (p && mainPhoneSet.has(p)) {
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
        if (p && mainPhoneSet.has(p)) {
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
        return {
          current,
          baseline4WeeksAvg: baseline,
          deltaPercent: delta,
          isAnomaly: current > 5,
          direction: current > 0 ? 'up' : 'normal',
        };
      }
      const deltaPercent = Math.round(((current - baseline) / baseline) * 100);
      const absDelta = Math.abs(deltaPercent);
      const isAnomaly = absDelta >= anomalyThreshold;
      const direction = deltaPercent > 0 ? 'up' : deltaPercent < 0 ? 'down' : 'normal';
      return {
        current,
        baseline4WeeksAvg: baseline,
        deltaPercent,
        isAnomaly,
        direction,
      };
    };

    anomalyData = {
      callsAnomaly: calcAnomaly(callsCountVal, avgCalls),
      declinedAnomaly: calcAnomaly(declinedVal, avgDeclined),
    };
  }

  return {
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
        : `Уникальных номеров в базе (всего звонков по ним: ${totalSupportMatchesCount})`,
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
        : `Уникальных номеров (всего совпадений: ${totalRepeatMatchesCount})`,
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
    },
    anomalyData,
    cachedAt: new Date().toISOString(),
  };
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
async function getSheetPaginated(type, page = 1, pageSize = 25, search = '') {
  const allRows = await fetchAllRowsForSheet(type);
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
  calculateDashboardMetrics,
  getPeriodDetails,
  getSheetPaginated
};
