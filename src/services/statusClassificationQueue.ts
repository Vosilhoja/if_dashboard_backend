const { Queue, Worker } = require('bullmq');
const config = require('../config');
const { fetchAllRowsForSheet } = require('./googleSheets');
const { classifyBatch } = require('./statusClassifier');
const { createSuggestions } = require('./statusSuggestionService');

const queueName = process.env.STATUS_CLASSIFICATION_QUEUE_NAME || 'status-classifications';
const enabled = Boolean(process.env.REDIS_URL);
const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
  username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
  maxRetriesPerRequest: null,
};

const queue = enabled
  ? new Queue(queueName, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  })
  : null;

function statusText(row) {
  return String(
    row['Коментарий'] || row['Комментарий'] || row['Статус'] ||
    row['Status'] || row['status'] || row.comment || row.Comment || ''
  ).trim();
}

async function enqueueUnmatchedClassification() {
  if (!queue) throw new Error('REDIS_URL не настроен');
  const rows = await fetchAllRowsForSheet('numbers', true);
  const texts = [...new Set(rows.map(statusText).filter(Boolean))];
  const job = await queue.add('classify-unmatched', { texts }, { jobId: `status-${Date.now()}` });
  return { jobId: job.id, uniqueTexts: texts.length };
}

function startStatusClassifierWorker() {
  if (!queue) {
    console.warn('[StatusClassifier] REDIS_URL не задан, batch worker отключен');
    return null;
  }
  const worker = new Worker(queueName, async (job) => {
    const texts = Array.isArray(job.data?.texts) ? job.data.texts : [];
    const batchSize = Number(process.env.STATUS_CLASSIFICATION_BATCH_SIZE || 20);
    let classified = 0;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      await classifyBatch(batch);
      classified += batch.length;
      if (i + batchSize < texts.length) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.STATUS_CLASSIFICATION_BATCH_DELAY_MS || 1000)));
      }
    }
    const suggestions = await createSuggestions();
    console.log(JSON.stringify({
      event: 'status_classification_batch_completed',
      jobId: job.id,
      classified,
      suggestions: suggestions.length,
    }));
    return { classified, suggestions: suggestions.length };
  }, { connection });
  worker.on('failed', (job, error) => console.error('[StatusClassifier] batch failed:', job?.id, error.message));
  worker.on('error', (error) => console.error('[StatusClassifier] worker error:', error.message));
  return worker;
}

function startStatusSuggestionScheduler() {
  const dayMs = 24 * 60 * 60 * 1000;
  const run = () => createSuggestions().catch((error) =>
    console.error('[StatusClassifier] suggestion scheduler failed:', error.message)
  );
  setInterval(run, dayMs);
}

module.exports = { enqueueUnmatchedClassification, startStatusClassifierWorker, startStatusSuggestionScheduler };
