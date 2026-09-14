const { Queue, Worker } = require('bullmq');
const { google } = require('googleapis');
const config = require('../config');

const QUEUE_NAME = process.env.CALL_QUEUE_NAME || 'call-submissions';
const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
  username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
  maxRetriesPerRequest: null,
};

const callQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  },
});

function getSheetsClient() {
  const privateKey = String(config.google.privateKey || '').replace(/\\n/g, '\n');
  if (!config.google.clientEmail || !privateKey || !config.google.sheetCalls) {
    throw new Error('Для очереди звонков нужны GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY и GOOGLE_SHEET_CALLS.');
  }

  const auth = new google.auth.JWT({
    email: config.google.clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function toSheetRow(call) {
  return [
    new Date().toISOString(),
    call.operatorId,
    call.phone,
    call.startedAt,
    call.endedAt || '',
    call.status,
    call.comment || '',
    call.clientName || '',
    call.metadata ? JSON.stringify(call.metadata) : '',
  ];
}

async function enqueueCall(call) {
  const job = await callQueue.add('append-call', call, {
    jobId: call.idempotencyKey || undefined,
  });
  return { jobId: job.id, queue: QUEUE_NAME };
}

function startCallQueueWorker() {
  const pending = [];
  let flushTimer = null;
  const batchSize = Number(process.env.CALL_BATCH_SIZE || 50);
  const batchDelayMs = Number(process.env.CALL_BATCH_DELAY_MS || 2_000);

  const flush = async () => {
    flushTimer = null;
    if (pending.length === 0) return;
    const batch = pending.splice(0, batchSize);
    try {
      const sheets = getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.google.sheetCalls,
        range: `${process.env.GOOGLE_SHEET_CALLS_TAB || 'calls'}!A:I`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: batch.map(({ job }) => toSheetRow(job.data)) },
      });
      batch.forEach(({ resolve }) => resolve());
    } catch (error) {
      console.error('[Call queue] Google Sheets batch failed:', error.message || error);
      batch.forEach(({ reject }) => reject(error));
    }
    if (pending.length > 0 && !flushTimer) {
      flushTimer = setTimeout(() => void flush(), batchDelayMs);
    }
  };

  const worker = new Worker(
    QUEUE_NAME,
    async (job) =>
      new Promise((resolve, reject) => {
        pending.push({ job, resolve, reject });
        if (pending.length >= batchSize) void flush();
        else if (!flushTimer) flushTimer = setTimeout(() => void flush(), batchDelayMs);
      }),
    { connection, concurrency: batchSize }
  );

  worker.on('completed', (job) => console.log(`[Call queue] job ${job.id} completed`));
  worker.on('failed', (job, error) => {
    console.error(`[Call queue] job ${job?.id || 'unknown'} failed:`, error.message);
  });
  worker.on('error', (error) => console.error('[Call queue] worker error:', error));
  return worker;
}

module.exports = { enqueueCall, startCallQueueWorker, callQueue };
