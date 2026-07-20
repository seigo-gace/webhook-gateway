import crypto from 'node:crypto';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueue, deliveryQueue, enqueueDelivery, redisConnection } from '../../src/feature/queue.js';
import { env } from '../../src/part/env.js';

let worker: Worker | undefined;
let workerRedis: Redis | undefined;
let shouldFail = false;
const runs = new Map<string, number>();

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition timeout');
}

async function waitForRedisReady(): Promise<void> {
  await waitUntil(() => redisConnection.status === 'ready', 10_000);
  await redisConnection.ping();
}

async function jobRemoved(deliveryId: string): Promise<boolean> {
  return (await deliveryQueue.getJob(deliveryId)) == null;
}

beforeAll(async () => {
  await waitForRedisReady();
  await redisConnection.flushdb();
  workerRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  worker = new Worker(
    env.QUEUE_NAME,
    async (job) => {
      const deliveryId = String(job.data.deliveryId);
      runs.set(deliveryId, (runs.get(deliveryId) ?? 0) + 1);
      if (shouldFail) throw new Error('simulated queue processor failure');
    },
    { connection: workerRedis as never, concurrency: 1 }
  );
  await worker.waitUntilReady();
});

afterAll(async () => {
  if (worker) await worker.close();
  if (workerRedis && workerRedis.status !== 'end') await workerRedis.quit();
  await closeQueue();
});

describe('BullMQ transport lifecycle', () => {
  it('allows the same deliveryId to be enqueued again after successful completion', async () => {
    const deliveryId = crypto.randomUUID();
    shouldFail = false;

    await enqueueDelivery(deliveryId);
    await waitUntil(() => runs.get(deliveryId) === 1);
    await waitUntil(() => jobRemoved(deliveryId));

    await enqueueDelivery(deliveryId);
    await waitUntil(() => runs.get(deliveryId) === 2);
    await waitUntil(() => jobRemoved(deliveryId));

    expect(runs.get(deliveryId)).toBe(2);
  });

  it('allows recovery to reuse the same deliveryId after an unexpected failed job', async () => {
    const deliveryId = crypto.randomUUID();
    shouldFail = true;

    await enqueueDelivery(deliveryId);
    await waitUntil(() => runs.get(deliveryId) === 1);
    await waitUntil(() => jobRemoved(deliveryId));

    shouldFail = false;
    await enqueueDelivery(deliveryId);
    await waitUntil(() => runs.get(deliveryId) === 2);
    await waitUntil(() => jobRemoved(deliveryId));

    expect(runs.get(deliveryId)).toBe(2);
  });
});
