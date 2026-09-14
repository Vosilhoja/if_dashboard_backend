const { Telegraf, Markup } = require('telegraf');
const config = require('../config');
const UserModel = require('../models/User');
const { calculateDashboardMetrics } = require('../services/googleSheets');

/**
 * Форматирует число: 0 → '—'
 */
function fmt(val) {
  if (val === undefined || val === null || val === '—') return '—';
  return val;
}

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

function initTelegramBot() {
  if (!config.telegram.botToken) {
    console.warn('⚠️ [Telegram Bot] Токен бота не указан в .env. Бот не запущен.');
    return null;
  }

  const bot = new Telegraf(config.telegram.botToken);

  // =========================================
  // /start — Приветствие и проверка привязки
  // =========================================
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
          ...Markup.keyboard([
            ['📊 Сводка дашборда', '📞 Статистика обзвонов'],
            ['👤 Мой профиль', 'ℹ️ Помощь']
          ]).resize()
        }
      );
    }

    return ctx.reply(
      `👋 Здравствуйте, *${tgUser.first_name}*!\n\n` +
      `Это официальный бот аналитического центра *HURMO UZ*.\n` +
      `Ваш Telegram ID: \`${tgId}\`\n\n` +
      `🔐 Для связывания с вашим аккаунтом дашборда отправьте команду:\n` +
      `\`/link <ваш_логин> <пароль>\`\n\n` +
      `Например:\n\`/link admin hurmo_secure_pass_2026\``,
      { parse_mode: 'Markdown' }
    );
  });

  // =========================================
  // /link <username> <password> — Привязка аккаунта
  // =========================================
  bot.command('link', async (ctx) => {
    try {
      const parts = ctx.message.text.split(' ');
      if (parts.length < 3) {
        return ctx.reply('⚠️ Формат команды: `/link <логин> <пароль>`', { parse_mode: 'Markdown' });
      }

      const inputUsername = parts[1].trim();
      const inputPassword = parts[2].trim();
      const tgId = String(ctx.from.id);

      const user = await UserModel.findByUsername(inputUsername);
      if (!user) {
        return ctx.reply('❌ Пользователь с таким логином не найден.');
      }

      const validPass = await UserModel.comparePassword(inputPassword, user.password_hash);
      if (!validPass) {
        return ctx.reply('❌ Неверный пароль доступа.');
      }

      await UserModel.linkTelegramId(user.username, tgId);

      return ctx.reply(
        `🎉 Успешно! Аккаунт *${user.username}* привязан к вашему Telegram!\n` +
        `🛡 Роль: *${user.role}*\n\n` +
        `Теперь вам доступны функции мониторинга и отчетов.`,
        {
          parse_mode: 'Markdown',
          ...Markup.keyboard([
            ['📊 Сводка дашборда', '📞 Статистика обзвонов'],
            ['👤 Мой профиль', 'ℹ️ Помощь']
          ]).resize()
        }
      );
    } catch (err) {
      console.error('[Bot /link error]:', err);
      return ctx.reply('❌ Произошла ошибка при связывании аккаунта.');
    }
  });

  // =========================================
  // /stats — Быстрый отчет с реальными данными
  // =========================================
  bot.command('stats', async (ctx) => {
    const tgId = String(ctx.from.id);
    const user = await UserModel.findByTelegramId(tgId);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация. Привяжите аккаунт через `/link`.', { parse_mode: 'Markdown' });
    }

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

  // =========================================
  // Кнопка: 📊 Сводка дашборда
  // =========================================
  bot.hears('📊 Сводка дашборда', async (ctx) => {
    const tgId = String(ctx.from.id);
    const user = await UserModel.findByTelegramId(tgId);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация. Привяжите аккаунт через команду `/link`.', { parse_mode: 'Markdown' });
    }

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

  // =========================================
  // Кнопка: 📞 Статистика обзвонов
  // =========================================
  bot.hears('📞 Статистика обзвонов', async (ctx) => {
    const tgId = String(ctx.from.id);
    const user = await UserModel.findByTelegramId(tgId);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация через `/link`.', { parse_mode: 'Markdown' });
    }

    await ctx.reply('⏳ Получаю статистику...');

    const data = await getLiveSummary();
    if (!data) {
      return ctx.reply('❌ Ошибка получения данных из Google Sheets.');
    }

    const calls = typeof data.calls === 'number' ? data.calls : 0;
    const declined = typeof data.declined === 'number' ? data.declined : 0;
    const wrongPerson = 0; // Не выводится отдельно в кнопке
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

  // =========================================
  // Кнопка: 👤 Мой профиль
  // =========================================
  bot.hears('👤 Мой профиль', async (ctx) => {
    const tgId = String(ctx.from.id);
    const user = await UserModel.findByTelegramId(tgId);
    if (!user) {
      return ctx.reply('⚠️ Ваш профиль не привязан. Используйте `/link <логин> <пароль>`.', { parse_mode: 'Markdown' });
    }

    return ctx.reply(
      `👤 *Профиль сотрудника HURMO*\n\n` +
      `• *ФИО / Логин:* ${user.full_name || user.username}\n` +
      `• *Роль:* \`${user.role}\`\n` +
      `• *Telegram ID:* \`${user.telegram_id}\`\n` +
      `• *Статус:* ${user.is_active ? '🟢 Активен' : '🔴 Заблокирован'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // =========================================
  // Кнопка: ℹ️ Помощь
  // =========================================
  bot.hears('ℹ️ Помощь', (ctx) => {
    return ctx.reply(
      `ℹ️ *Справка по HURMO Bot*\n\n` +
      `Команды:\n` +
      `• \`/start\` — Перезапустить бота\n` +
      `• \`/link <логин> <пароль>\` — Привязать аккаунт дашборда\n` +
      `• \`/stats\` — Быстрый отчет из Google Sheets\n` +
      `• \`/ping\` — Проверка состояния сервера\n\n` +
      `📊 Кнопки:\n` +
      `• *Сводка дашборда* — Все метрики в реальном времени\n` +
      `• *Статистика обзвонов* — Колл-центр аналитика\n` +
      `• *Мой профиль* — Данные аккаунта`,
      { parse_mode: 'Markdown' }
    );
  });

  // =========================================
  // /ping — Проверка работоспособности
  // =========================================
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

  // =========================================
  // Запуск бота
  // =========================================
  console.log('🤖 [Telegram Bot] Инициализация бота HURMO UZ...');

  bot.launch({ dropPendingUpdates: true })
    .then(() => {
      console.log('🤖 [Telegram Bot] ✅ Успешно запущен и слушает входящие сообщения!');
    })
    .catch((err) => {
      console.error('⚠️ [Telegram Bot] Ошибка запуска бота:', err.message);
    });

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { initTelegramBot };
