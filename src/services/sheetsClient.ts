import { google, sheets_v4 } from 'googleapis';
const config = require('../config');

let sheetsApi: sheets_v4.Sheets | null = null;

function getAuthClient() {
  const email = config.google.clientEmail;
  let privateKey: string = config.google.privateKey;

  if (!email || !privateKey) {
    throw new Error('Отсутствуют GOOGLE_SERVICE_ACCOUNT_EMAIL или GOOGLE_PRIVATE_KEY в конфигурации сервера.');
  }
  if (privateKey.startsWith('"') && privateKey.endsWith('"')) privateKey = privateKey.slice(1, -1);
  if (privateKey.startsWith("'") && privateKey.endsWith("'")) privateKey = privateKey.slice(1, -1);
  privateKey = privateKey.replace(/\\n/g, '\n');

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

export function getSheetsApi(): sheets_v4.Sheets {
  if (!sheetsApi) {
    sheetsApi = google.sheets({ version: 'v4', auth: getAuthClient() });
  }
  return sheetsApi;
}

/**
 * Читает один лист целиком как сырые значения (без форматирования/метаданных),
 * автоматически определяя первый лист документа и его заголовки.
 * Возвращает { headers: string[], rows: string[][], rowCount?: number }
 */
export async function fetchSheetRaw(
  spreadsheetId: string,
  sheetTitleHint?: string
): Promise<{ headers: string[]; rows: string[][]; rowCount: number }> {
  const api = getSheetsApi();

  // 1. Узнаём реальное имя первого листа (или совпадающего с hint), без лишних метаданных.
  const meta = await api.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title,sheets.properties.sheetId,sheets.properties.index,sheets.properties.gridProperties.rowCount',
  });
  const sheetsList = meta.data.sheets || [];
  const targetSheet =
    (sheetTitleHint &&
      sheetsList.find((s) =>
        (s.properties?.title || '').toLowerCase().includes(sheetTitleHint.toLowerCase())
      )) ||
    sheetsList[0];
  const title = targetSheet?.properties?.title;
  if (!title) throw new Error(`Не найден лист в таблице ${spreadsheetId}`);
  const rowCount = targetSheet?.properties?.gridProperties?.rowCount || 0;

  // 2. Запрос за всеми значениями листа, без стилей/форматирования.
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title.replace(/'/g, "''")}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const values = (res.data.values || []) as (string | number | boolean | null)[][];
  if (values.length === 0) return { headers: [], rows: [], rowCount };

  const headers = (values[0] || []).map((h) => String(h ?? ''));
  const rows = values.slice(1).map((r) => r.map((c) => (c !== undefined && c !== null ? String(c) : '')));
  return { headers, rows, rowCount };
}

export async function fetchSheetDelta(
  spreadsheetId: string,
  startRow: number,
  sheetTitleHint?: string,
): Promise<{ rows: string[][]; rowCount: number }> {
  const api = getSheetsApi();
  const metadata = await getSheetMetadata(spreadsheetId, sheetTitleHint);
  if (metadata.rowCount < startRow) return { rows: [], rowCount: metadata.rowCount };

  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${metadata.title.replace(/'/g, "''")}'!A${startRow}:ZZZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const values = (res.data.values || []) as (string | number | boolean | null)[][];
  return {
    rows: values.map((row) => row.map((cell) => String(cell ?? ''))),
    rowCount: metadata.rowCount,
  };
}

export async function getSheetMetadata(
  spreadsheetId: string,
  sheetTitleHint?: string
): Promise<{ title: string; rowCount: number }> {
  const api = getSheetsApi();
  const meta = await api.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title,sheets.properties.sheetId,sheets.properties.index,sheets.properties.gridProperties.rowCount',
  });
  const sheetsList = meta.data.sheets || [];
  const targetSheet =
    (sheetTitleHint &&
      sheetsList.find((s) =>
        (s.properties?.title || '').toLowerCase().includes(sheetTitleHint.toLowerCase())
      )) ||
    sheetsList[0];
  const title = targetSheet?.properties?.title;
  if (!title) throw new Error(`Не найден лист в таблице ${spreadsheetId}`);
  return {
    title,
    rowCount: targetSheet?.properties?.gridProperties?.rowCount || 0,
  };
}

/**
 * Читает несколько листов за ОДИН HTTP-запрос через batchGet.
 */
export async function fetchSheetsBatch(
  spreadsheetId: string,
  ranges: string[]
): Promise<Record<string, string[][]>> {
  const api = getSheetsApi();
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const result: Record<string, string[][]> = {};
  (res.data.valueRanges || []).forEach((vr, i) => {
    result[ranges[i]] = (vr.values || []) as string[][];
  });
  return result;
}

/** Превращает сырые строки в объекты по заголовкам — заменяет row.get(header) из google-spreadsheet. */
export function rowsToObjects(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
    });
    // Совместимость с текущим кодом googleSheets.ts, который читает obj._columnD
    if (row[3] !== undefined && row[3] !== null) {
      obj._columnD = String(row[3]).trim();
    }
    return obj;
  });
}

/**
 * Читает только новые строки начиная с offset (1-based row number: offset + 2 с учётом заголовка)
 */
export async function fetchNewRowsOnly(
  spreadsheetId: string,
  startRowIndex: number,
  sheetTitleHint?: string
): Promise<{ rows: string[][] }> {
  const api = getSheetsApi();
  const { title } = await getSheetMetadata(spreadsheetId, sheetTitleHint);
  const startRow = startRowIndex + 2; // header is row 1
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title.replace(/'/g, "''")}'!A${startRow}:ZZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const values = (res.data.values || []) as (string | number | boolean | null)[][];
  const rows = values.map((r) => r.map((c) => (c !== undefined && c !== null ? String(c) : '')));
  return { rows };
}
