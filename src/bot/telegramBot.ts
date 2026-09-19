const { Telegraf, Markup } = require('telegraf');
const config = require('../config');
const UserModel = require('../models/User');
const { calculateDashboardMetrics, searchSheetRecords } = require('../services/googleSheets');
const {
  consumeTelegramLinkCode,
  isTelegramLinkRateLimited,
} = require('../services/telegramLink.service');
const taskService = require('../services/tasks');

/**
 * Форматирует число: 0 → '—'
 */
function fmt(val) {
  if (val === undefined || val === null || val === '—') return '—';
  return val;
}

const SEARCH_SHEETS = new Set(['main', 'numbers', 'eskiz', 'not_completed', 'survey_attempts']);
const SEARCH_SHEET_ALIASES = {
  main_base: 'main',
  mainbase: 'main',
  main: 'main',
  numbers: 'numbers',
  eskiz: 'eskiz',
  not_completed: 'not_completed',
  survey_attempts: 'survey_attempts',
};

/**
 * Получить краткую сводку из Google Sheets (с кэшом ~3 мин)
 */
async function getLiveSummary() {
  try {
    const metrics = await calculateDashboardMetrics({});
    const calls = fmt(metrics.callsCount?.value);
    const sms = fmt(metrics.smsSentVerification?.value);
    const registered = fmt(metrics.registeredMainBase?.value);
    const fromSupport = fmt(metrics.registeredFromSupport?.value);
    const declined = fmt(metrics.declinedCount?.value);
    const notCompleted = fmt(metrics.notCompletedCount?.value);

    return {
      calls,
      sms,
      registered,
      fromSupport,
      declined,
      notCompleted,
      errors: {
        calls: metrics.callsCount?.error,
        sms: metrics.smsSentVerification?.error,
        registered: metrics.registeredMainBase?.error,
      }
    };
  } catch (err) {
    console.error('[Bot] Ошибка получения метрик Google Sheets:', err.message);
    return null;
  }
}

/**
 * Регистрирует все команды и хендлеры на переданном экземпляре бота.
 * @param {Telegraf} bot - Экземпляр Telegraf бота
 * @param {{id: number, token: string, userId: string, allowedIds: string[]}} botConfig - Конфиг конкретного бота
 */
function registerBotHandlers(bot, botConfig) {
  const botLabel = `[Bot #${botConfig.id}]`;

  bot.use((ctx, next) => {
    const tgId = String(ctx.from?.id || '');
    if (!botConfig.allowedIds.includes(tgId)) {
      return ctx.reply('🔒 Доступ к этому боту ограничен.');
    }
    return next();
  });

  const hasPermission = (user, permission) =>
    user?.role === 'super_admin' ||
    Array.isArray(user?.permissions) &&
      (user.permissions.includes('*') || user.permissions.includes(permission));

  const permissionDenied = (ctx) =>
    ctx.reply('⛔ Эта функция недоступна для вашей роли. Откройте «🛡 Мои права», чтобы увидеть доступные возможности.');

  const buildKeyboard = (user) => {
    const rows = [];
    if (hasPermission(user, 'bot_view_summary')) rows.push(['📊 Сводка дашборда']);
    if (hasPermission(user, 'bot_view_calls')) rows.push(['📞 Статистика обзвонов']);
    if (hasPermission(user, 'bot_search_users')) rows.push(['🔎 Поиск пользователя']);
    if (hasPermission(user, 'bot_manage_tasks')) rows.push(['✅ Мои задачи']);
    rows.push(['👤 Мой профиль', '🛡 Мои права']);
    rows.push(['⚙️ Статус системы', 'ℹ️ Помощь']);
    return Markup.keyboard(rows).resize();
  };

  async function linkedTelegramUser(ctx) {
    const user = await UserModel.findByTelegramId(String(ctx.from?.id || ''));
    if (!user) return null;
    return UserModel.findById(user.id);
  }

  bot.start(async (ctx) => {
    const tgUser = ctx.from;
    const tgId = String(tgUser.id);

    const systemUser = await UserModel.findByTelegramId(tgId);

    if (systemUser) {
      return ctx.reply(
        `👋 Добро пожаловать, *${systemUser.full_name || systemUser.username}*!\n\n` +
        `✅ Ваша учетная запись верифицирована.\n` +
        `🛡 Ваша роль в системе: *${systemUser.role.toUpperCase()}*\n` +
        `📊 Вы подключены к дашборду *HURMO UZ*.\n\n` +
        `Выберите нужное действие в меню ниже:`,
        {
          parse_mode: 'Markdown',
          ...buildKeyboard(await UserModel.findById(systemUser.id))
        }
      );
    }

    return ctx.reply(
      `👋 Здравствуйте, *${tgUser.first_name}*!\n\n` +
      `Это официальный бот аналитического центра *HURMO UZ*.\n` +
      `Ваш Telegram ID: \`${tgId}\`\n\n` +
      `🔐 Для связывания откройте дашборд, войдите в аккаунт и запросите одноразовый код Telegram.\n` +
      `Затем отправьте команду:\n\`/link <код из дашборда>\``,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('link', async (ctx) => {
    try {
      const parts = ctx.message.text.trim().split(/\s+/);
      const tgId = String(ctx.from.id);

      if (await isTelegramLinkRateLimited(tgId)) {
        return ctx.reply('🔒 Слишком много попыток. Попробуйте через 15 минут.');
      }

      if (parts.length !== 2 || !/^[A-F0-9]{16}$/i.test(parts[1])) {
        return ctx.reply('⚠️ Формат команды: `/link <одноразовый код из дашборда>`', { parse_mode: 'Markdown' });
      }

      const userId = await consumeTelegramLinkCode(parts[1]);
      const user = userId ? await UserModel.findById(userId) : null;
      if (!user) return ctx.reply('❌ Код недействителен или истёк.');

      await UserModel.linkTelegramId(user.username, tgId);
      try {
        await ctx.deleteMessage(ctx.message.message_id);
      } catch (deleteError) {
        console.warn(`${botLabel} [/link] Не удалось удалить сообщение с кодом:`, deleteError.message);
      }

      return ctx.reply(
        `🎉 Успешно! Аккаунт *${user.username}* привязан к вашему Telegram!\n` +
        `🛡 Роль: *${user.role}*\n\n` +
        `Теперь вам доступны функции мониторинга и отчетов.`,
        {
          parse_mode: 'Markdown',
          ...buildKeyboard(await UserModel.findById(user.id))
        }
      );
    } catch (err) {
      console.error(`${botLabel} [/link error]:`, err);
      return ctx.reply('❌ Произошла ошибка при связывании аккаунта.');
    }
  });

  bot.command('stats', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация. Привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    }
    if (!hasPermission(user, 'bot_view_summary')) return permissionDenied(ctx);

    await ctx.reply('⏳ Загружаю данные из Google Sheets...');

    const data = await getLiveSummary();
    if (!data) {
      return ctx.reply('❌ Ошибка получения данных. Проверьте настройки Google Sheets.');
    }

    const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

    return ctx.reply(
      `📊 *Оперативная сводка HURMO UZ*\n` +
      `📅 _Все данные (без фильтра по дате)_\n` +
      `🕐 ${today}\n\n` +
      `📞 *Всего звонков:* ${data.calls}\n` +
      `✉️ *SMS верификация:* ${data.sms}\n` +
      `✅ *Зарег. в базе (main_base):* ${data.registered}\n` +
      `👥 *Зарег. после поддержки:* ${data.fromSupport}\n` +
      `❌ *Отказов / нет времени:* ${data.declined}\n` +
      `⏳ *Не завершили регистрацию:* ${data.notCompleted}\n\n` +
      `🌐 Полный дашборд: ${config.clientUrl}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('tasks', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    if (!hasPermission(user, 'bot_manage_tasks')) return permissionDenied(ctx);
    const period = ctx.message.text.includes('today') ? 'today' : undefined;
    const items = await taskService.listTasks({ userId: user.id, period });
    return ctx.reply(items.length ? items.map((task) => `#${task.id} [${task.status}] ${task.title}${task.dueAt ? ` — ${new Date(task.dueAt).toLocaleString('ru-RU')}` : ''}`).join('\n') : '✅ Задач нет.');
  });

  bot.command('task', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    if (!hasPermission(user, 'bot_manage_tasks')) return permissionDenied(ctx);
    const text = ctx.message.text.trim().replace(/^\/task\s*/i, '');
    const match = text.match(/^(.*?)(?:\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}))?$/);
    if (!match || !match[1].trim()) return ctx.reply('Формат: `/task <название> [YYYY-MM-DD HH:mm]`', { parse_mode: 'Markdown' });
    const task = await taskService.createTask({ title: match[1].trim(), dueAt: match[2] ? new Date(match[2].replace(' ', 'T')).toISOString() : null, createdBy: user.id, linkedUserId: user.id });
    return ctx.reply(`✅ Создана задача #${task.id}: ${task.title}`);
  });

  bot.command('done', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    const id = Number(ctx.message.text.trim().split(/\s+/)[1]);
    if (!id) return ctx.reply('Формат: `/done <id>`', { parse_mode: 'Markdown' });
    const task = await taskService.updateTask(id, { status: 'done' });
    return ctx.reply(task ? `✅ Задача #${id} отмечена выполненной.` : '❌ Задача не найдена.');
  });

  bot.on('text', async (ctx, next) => {
    const text = String(ctx.message?.text || '').trim();
    if (!/^task:\s+/i.test(text)) return next();
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    const task = await taskService.createTask({ title: text.replace(/^task:\s+/i, '').trim(), createdBy: user.id, linkedUserId: user.id });
    return ctx.reply(`✅ Создана задача #${task.id}: ${task.title}`);
  });

  bot.command('find', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    if (!hasPermission(user, 'bot_search_users')) return permissionDenied(ctx);
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const query = parts.shift() || '';
    const requestedSheet = parts.shift()?.toLowerCase();
    const sheet = requestedSheet ? SEARCH_SHEET_ALIASES[requestedSheet] : undefined;

    if (!query) {
      return ctx.reply(
        'Формат: `/find <номер или ID> [таблица]`\n' +
        'Таблицы: `main`, `numbers`, `eskiz`, `not_completed`, `survey_attempts`',
        { parse_mode: 'Markdown' },
      );
    }
    if (requestedSheet && !sheet) {
      return ctx.reply('⚠️ Неизвестная таблица. Используйте `main`, `numbers`, `eskiz`, `not_completed` или `survey_attempts`.', { parse_mode: 'Markdown' });
    }

    try {
      const result = await searchSheetRecords({
        query,
        sheets: sheet ? [sheet] : [...SEARCH_SHEETS],
        limit: 5,
      });
      if (!result.records.length) return ctx.reply('Ничего не найдено.');

      const messages = result.records.map(({ sheet: resultSheet, record }, index) => {
        const entries = Object.entries(record)
          .filter(([, value]) => String(value ?? '').trim() !== '')
          .slice(0, 8)
          .map(([key, value]) => `${key}: ${String(value).slice(0, 160)}`);
        return `${index + 1}. ${resultSheet}\n${entries.join('\n')}`;
      });
      return ctx.reply(`🔎 Найдено: ${result.total}\n\n${messages.join('\n\n')}`);
    } catch (error) {
      console.error(`${botLabel} [/find error]:`, error);
      return ctx.reply('❌ Не удалось выполнить поиск. Попробуйте позже.');
    }
  });

  bot.hears('📊 Сводка дашборда', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация. Привяжите аккаунт через команду `/link`.', { parse_mode: 'Markdown' });
    }
    if (!hasPermission(user, 'bot_view_summary')) return permissionDenied(ctx);

    await ctx.reply('⏳ Загружаю актуальные данные из Google Sheets...');

    const data = await getLiveSummary();
    if (!data) {
      return ctx.reply('❌ Ошибка соединения с Google Sheets. Попробуйте позже или откройте дашборд.');
    }

    const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

    return ctx.reply(
      `📊 *Оперативная сводка HURMO UZ*\n` +
      `📅 _${today} • Данные без фильтра дат_\n\n` +
      `📞 Всего звонков: *${data.calls}*\n` +
      `✉️ SMS верификация: *${data.sms}*\n` +
      `✅ Зарег. в базе: *${data.registered}*\n` +
      `👥 Зарег. после поддержки: *${data.fromSupport}*\n` +
      `❌ Отказов: *${data.declined}*\n` +
      `⏳ Не завершили: *${data.notCompleted}*\n\n` +
      `🌐 Полный дашборд: ${config.clientUrl}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('📞 Статистика обзвонов', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация через `/link`.', { parse_mode: 'Markdown' });
    }
    if (!hasPermission(user, 'bot_view_calls')) return permissionDenied(ctx);

    await ctx.reply('⏳ Получаю статистику...');

    const data = await getLiveSummary();
    if (!data) {
      return ctx.reply('❌ Ошибка получения данных из Google Sheets.');
    }

    const calls = typeof data.calls === 'number' ? data.calls : 0;
    const declined = typeof data.declined === 'number' ? data.declined : 0;
    const wrongPerson = 0;
    const answered = calls - declined;
    const declinedPct = calls > 0 ? Math.round((declined / calls) * 100) : 0;
    const answeredPct = calls > 0 ? Math.round((answered / calls) * 100) : 0;

    return ctx.reply(
      `📞 *Статистика колл-центра HURMO UZ*\n\n` +
      `📊 Всего звонков: *${data.calls}*\n` +
      `✅ Ответили и обработали: *${answered}* (${answeredPct}%)\n` +
      `❌ Отказов / нет времени: *${declined}* (${declinedPct}%)\n` +
      `✉️ SMS (ссылка / верификация): *${data.sms}*\n\n` +
      `⚡️ Данные из Google Sheets в реальном времени`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('👤 Мой профиль', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) {
      return ctx.reply('⚠️ Ваш профиль не привязан. Используйте `/link <логин> <пароль>`.', { parse_mode: 'Markdown' });
    }
    if (!hasPermission(user, 'bot_view_profile')) return permissionDenied(ctx);

    return ctx.reply(
      `👤 *Профиль сотрудника HURMO*\n\n` +
      `• *ФИО / Логин:* ${user.full_name || user.username}\n` +
      `• *Роль:* \`${user.role}\`\n` +
      `• *Telegram ID:* \`${user.telegram_id}\`\n` +
      `• *Статус:* ${user.is_active ? '🟢 Активен' : '🔴 Заблокирован'}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('🔎 Поиск пользователя', (ctx) =>
    ctx.reply('Введите команду: `/find <номер или ID> [таблица]`', { parse_mode: 'Markdown' })
  );

  bot.hears('✅ Мои задачи', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    if (!hasPermission(user, 'bot_manage_tasks')) return permissionDenied(ctx);
    const items = await taskService.listTasks({ userId: user.id });
    return ctx.reply(items.length
      ? items.map((task) => `#${task.id} [${task.status}] ${task.title}`).join('\n')
      : '✅ Задач нет.');
  });

  bot.hears('🛡 Мои права', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    const features = config.telegram.features
      .filter((feature) => hasPermission(user, feature.key))
      .map((feature) => `✅ ${feature.label} — ${feature.description}`);
    return ctx.reply(
      `🛡 *Роль:* \`${user.role}\`\n\n` +
      (features.length ? features.join('\n') : 'Нет доступных функций.'),
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('⚙️ Статус системы', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    if (!hasPermission(user, 'bot_system_status')) return permissionDenied(ctx);
    return ctx.reply(`⚙️ *Статус HURMO UZ*\n\n✅ Бот работает\n⏱ Аптайм: ${Math.floor(process.uptime() / 60)} мин.\n🤖 Ботов в конфигурации: ${config.telegram.bots.length}`, { parse_mode: 'Markdown' });
  });

  bot.hears('ℹ️ Помощь', (ctx) => {
    return ctx.reply(
      `ℹ️ *Справка по HURMO Bot*\n\n` +
      `Команды:\n` +
      `• \`/start\` — Перезапустить бота\n` +
      `• \`/link <логин> <пароль>\` — Привязать аккаунт дашборда\n` +
      `• \`/stats\` — Быстрый отчет из Google Sheets\n` +
      `• \`/find <номер или ID> [таблица]\` — Поиск записи без выгрузки всей таблицы\n` +
      `• \`/ping\` — Проверка состояния сервера\n\n` +
      `📊 Кнопки:\n` +
      `• *Сводка дашборда* — Все метрики в реальном времени\n` +
      `• *Статистика обзвонов* — Колл-центр аналитика\n` +
      `• *Мой профиль* — Данные аккаунта`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('ping', (ctx) => {
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    return ctx.reply(
      `🏓 *Pong!*\n\n` +
      `✅ Сервер HURMO UZ работает штатно\n` +
      `⏱ Аптайм: *${hours}ч ${mins}м*\n` +
      `🌐 API: ${config.clientUrl}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('menu', async (ctx) => {
    const user = await linkedTelegramUser(ctx);
    if (!user) return ctx.reply('🔒 Сначала привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    return ctx.reply('🎛 Главное меню обновлено. Доступные кнопки зависят от вашей роли.', buildKeyboard(user));
  });
}

/**
 * Инициализирует и запускает все Telegram-боты, описанные в config.telegram.bots.
 * Каждый бот использует свой собственный токен и список разрешённых пользователей.
 * @returns {Promise<Telegraf[]>} Массив запущенных экземпляров ботов (пустой, если нет конфигурации)
 */
async function initTelegramBot() {
  const botsConfig = config.telegram.bots || [];

  if (botsConfig.length === 0) {
    console.warn('⚠️ [Telegram Bot] Не найдено ни одного бота в конфигурации (TELEGRAM_TOKEN_N / TELEGRAM_BOT_TOKEN не заданы). Боты не запущены.');
    return [];
  }

  const launchedBots = [];

  for (const botConfig of botsConfig) {
    if (!botConfig.token) {
      console.warn(`⚠️ [Telegram Bot #${botConfig.id}] Пропуск: токен не указан.`);
      continue;
    }
    if (botConfig.allowedIds.length === 0) {
      console.warn(`⚠️ [Telegram Bot #${botConfig.id}] Пропуск: TELEGRAM_ALLOWED_IDS/TELEGRAM_ADMIN_IDS/TELEGRAM_USER_ID_${botConfig.id} не настроены.`);
      continue;
    }

    try {
      const bot = new Telegraf(botConfig.token);
      registerBotHandlers(bot, botConfig);

      console.log(`🤖 [Telegram Bot #${botConfig.id}] Инициализация...`);
      await bot.launch({ dropPendingUpdates: true });
      console.log(`🤖 [Telegram Bot #${botConfig.id}] ✅ Успешно запущен и слушает входящие сообщения! (userId=${botConfig.userId || '—'}, allowed=${botConfig.allowedIds.length})`);

      launchedBots.push(bot);
    } catch (err) {
      console.error(`⚠️ [Telegram Bot #${botConfig.id}] Ошибка запуска бота:`, err.message);
    }
  }

  if (launchedBots.length > 0) {
    process.once('SIGINT', () => {
      console.log('[Telegram Bots] Остановка по SIGINT...');
      launchedBots.forEach((bot, idx) => {
        try { bot.stop('SIGINT'); } catch (_) {}
      });
    });
    process.once('SIGTERM', () => {
      console.log('[Telegram Bots] Остановка по SIGTERM...');
      launchedBots.forEach((bot, idx) => {
        try { bot.stop('SIGTERM'); } catch (_) {}
      });
    });
  }

  return launchedBots;
}

module.exports = { initTelegramBot };
