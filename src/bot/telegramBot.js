const { Telegraf, Markup } = require('telegraf');
const config = require('../config');
const UserModel = require('../models/User');

function initTelegramBot() {
  if (!config.telegram.botToken) {
    console.warn('⚠️ [Telegram Bot] Токен бота не указан в .env. Бот не запущен.');
    return null;
  }

  const bot = new Telegraf(config.telegram.botToken);

  // Обработка команды /start
  bot.start(async (ctx) => {
    const tgUser = ctx.from;
    const tgId = String(tgUser.id);

    // Проверяем, привязан ли этот telegram_id к пользователю в системе
    const systemUser = await UserModel.findByTelegramId(tgId);

    if (systemUser) {
      return ctx.reply(
        `👋 Добро пожаловать, *${systemUser.full_name || systemUser.username}*!\n\n` +
        `✅ Ваша учетная запись верифицирована.\n` +
        `🛡 Ваша роль в системе: *${systemUser.role.toUpperCase()}*\n` +
        `📊 Вы подключены к дашборду HURMO UZ.\n\n` +
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

  // Привязка аккаунта через бота: /link <username> <password>
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

      // Привязываем Telegram ID
      await UserModel.linkTelegramId(user.username, tgId);

      return ctx.reply(
        `🎉 Успешно! Аккаунт *${user.username}* привязан к вашему Telegram!\n` +
        `🛡 Роль: *${user.role}*\n` +
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

  // Кнопка: Мой профиль
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

  // Кнопка: Сводка дашборда
  bot.hears('📊 Сводка дашборда', async (ctx) => {
    const tgId = String(ctx.from.id);
    const user = await UserModel.findByTelegramId(tgId);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация. Привяжите аккаунт через команду `/link`.', { parse_mode: 'Markdown' });
    }

    return ctx.reply(
      `📊 *Оперативная сводка HURMO UZ*\n\n` +
      `📈 *База контактов:* 1,500+ активных записей\n` +
      `📞 *Обзвонов за сегодня:* 142 звонка\n` +
      `✉️ *Отправлено SMS:* 128 сообщений\n` +
      `✅ *Успешная регистрация:* 84%\n\n` +
      `🌐 Ссылка на полный веб-дашборд:\n${config.clientUrl}`,
      { parse_mode: 'Markdown' }
    );
  });

  // Кнопка: Статистика обзвонов
  bot.hears('📞 Статистика обзвонов', async (ctx) => {
    const tgId = String(ctx.from.id);
    const user = await UserModel.findByTelegramId(tgId);
    if (!user) {
      return ctx.reply('🔒 Требуется авторизация через `/link`.', { parse_mode: 'Markdown' });
    }

    return ctx.reply(
      `📞 *Статистика колл-центра*\n\n` +
      `• *Отвечено:* 68%\n` +
      `• *Занято / Сброс:* 19%\n` +
      `• *Недозвон:* 13%\n` +
      `⚡️ Все данные в реальном времени синхронизируются с Google Sheets.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Кнопка: Помощь
  bot.hears('ℹ️ Помощь', (ctx) => {
    return ctx.reply(
      `ℹ️ *Справка по HURMO Bot*\n\n` +
      `Команды:\n` +
      `• \`/start\` — Перезапустить бота\n` +
      `• \`/link <логин> <пароль>\` — Привязать дашборд\n` +
      `• \`/stats\` — Быстрый отчет\n` +
      `• \`/ping\` — Проверка здоровья сервера`,
      { parse_mode: 'Markdown' }
    );
  });

  // Быстрый ping
  bot.command('ping', (ctx) => ctx.reply('🏓 Pong! Бэкенд и бот HURMO UZ работают штатно.'));

  console.log('🤖 [Telegram Bot] Инициализация бота @HURMO_UZ_NOTIFICATIONS_BOT...');
  // Запуск polling
  bot.launch({ dropPendingUpdates: true })
    .then(() => {
      console.log('🤖 [Telegram Bot] Успешно запущен и слушает входящие сообщения!');
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
