import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../part/env.js';
import { sanitizeText } from '../part/sanitize.js';

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false
});
export const deliveryQueue = new Queue(env.QUEUE_NAME, { connection: redisConnection as never });

redisConnection.on('error', (error) => {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'redis_connection_error',
    component: 'queue',
    message: 'Redis connection error; durable recovery remains PostgreSQL-backed',
    details: { error: sanitizeText(error, 300) }
  }));
});

deliveryQueue.on('error', (error) => {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'bullmq_queue_error',
    component: 'queue',
    message: 'BullMQ queue error; enqueue remains best effort',
    details: { error: sanitizeText(error, 300) }
  }));
});

export async function enqueueDelivery(deliveryId: string): Promise<void> {
  // PostgreSQL is the delivery history. Queue records are transport-only and
  // must disappear after either outcome so recovery/Admin replay can reuse the
  // stable deliveryId without being suppressed by a completed/failed tombstone.
  await deliveryQueue.add(
    'deliver',
    { deliveryId },
    {
      jobId: deliveryId,
      removeOnComplete: true,
      removeOnFail: true
    }
  );
}

export async function enqueueDeliveryBestEffort(deliveryId: string): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Queue enqueue timeout')), env.QUEUE_ENQUEUE_TIMEOUT_MS);
      timeout.unref?.();
    });
    await Promise.race([enqueueDelivery(deliveryId), timeoutPromise]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function enqueueDeliveryDeferred(deliveryId: string): void {
  void enqueueDeliveryBestEffort(deliveryId);
}

export async function closeQueue(): Promise<void> {
  await deliveryQueue.close();
  await redisConnection.quit();
}
