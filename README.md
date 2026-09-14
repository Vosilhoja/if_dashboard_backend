# HURMO UZ Backend

Backend API, Google Sheets synchronization, call queue, RBAC and AI services for the HURMO UZ dashboard.

## Quick start

```bash
cd if_dashboard_backend
npm ci
copy .env.example .env
# Fill the required values in .env
npm run type-check
npm run build
npm start
```

The default API URL is `http://localhost:5000`. Check it with:

```bash
curl http://localhost:5000/health
```

Use `npm run dev` for development.

## Required environment

Start with `.env.example`. At minimum:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | JWT signing secret, at least 32 characters |
| `ADMIN_PASSWORD` | Initial `super_admin` password, at least 12 characters |
| `CLIENT_URL` | Allowed frontend origin |
| `DATABASE_URL` | PostgreSQL connection for persistent users |

If PostgreSQL is not available locally, set `DB_ENABLED=false` to use the development in-memory fallback. Do not use that fallback in production.

For analytics, configure:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_MAIN=...
GOOGLE_SHEET_NUMBERS=...
GOOGLE_SHEET_ESKIZ=...
GOOGLE_SHEET_NOT_COMPLETED=...
```

The Google service account must have access to all source spreadsheets.

## Redis and call queue

The call ingestion endpoint stores jobs in BullMQ/Redis and the worker appends them to Google Sheets in batches:

```env
REDIS_URL=redis://127.0.0.1:6379
GOOGLE_SHEET_CALLS=...
GOOGLE_SHEET_CALLS_TAB=calls
CALL_BATCH_SIZE=50
CALL_BATCH_DELAY_MS=2000
```

Jobs are idempotent when `idempotencyKey` is supplied. Google API failures are retried with exponential backoff. If Redis is unavailable, the API can still start, but queued call ingestion is unavailable until Redis is restored.

## Authentication and roles

- `super_admin` — full access, including users and settings.
- `admin` — administrative operations allowed by backend policy.
- `manager` — analytics and reporting.
- `operator` — call-center operations.
- `viewer` — read-only dashboard access.

Important routes:

| Method | Route | Access |
|---|---|---|
| `POST` | `/api/auth/login` | Public |
| `GET` | `/api/auth/me` | Authenticated |
| `GET` | `/api/data` | Authenticated |
| `GET` | `/api/admin/users` | `admin`, `super_admin` |
| `POST` | `/api/calls` | Authenticated |
| `POST` | `/api/ai/chat` | Authenticated |
| `POST` | `/api/ai/insights` | Authenticated |
| `GET` | `/health` | Public |

Use `Authorization: Bearer <token>` for backend API calls. The frontend normally sends this through its server-side proxy.

## AI chat

Gemini keys belong only in the backend environment:

```env
GEMINI_API_KEY=...
GEMINI_API_KEY_2=...
GEMINI_API_KEY_3=...
GEMINI_API_KEY_4=...
AI_REQUEST_TIMEOUT_MS=45000
```

`POST /api/ai/chat` accepts a message history, period, region and optional metrics context:

```json
{
  "messages": [
    { "role": "user", "content": "Где главная потеря воронки?" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "А что ты имеешь в виду?" }
  ],
  "period": {
    "startDate": "2026-09-01",
    "endDate": "2026-09-15"
  },
  "selectedRegion": "Ташкент"
}
```

The backend keeps the latest useful context, injects current dashboard aggregates and user role, and prevents excessively large histories. Provider order is Gemini, optional OpenAI-compatible API, then the local analytical fallback. The fallback uses real aggregates and does not invent figures.

Optional OpenAI-compatible configuration:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

## Data behavior

The Google Sheets layer:

- caches complete snapshots for a short TTL;
- prewarms the main sources at startup;
- limits prewarm wait with `DATA_PREWARM_TIMEOUT_MS` (default 10 seconds);
- refreshes data in the background;
- attributes “from support” only when the support contact is on or before the registration date;
- counts unique normalized phone numbers.

The timeout means a slow Google API does not block `/health` or prevent the server from starting.

## Security

- Helmet security headers.
- Strict CORS allowlist.
- JWT authentication and bcrypt password hashing.
- Rate limits for API and AI endpoints.
- Request payload limits.
- Sensitive authorization headers are redacted in structured logs.
- Never commit `.env`, private keys, API keys or bot tokens.

## Validation

```bash
npm run type-check
npm run build
npm audit --audit-level=high
```

There is currently no backend test runner configured; `npm test` is intentionally not used as a validation command yet.

