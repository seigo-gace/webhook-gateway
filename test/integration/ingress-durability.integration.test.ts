import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiApp } from '../../src/system/api-system.js';
import { closeDb, migrate, pool } from '../../src/feature/db.js';
import { closeQueue, redisConnection } from '../../src/feature/queue.js';
import { env } from '../../src/part/env.js';
import { listSpoolFiles, readSpoolFile } from '../../src/feature/spool.js';

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

function signedHeaders(body: string, deliveryId: string): Record<string, string> {
  const signature = crypto
    .createHmac('sha256', process.env.INBOUND_GITHUB_SECRET!)
    .update(body)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${signature}`,
    'x-github-delivery': deliveryId,
    'x-github-event': 'push'
  };
}

async function sendWebhook(deliveryId: string, body: string) {
  const response = await fetch(`${baseUrl}/ingress/github-main`, {
    method: 'POST',
    headers: signedHeaders(body, deliveryId),
    body
  });
  return {
    response,
    json: await response.json() as Record<string, unknown>
  };
}

async function resetSpoolDirectory(): Promise<void> {
  await fs.rm(env.SPOOL_DIR, { recursive: true, force: true });
  await fs.mkdir(env.SPOOL_DIR, { recursive: true, mode: 0o700 });
}

beforeAll(async () => {
  await migrate();
  server = http.createServer(apiApp);
  baseUrl = `http://127.0.0.1:${await listen(server)}`;
});

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE delivery_outbox, deliveries, events, audit_logs RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM replay_locks');
  await redisConnection.flushdb();
  await resetSpoolDirectory();
});

afterAll(async () => {
  await resetSpoolDirectory();
  await closeServer(server);
  await closeQueue();
  await closeDb();
});

describe('P0 ingress durability under failure and concurrency', () => {
  it('returns 202 only after an encrypted spool record commits when PostgreSQL is unavailable', async () => {
    const originalConnect = pool.connect.bind(pool);
    (pool as unknown as { connect: () => Promise<never> }).connect = async () => {
      throw new Error('simulated postgres outage');
    };

    const body = JSON.stringify({ sensitive: 'db-outage-sensitive-payload' });
    try {
      const result = await sendWebhook(crypto.randomUUID(), body);
      expect(result.response.status).toBe(202);
      expect(result.json).toMatchObject({ ok: true, spooled: true });

      const files = await listSpoolFiles();
      expect(files).toHaveLength(1);
      expect(path.extname(files[0])).toBe('.spool');
      const raw = await fs.readFile(files[0], 'utf8');
      expect(raw).not.toContain('db-outage-sensitive-payload');
      const restored = await readSpoolFile(files[0]);
      expect(restored.body).toBe(body);
    } finally {
      (pool as unknown as { connect: typeof originalConnect }).connect = originalConnect;
    }
  });

  it('returns 503 when PostgreSQL and the emergency spool are both unavailable', async () => {
    const originalConnect = pool.connect.bind(pool);
    (pool as unknown as { connect: () => Promise<never> }).connect = async () => {
      throw new Error('simulated postgres outage');
    };
    await fs.rm(env.SPOOL_DIR, { recursive: true, force: true });
    await fs.writeFile(env.SPOOL_DIR, 'blocks-directory-creation');

    try {
      const result = await sendWebhook(
        crypto.randomUUID(),
        JSON.stringify({ failure: 'db-and-spool' })
      );
      expect(result.response.status).toBe(503);
      expect(result.json).toEqual({ ok: false, error: 'durable storage unavailable' });
    } finally {
      (pool as unknown as { connect: typeof originalConnect }).connect = originalConnect;
      await resetSpoolDirectory();
    }
  });

  it('deduplicates concurrent retries of the same provider event into one durable delivery intent', async () => {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({ ref: 'refs/heads/concurrent' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => sendWebhook(deliveryId, body))
    );

    expect(results.every((result) => result.response.status === 202)).toBe(true);
    expect(results.filter((result) => result.json.duplicate === false)).toHaveLength(1);
    expect(results.filter((result) => result.json.duplicate === true)).toHaveLength(19);

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM events WHERE provider_event_id=$1) AS events,
         (SELECT count(*)::int FROM deliveries d JOIN events e ON e.id=d.event_id WHERE e.provider_event_id=$1) AS deliveries,
         (SELECT count(*)::int FROM delivery_outbox o JOIN deliveries d ON d.id=o.delivery_id JOIN events e ON e.id=d.event_id WHERE e.provider_event_id=$1) AS outbox`,
      [deliveryId]
    );
    expect(counts.rows[0]).toEqual({ events: 1, deliveries: 1, outbox: 1 });
  });
});
