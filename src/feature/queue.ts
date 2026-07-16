import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../part/env.js';
import { sanitizeText } from '../part/sanitize.js';

export const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const deliveryQueue = new Queue(env.QUEUE_NAME, { connection: redisConnection as any });

redisConnection.on('error', (err) => {
  console.warn(JSON.stringify({ level: 'warn', event: 'redis_connection_error', component: 'queue', message: 'Redis connection error; durable recovery remains PostgreSQL-backed', details: { error: sanitizeText(err, 300) } }));
});

deliveryQueue.on('error', (err) => {
  console.warn(JSON.stringify({ level: 'warn', event: 'bullmq_queue_error', component: 'queue', message: 'BullMQ queue error; enqueue remains best-effort', details: { error: sanitizeText(err, 300) } }));
});

export async function enqueueDelivery(deliveryId: string): Promise<void> {
  await deliveryQueue.add('deliver', { deliveryId }, { jobId: deliveryId, removeOnComplete: 1000, removeOnFail: 5000 });
}

export async function enqueueDeliveryBestEffort(deliveryId: string): Promise<boolean> {
  try {
    await Promise.race([
      enqueueDelivery(deliveryId),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Queue enqueue timeout')), env.QUEUE_ENQUEUE_TIMEOUT_MS))
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function closeQueue(): Promise<void> {
  await deliveryQueue.close();
  await redisConnection.quit();
}
