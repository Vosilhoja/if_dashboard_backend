const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const config = require('../config');
const { pool, isPgConnected } = require('../db');

const memoryConnections = new Map();
const calendarScopes = ['https://www.googleapis.com/auth/calendar'];

function encryptionKey() {
  const encoded = String(process.env.TELEGRAM_ENCRYPTION_KEY || '').trim();
  if (!encoded) throw new Error('TELEGRAM_ENCRYPTION_KEY не настроен');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('TELEGRAM_ENCRYPTION_KEY должен быть base64-ключом длиной 32 байта');
  return key;
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join('.');
}

function decrypt(value: string) {
  const [iv, tag, ciphertext] = String(value).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function oauthClient() {
  if (!config.google.oauthClientId || !config.google.oauthClientSecret || !config.google.oauthRedirectUri) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET и GOOGLE_OAUTH_REDIRECT_URI не настроены');
  }
  return new google.auth.OAuth2(config.google.oauthClientId, config.google.oauthClientSecret, config.google.oauthRedirectUri);
}

async function getConnection(userId: number) {
  if (isPgConnected() && pool) {
    const result = await pool.query('SELECT * FROM google_calendar_connections WHERE user_id = $1', [userId]);
    return result.rows[0] || null;
  }
  return memoryConnections.get(String(userId)) || null;
}

async function saveConnection(userId: number, refreshToken: string, calendarId = 'primary', email?: string) {
  const encrypted = encrypt(refreshToken);
  if (isPgConnected() && pool) {
    await pool.query(
      `INSERT INTO google_calendar_connections (user_id, refresh_token_encrypted, calendar_id, email)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       calendar_id = EXCLUDED.calendar_id, email = COALESCE(EXCLUDED.email, google_calendar_connections.email),
       updated_at = CURRENT_TIMESTAMP`,
      [userId, encrypted, calendarId, email || null],
    );
  } else {
    memoryConnections.set(String(userId), { user_id: userId, refresh_token_encrypted: encrypted, calendar_id: calendarId, email });
  }
}

export function getGoogleCalendarAuthUrl(userId: number) {
  const state = jwt.sign({ purpose: 'google-calendar-oauth', userId }, config.jwt.secret, { expiresIn: '10m' });
  return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: calendarScopes, state });
}

export async function handleGoogleCalendarCallback(code: string, state: string) {
  const payload = jwt.verify(state, config.jwt.secret) as { purpose: string; userId: number };
  if (payload.purpose !== 'google-calendar-oauth') throw new Error('Недействительный OAuth state');
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google не вернул refresh token. Повторите подключение.');
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ auth: client, version: 'v2' });
  const profile = await oauth2.userinfo.get();
  await saveConnection(payload.userId, tokens.refresh_token, 'primary', profile.data.email || undefined);
  return payload.userId;
}

async function authorizedClient(userId: number) {
  const connection = await getConnection(userId);
  if (!connection) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(connection.refresh_token_encrypted) });
  await client.getAccessToken();
  return { client, connection };
}

export async function getGoogleCalendarStatus(userId: number) {
  const connection = await getConnection(userId);
  return { connected: Boolean(connection), email: connection?.email || null, calendarId: connection?.calendar_id || 'primary' };
}

function mapEvent(event: any) {
  return {
    id: event.id,
    title: event.summary || 'Без названия',
    description: event.description || '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    location: event.location || '',
    url: event.htmlLink || '',
    allDay: Boolean(event.start?.date),
  };
}

export async function listGoogleCalendarEvents(userId: number, options: { timeMin?: string; timeMax?: string } = {}) {
  const authorized = await authorizedClient(userId);
  if (!authorized) return null;
  const calendar = google.calendar({ version: 'v3', auth: authorized.client });
  const result = await calendar.events.list({
    calendarId: authorized.connection.calendar_id || 'primary',
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
    timeMin: options.timeMin ? new Date(options.timeMin).toISOString() : undefined,
    timeMax: options.timeMax ? new Date(options.timeMax).toISOString() : undefined,
  });
  return (result.data.items || []).map(mapEvent);
}

export async function createGoogleCalendarEvent(userId: number, body: any) {
  const authorized = await authorizedClient(userId);
  if (!authorized) return null;
  const calendar = google.calendar({ version: 'v3', auth: authorized.client });
  const result = await calendar.events.insert({ calendarId: authorized.connection.calendar_id || 'primary', requestBody: toGoogleEvent(body) });
  return mapEvent(result.data);
}

export async function updateGoogleCalendarEvent(userId: number, eventId: string, body: any) {
  const authorized = await authorizedClient(userId);
  if (!authorized) return null;
  const calendar = google.calendar({ version: 'v3', auth: authorized.client });
  const result = await calendar.events.update({ calendarId: authorized.connection.calendar_id || 'primary', eventId, requestBody: toGoogleEvent(body) });
  return mapEvent(result.data);
}

export async function deleteGoogleCalendarEvent(userId: number, eventId: string) {
  const authorized = await authorizedClient(userId);
  if (!authorized) return null;
  const calendar = google.calendar({ version: 'v3', auth: authorized.client });
  await calendar.events.delete({ calendarId: authorized.connection.calendar_id || 'primary', eventId });
  return true;
}

function toGoogleEvent(body: any) {
  const start = body.allDay ? { date: String(body.start).slice(0, 10) } : { dateTime: new Date(body.start).toISOString() };
  const end = body.allDay ? { date: String(body.end || body.start).slice(0, 10) } : { dateTime: new Date(body.end || body.start).toISOString() };
  return { summary: body.title, description: body.description || '', location: body.location || '', start, end };
}
