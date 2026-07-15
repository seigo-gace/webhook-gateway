import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';

export const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const deliveryQueue = new Queue(env.QUEUE_NAME, { connection: redisConnection as any });

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
