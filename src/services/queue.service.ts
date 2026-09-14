import { Queue } from 'bullmq';

export interface CallQueuePayload {
  operatorId: string;
  phone: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  comment?: string;
  clientName?: string;
  metadata?: Record<string, string | number | boolean | null>;
  idempotencyKey?: string;
}

export const CALL_QUEUE_NAME = process.env.CALL_QUEUE_NAME || 'call-submissions';

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

export const callQueue = new Queue<CallQueuePayload>(CALL_QUEUE_NAME, {
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
});

export async function enqueueCall(payload: CallQueuePayload) {
  const job = await callQueue.add('append-call', payload, {
    jobId: payload.idempotencyKey || undefined,
  });
  return { jobId: job.id, queue: CALL_QUEUE_NAME };
}
