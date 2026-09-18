const { Queue } = require('bullmq');

const CALL_QUEUE_NAME = process.env.CALL_QUEUE_NAME || 'call-submissions';

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

const callQueue = process.env.REDIS_URL
  ? new Queue(CALL_QUEUE_NAME, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: Number(process.env.CALL_QUEUE_ATTEMPTS || 8),
      backoff: {
        type: 'exponential',
        delay: Number(process.env.CALL_QUEUE_RETRY_DELAY_MS || 60_000),
      },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
    })
  : null;

async function enqueueCall(payload) {
  if (!callQueue) {
    throw new Error('Очередь звонков недоступна: REDIS_URL не настроен.');
  }

  const job = await callQueue.add('append-call', payload, {
    jobId: payload.idempotencyKey || undefined,
  });
  return { jobId: job.id, queue: CALL_QUEUE_NAME };
}

module.exports = {
  CALL_QUEUE_NAME,
  enqueueCall,
};
