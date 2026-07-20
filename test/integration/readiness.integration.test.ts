import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiApp } from '../../src/system/api-system.js';
import { closeDb, migrate } from '../../src/feature/db.js';
import { closeQueue, redisConnection } from '../../src/feature/queue.js';

let server: http.Server;
let baseUrl = '';

function listen(instance: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => {
      instance.off('error', reject);
      const address = instance.address();
      if (!address || typeof address === 'string') return reject(new Error('server address unavailable'));
      resolve(address.port);
    });
  });
}

function closeServer(instance: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    instance.close((error) => error ? reject(error) : resolve());
  });
}

beforeAll(async () => {
  await migrate();
  server = http.createServer(apiApp);
  baseUrl = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await closeServer(server);
  await closeQueue();
  await closeDb();
});

describe('P0 readiness degradation', () => {
  it('keeps ingress ready when Redis is unavailable and reports degraded delivery transport', async () => {
    const originalPing = redisConnection.ping.bind(redisConnection);
    (redisConnection as unknown as { ping: () => Promise<string> }).ping = async () => {
      throw new Error('simulated redis outage');
    };

    try {
      const response = await fetch(`${baseUrl}/readyz`);
      const body = await response.json() as {
        ok: boolean;
        checks: { redis: { ok: boolean; requiredForIngress: boolean; degraded: boolean; error: string } };
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.checks.redis).toMatchObject({
        ok: false,
        requiredForIngress: false,
        degraded: true
      });
      expect(body.checks.redis.error).toContain('simulated redis outage');
    } finally {
      (redisConnection as unknown as { ping: () => Promise<string> }).ping = originalPing;
    }
  });
});
