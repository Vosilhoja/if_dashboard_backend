import { google, sheets_v4 } from 'googleapis';

export interface GoogleSheetsConfig {
  clientEmail: string;
  privateKey: string;
  spreadsheetId: string;
  sheetName?: string;
}

export type SheetRow = Array<string | number | boolean | null>;

export class GoogleSheetsService {
  private readonly client: sheets_v4.Sheets;
  private readonly config: GoogleSheetsConfig;

  constructor(config: GoogleSheetsConfig) {
    const privateKey = config.privateKey
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\n/g, '\n');

    if (!config.clientEmail || !privateKey || !config.spreadsheetId) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY и GOOGLE_SHEET_CALLS обязательны.'
      );
    }

    this.config = { ...config, privateKey };
    const auth = new google.auth.JWT({
      email: config.clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.client = google.sheets({ version: 'v4', auth });
  }

  async appendRows(rows: SheetRow[]): Promise<void> {
    if (rows.length === 0) return;

    await this.client.spreadsheets.values.append({
      spreadsheetId: this.config.spreadsheetId,
      range: `${this.config.sheetName || 'calls'}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }
}
