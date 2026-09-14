# HURMO UZ — Production Backend API & Telegram Service

Senior-level архитектура бэкенда для аналитической платформы HURMO UZ с поддержкой строгой авторизации (только вход), системы ролей (RBAC) и Telegram бота.

---

## 🛡️ Безопасность и архитектурные решения

1. **Авторизация (только Вход)**:
   - Отключены регистрация и сброс паролей в соответствии с требованиями безопасности закрытого корпоративного дашборда.
   - Пользователи создаются исключительно администратором.
   - Хеширование паролей с использованием **bcrypt** (salt rounds: 12).
   - Защита от тайминг-атак при проверке учетных записей.
   - Защита от перебора паролей (Brute-Force) с помощью **Rate Limiting** (`express-rate-limit`: максимум 7 попыток за 15 минут).
   - Выпуск подписанных **JWT (JSON Web Token)** с информацией о ролях и сроком действия 7 дней.

2. **Ролевая модель (RBAC - Role-Based Access Control)**:
   - `super_admin` — полный доступ ко всей инфраструктуре, создание пользователей и смена ролей.
   - `admin` — администратор, управление операторами, просмотр аналитики, выгрузка отчетов.
   - `manager` — аналитик, доступ ко всем KPI и расширенной аналитике.
   - `operator` — оператор колл-центра, работа с обращениями и статусами звонков.
   - `viewer` — наблюдатель, просмотр сводных отчетов.

3. **Защита HTTP-заголовков и сети**:
   - **Helmet** — HSTS, X-Content-Type-Options, X-Frame-Options, DNS prefetch control.
   - **CORS** с белым списком доверенных доменов фронтенда.
   - Ограничение размера входного тела запроса (`limit: '10kb'`) для предотвращения DoS-атак через переполнение буфера.
   - Централизованная обработка ошибок с безопасным сокрытием stack trace в продакшене.

4. **Пользователи и база данных**:
   - Пользователи хранятся в PostgreSQL; при первом запуске создаётся один главный аккаунт из `ADMIN_USERNAME` и `ADMIN_PASSWORD`.
   - `JWT_SECRET` обязателен и должен содержать минимум 32 случайных символа. `ADMIN_PASSWORD` обязателен и должен содержать минимум 12 символов; небезопасных паролей по умолчанию нет.
   - Для удалённого PostgreSQL TLS включён по умолчанию и проверяет сертификат (`DB_SSL=true`). Отключайте его только для локальной разработки.
   - Только главный администратор (`super_admin`) может создавать пользователей, назначать им роль и выбирать доступные страницы.
   - Второй `super_admin` создать нельзя. Для новых пользователей доступны роли `admin`, `manager`, `operator` и `viewer`.
   - Если страница не выбрана, она скрывается в меню, а прямой переход на неё возвращает 404.
   - Redis нужен для очереди звонков. Если `DATABASE_URL` не задан локально, используется временный in-memory fallback.

5. **Telegram Bot (@HURMO_UZ_NOTIFICATIONS_BOT)**:
   - Токен: задаётся через переменную окружения `TELEGRAM_BOT_TOKEN` (см. `.env.example`)
   - Команды:
     - `/start` — приветствие и меню действий.
     - `/link <логин> <пароль>` — привязка Telegram-аккаунта сотрудника к учетной записи в дашборде с подтверждением роли.
     - `📊 Сводка дашборда` — оперативные KPI за сегодня.
     - `📞 Статистика обзвонов` — конверсия и статистика операторов колл-центра.
     - `👤 Мой профиль` — просмотр своей роли и статуса в системе.

## 🚀 Запуск и команды

```bash
cd if_dashboard_backend

# Запуск в режиме разработки / продакшн
npm start
# или
npm run dev
```

---

## 📡 Спецификация API

### 1. Авторизация
- **POST** `/api/auth/login`
  - Body: `{ "username": "admin", "password": "<ADMIN_PASSWORD>" }`
  - Ответ: `JWT Token`, данные пользователя и его разрешения.
- **GET** `/api/auth/me`
  - Headers: `Authorization: Bearer <TOKEN>`
  - Ответ: Профиль текущего авторизованного пользователя.
- **POST** `/api/auth/logout`
  - Headers: `Authorization: Bearer <TOKEN>`

### 2. Управление ролями и операторами (RBAC)
- **GET** `/api/admin/roles` — список ролей (только `super_admin`).
- **GET** `/api/admin/users` — список сотрудников (только `super_admin`).
- **POST** `/api/admin/users` — создание пользователя (только `super_admin`) с массивом `permissions`.
- **PATCH** `/api/admin/users/:userId/role` — изменение роли пользователя.

### 3. Системный статус
- **GET** `/health` — проверка доступности и времени работы сервиса.
## Queue-based call ingestion

`POST /api/calls` accepts a call submission and immediately returns HTTP `202`:

```json
{
  "operatorId": "operator-17",
  "phone": "+998901234567",
  "startedAt": "2026-09-14T13:00:00.000Z",
  "endedAt": "2026-09-14T13:04:00.000Z",
  "status": "completed",
  "comment": "Клиент подтвердил регистрацию",
  "idempotencyKey": "call-unique-id-123"
}
```

The request is stored in BullMQ/Redis. A worker appends calls to Google Sheets in batches (`CALL_BATCH_SIZE`, default `50`) every two seconds. Google API failures are retried up to eight times with exponential backoff starting at one minute. All backend replicas consume the same Redis queue, so a failed instance does not lose acknowledged jobs.

Required environment variables:

- `REDIS_URL`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SHEET_CALLS`
- optional `GOOGLE_SHEET_CALLS_TAB`, `CALL_WORKER_BATCH_SIZE`, `CALL_WORKER_BATCH_WINDOW_MS`, `CALL_WORKER_CONCURRENCY`

### Local Docker test

From the repository root:

```bash
docker compose up --build -d
curl http://localhost:8080/health
docker compose ps
```

The health endpoint returns `{"status":"OK"}`. To simulate an instance failure while keeping the service available:

```bash
docker compose stop backend-1
curl http://localhost:8080/health
docker compose logs -f backend-2
docker compose start backend-1
```

Requests continue through `backend-2`, while already queued calls remain in Redis and are processed by the surviving worker.
