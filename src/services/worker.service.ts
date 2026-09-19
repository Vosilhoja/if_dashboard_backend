const { Job, Worker } = require('bullmq');
const config = require('../config');
const {
  CALL_QUEUE_NAME,
} = require('./queue.service');
const { GoogleSheetsService } = require('./googleSheets.service');

function redisConnection() {
  const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
    password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
    maxRetriesPerRequest: null,
  };
}

function toRow(call) {
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

function startCallWorker() {
  const clientEmail = String(config.google.clientEmail || '').trim();
  const privateKey = String(config.google.privateKey || '').trim();
  const spreadsheetId = String(config.google.sheetCalls || '').trim();

  if (!clientEmail || !privateKey || !spreadsheetId) {
    console.warn(
      '[Call worker] Google Sheets не настроен. Worker отключен; добавьте GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY и GOOGLE_SHEET_CALLS в конфигурацию окружения сервера.'
    );
    return null;
  }

  const sheets = new GoogleSheetsService({
    clientEmail,
    privateKey,
    spreadsheetId,
    sheetName: process.env.GOOGLE_SHEET_CALLS_TAB || 'calls',
  });

  const batchSize = Math.max(1, Number(process.env.CALL_WORKER_BATCH_SIZE || 25));
  const batchWindowMs = Math.max(25, Number(process.env.CALL_WORKER_BATCH_WINDOW_MS || 200));
  let pending = [];
  let flushTimer;
  let flushing = Promise.resolve();

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const rows = batch.map(({ job }) => toRow(job.data));
    try {
      await sheets.appendRows(rows);
      batch.forEach(({ resolve }) => resolve());
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      batch.forEach(({ reject }) => reject(failure));
    }
  };

  const enqueueForBatch = (job) =>
    new Promise((resolve, reject) => {
      pending.push({ job, resolve, reject });
      if (pending.length >= batchSize) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        flushing = flushing.then(flush);
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          flushing = flushing.then(flush);
        }, batchWindowMs);
      }
    });

  const worker = new Worker(
    CALL_QUEUE_NAME,
    async (job) => {
      await enqueueForBatch(job);
    },
    {
      connection: redisConnection(),
      concurrency: Number(process.env.CALL_WORKER_CONCURRENCY || 10),
    }
  );

  worker.on('completed', (job) => {
    console.log(`[Call worker] job ${job.id} completed`);
  });
  worker.on('failed', (job, error) => {
    console.error(`[Call worker] job ${job?.id || 'unknown'} failed: ${error.message}`);
  });
  worker.on('error', (error) => {
    console.error('[Call worker] worker error:', error);
  });

  return worker;
}

module.exports = {
  startCallWorker,
};
