import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env.js';

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const deliveryQueue = new Queue(env.QUEUE_NAME, {
  connection: redisConnection as any
});

export async function enqueueDelivery(deliveryId: string): Promise<void> {
  await deliveryQueue.add('deliver', { deliveryId }, { jobId: deliveryId, removeOnComplete: 1000, removeOnFail: 5000 });
}

export async function closeQueue(): Promise<void> {
  await deliveryQueue.close();
  await redisConnection.quit();
}
