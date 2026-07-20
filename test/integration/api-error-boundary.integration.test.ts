import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiApp } from '../../src/system/api-system.js';
import { closeDb, migrate, pool } from '../../src/feature/db.js';
import { closeQueue } from '../../src/feature/queue.js';

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

describe('API async error boundary', () => {
  it('returns a sanitized 500 for an async Admin DB failure and keeps the process alive', async () => {
    const originalQuery = pool.query.bind(pool);
    (pool as unknown as { query: () => Promise<never> }).query = async () => {
      throw new Error('simulated database secret detail');
    };

    try {
      const response = await fetch(`${baseUrl}/admin/events`, {
        headers: { 'x-admin-token': process.env.ADMIN_TOKEN! }
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal server error' });
    } finally {
      (pool as unknown as { query: typeof originalQuery }).query = originalQuery;
    }

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});
