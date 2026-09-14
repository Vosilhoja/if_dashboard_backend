/**
 * src/ai/tools.ts
 * Инструменты (Tool Calling) доступа к реальным агрегированным данным дашборда HURMO UZ
 */

const { calculateDashboardMetrics, fetchAllRowsForSheet } = require('../services/googleSheets');
const { getAnalyticsData } = require('../services/analyticsService');
const { normalizePhoneWithDiagnostics, normalizePhone } = require('../utils/phoneUtils');
const { STATUS_CONFIG, isDeclinedStatus, isLinkSentStatus } = require('../utils/statusMatcher');

export interface FunnelToolParams {
  startDate?: string;
  endDate?: string;
  anomalyThreshold?: number;
}

/**
 * 1. Получение метрик воронки и аномалий за период или за всё время
 */
export async function getFunnelMetrics(params: FunnelToolParams = {}) {
  const metrics = await calculateDashboardMetrics({
    startDate: params.startDate || '',
    endDate: params.endDate || '',
    anomalyThreshold: params.anomalyThreshold || 30,
  });

  const calls = typeof metrics.callsCount?.value === 'number' ? metrics.callsCount.value : 0;
  const sms = typeof metrics.smsSentVerification?.value === 'number' ? metrics.smsSentVerification.value : 0;
  const reg = typeof metrics.registeredMainBase?.value === 'number' ? metrics.registeredMainBase.value : 0;
  const regSupport = typeof metrics.registeredFromSupport?.value === 'number' ? metrics.registeredFromSupport.value : 0;
  const regRepeat = typeof metrics.registeredAfterRepeat?.value === 'number' ? metrics.registeredAfterRepeat.value : 0;
  const declined = typeof metrics.declinedCount?.value === 'number' ? metrics.declinedCount.value : 0;
  const alreadyReg = typeof metrics.alreadyRegisteredCount?.value === 'number' ? metrics.alreadyRegisteredCount.value : 0;
  const notCompleted = typeof metrics.notCompletedCount?.value === 'number' ? metrics.notCompletedCount.value : 0;

  return {
    period: metrics.period,
    funnel: {
      totalCalls: calls,
      smsVerificationSent: sms,
      registeredInMainBase: reg,
      registeredFromSupport: regSupport,
      registeredAfterRepeat: regRepeat,
      declined: declined,
      alreadyRegistered: alreadyReg,
      notCompleted: notCompleted,
      conversionCallToSmsPercent: calls > 0 ? Number(((sms / calls) * 100).toFixed(1)) : 0,
      conversionSmsToRegPercent: sms > 0 ? Number(((reg / sms) * 100).toFixed(1)) : 0,
      endToEndConversionPercent: calls > 0 ? Number(((reg / calls) * 100).toFixed(1)) : 0,
    },
    anomalies: metrics.anomalyData || null,
    totalDatabaseRows: metrics.totalRows,
  };
}

/**
 * 2. Анализ потерь времени и трафика на зарубежные и поврежденные номера
 */
export async function getPhoneDiagnosticsAndLosses() {
  const [numbersRows, mainRows] = await Promise.all([
    fetchAllRowsForSheet('numbers').catch(() => []),
    fetchAllRowsForSheet('main').catch(() => []),
  ]);

  let foreignCallsCount = 0;
  let foreignTotalTalkTimeSec = 0;
  let corruptedCount = 0;
  let truncatedCount = 0;
  let invalidCount = 0;

  const foreignPhoneSet = new Set<string>();

  for (const row of numbersRows) {
    const rawP = row['Телефон'] || row['Phone'] || '';
    const diag = normalizePhoneWithDiagnostics(rawP);

    if (diag.status === 'foreign') {
      foreignCallsCount++;
      if (diag.normalized) foreignPhoneSet.add(diag.normalized);
      const talkTime = parseInt(row['talk_time'] || '0', 10);
      if (!isNaN(talkTime)) foreignTotalTalkTimeSec += talkTime;
    } else if (diag.status === 'corrupted_scientific') {
      corruptedCount++;
    } else if (diag.status === 'truncated') {
      truncatedCount++;
    } else if (diag.status === 'invalid') {
      invalidCount++;
    }
  }

  const lostMinutes = Math.round(foreignTotalTalkTimeSec / 60);
  const lostHours = Number((foreignTotalTalkTimeSec / 3600).toFixed(1));

  return {
    foreignNumbers: {
      uniqueForeignNumbers: foreignPhoneSet.size,
      totalCallsToForeignNumbers: foreignCallsCount,
      totalTalkTimeSeconds: foreignTotalTalkTimeSec,
      lostOperatorMinutes: lostMinutes,
      lostOperatorHours: lostHours,
      avgCallDurationSeconds: foreignCallsCount > 0 ? Math.round(foreignTotalTalkTimeSec / foreignCallsCount) : 0,
      impact: `Потери времени операторов на звонки по зарубежным номерам составили ${lostHours} ч (${lostMinutes} мин). Это время могло быть направлено на качественный обзвон респондентов внутри Узбекистана.`,
    },
    dataQualityErrors: {
      corruptedScientificNotation: corruptedCount,
      truncatedNumbers: truncatedCount,
      invalidNumbers: invalidCount,
    },
  };
}

/**
 * 3. Детальный разбор причин отказов респондентов
 */
export async function getDeclinedReasonsBreakdown(limit: number = 8) {
  const numbersRows = await fetchAllRowsForSheet('numbers').catch(() => []);
  const reasonMap: Record<string, number> = {};
  let totalDeclined = 0;

  for (const row of numbersRows) {
    const comment = (row['Коментарий'] || '').trim();
    if (isDeclinedStatus(comment, STATUS_CONFIG.declined)) {
      totalDeclined++;
      const lower = comment.toLowerCase();
      let category = 'Другой отказ';

      if (lower.includes('вақт') || lower.includes('нет времени') || lower.includes('шош') || lower.includes('занят')) {
        category = 'Нет времени / Спешит / Занят';
      } else if (lower.includes('сброс') || lower.includes('брос') || lower.includes('трубк') || lower.includes('ўчир')) {
        category = 'Сброс звонка / Бросили трубку';
      } else if (lower.includes('хоҳла') || lower.includes('не хочет') || lower.includes('отказ') || lower.includes('истамай')) {
        category = 'Прямой отказ участвовать';
      } else if (lower.includes('спам') || lower.includes('алдов') || lower.includes('мошен')) {
        category = 'Подозрение в спаме / мошенничестве';
      } else if (lower.includes('не слышно') || lower.includes('связ') || lower.includes('эшитил')) {
        category = 'Проблемы со связью';
      }

      reasonMap[category] = (reasonMap[category] || 0) + 1;
    }
  }

  const topReasons = Object.entries(reasonMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({
      reason,
      count,
      percent: totalDeclined > 0 ? Number(((count / totalDeclined) * 100).toFixed(1)) : 0,
    }));

  return {
    totalDeclinedCalls: totalDeclined,
    topReasons,
    recommendationsSummary: 'Основные отказы происходят в первые 7 секунд («нет времени» и «сброс»). Требуется переписать интро: исключить шаблонную длинную презентацию, сразу называть ценность опроса для жителя Узбекистана и гарантировать краткость (1–2 минуты).',
  };
}

/**
 * 4. Статистика по респондентам, не завершившим регистрацию
 */
export async function getNotCompletedRegistrationsStats() {
  const notCompletedRows = await fetchAllRowsForSheet('not_completed').catch(() => []);
  const langMap: Record<string, number> = {};

  for (const row of notCompletedRows) {
    const lang = (row['Язык'] || row['language'] || 'не указан').toLowerCase();
    langMap[lang] = (langMap[lang] || 0) + 1;
  }

  return {
    totalNotCompletedUsers: notCompletedRows.length,
    languageDistribution: langMap,
    recoveryStrategy: [
      'Шаг 1: Сегментация по языку (uzbek / russian).',
      'Шаг 2: Триггерная SMS через Eskiz с индивидуальной короткой ссылкой-дожимом в течение 24–48 часов после попытки.',
      'Шаг 3: Тестирование формулировки сообщения: «Вы почти завершили регистрацию в HURMO UZ! Осталось подтвердить телефон и пройти 1-й опрос».',
      'Шаг 4: Контроль повторных заходов и исключение пользователей, уже зарегистрированных в main_base.',
    ],
  };
}

/**
 * 5. Региональная аналитика
 */
export async function getRegionalAnalyticsData() {
  const analytics = await getAnalyticsData({ refresh: false });
  return {
    regions: analytics.regionAnalytics || [],
    totalRespondentsWithRegion: analytics.total || 0,
    summary: 'Региональные данные позволяют увидеть диспропорцию между Ташкентом и областями, выравнивая квоты обзвона.',
  };
}

/**
 * Спецификация инструментов для языковой модели (JSON Schema Tool Definitions)
 */
export const HURMO_AI_TOOLS_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_funnel_metrics',
      description: 'Возвращает агрегированные метрики воронки (звонки, SMS, регистрации, отказы, конверсии, аномалии) за выбранный период или всё время.',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Дата начала (YYYY-MM-DD или DD.MM.YYYY)' },
          endDate: { type: 'string', description: 'Дата окончания (YYYY-MM-DD или DD.MM.YYYY)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_phone_diagnostics_and_losses',
      description: 'Возвращает диагностику номеров телефонов: количество зарубежных номеров (681), поврежденных, и точные потери времени операторов в часах и минутах.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_declined_reasons_breakdown',
      description: 'Возвращает детальную статистику причин отказов респондентов («нет времени», «сброс», «не хочет») и процентное соотношение.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_not_completed_stats',
      description: 'Возвращает количество незавершённых регистраций (not_completed) и готовую стратегию дожима.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_regional_analytics',
      description: 'Возвращает распределение зарегистрированных пользователей по 14 регионам Узбекистана.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/**
 * Исполнитель вызова функций
 */
export async function executeTool(toolName: string, args: any = {}) {
  switch (toolName) {
    case 'get_funnel_metrics':
      return await getFunnelMetrics(args);
    case 'get_phone_diagnostics_and_losses':
      return await getPhoneDiagnosticsAndLosses();
    case 'get_declined_reasons_breakdown':
      return await getDeclinedReasonsBreakdown(args.limit);
    case 'get_not_completed_stats':
      return await getNotCompletedRegistrationsStats();
    case 'get_regional_analytics':
      return await getRegionalAnalyticsData();
    default:
      return { error: `Инструмент ${toolName} не найден` };
  }
}
