import { Job, Worker } from 'bullmq';
const config = require('../config');
import {
  CALL_QUEUE_NAME,
  CallQueuePayload,
} from './queue.service';
import { GoogleSheetsService, SheetRow } from './googleSheets.service';

function redisConnection() {
  const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
    password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
    maxRetriesPerRequest: null as null,
  };
}

function toRow(call: CallQueuePayload): SheetRow {
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

export function startCallWorker() {
  const sheets = new GoogleSheetsService({
    clientEmail: String(config.google.clientEmail || ''),
    privateKey: String(config.google.privateKey || ''),
    spreadsheetId: String(config.google.sheetCalls || ''),
    sheetName: process.env.GOOGLE_SHEET_CALLS_TAB || 'calls',
  });

  const batchSize = Math.max(1, Number(process.env.CALL_WORKER_BATCH_SIZE || 25));
  const batchWindowMs = Math.max(25, Number(process.env.CALL_WORKER_BATCH_WINDOW_MS || 200));
  type PendingJob = {
    job: Job<CallQueuePayload>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  let pending: PendingJob[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> = Promise.resolve();

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

  const enqueueForBatch = (job: Job<CallQueuePayload>) =>
    new Promise<void>((resolve, reject) => {
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

  const worker = new Worker<CallQueuePayload>(
    CALL_QUEUE_NAME,
    async (job: Job<CallQueuePayload>) => {
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
