import crypto from 'node:crypto';
import http, { type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiApp } from '../../src/system/api-system.js';
import { processDelivery, publishOutboxBatch } from '../../src/system/worker-system.js';
import { closeDb, migrate, pool } from '../../src/feature/db.js';
import { closeQueue, deliveryQueue, redisConnection } from '../../src/feature/queue.js';

let apiServer: http.Server;
let receiverServer: http.Server;
let apiBaseUrl = '';
let receiverMode: 'success' | 'server_error' | 'gone' | 'large' = 'success';
let receiverCount = 0;
let lastReceiverBody = '';
let lastReceiverHeaders: IncomingHttpHeaders = {};

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('server address unavailable'));
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function githubHeaders(body: string, deliveryId: string, signatureOverride?: string): Record<string, string> {
  const signature = signatureOverride ?? `sha256=${crypto
    .createHmac('sha256', process.env.INBOUND_GITHUB_SECRET!)
    .update(body)
    .digest('hex')}`;
  return {
    'content-type': 'application/json',
    'x-hub-signature-256': signature,
    'x-github-delivery': deliveryId,
    'x-github-event': 'push'
  };
}

async function postGitHubWebhook(deliveryId: string, body = JSON.stringify({ ref: 'refs/heads/main' })) {
  const response = await fetch(`${apiBaseUrl}/ingress/github-main`, {
    method: 'POST',
    headers: githubHeaders(body, deliveryId),
    body
  });
  return { response, json: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  await migrate();
  await redisConnection.flushdb();

  receiverServer = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      receiverCount += 1;
      lastReceiverBody = Buffer.concat(chunks).toString('utf8');
      lastReceiverHeaders = request.headers;
      if (receiverMode === 'server_error') {
        response.statusCode = 503;
        response.end('temporary failure');
        return;
      }
      if (receiverMode === 'gone') {
        response.statusCode = 410;
        response.end('gone');
        return;
      }
      if (receiverMode === 'large') {
        response.statusCode = 200;
        response.end('x'.repeat(70_000));
        return;
      }
      response.statusCode = 202;
      response.setHeader('content-type', 'application/json');
      response.end('{"accepted":true}');
    });
  });
  await listen(receiverServer, 18080);

  apiServer = http.createServer(apiApp);
  const apiPort = await listen(apiServer, 0);
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;
});

beforeEach(async () => {
  receiverMode = 'success';
  receiverCount = 0;
  lastReceiverBody = '';
  lastReceiverHeaders = {};
  await pool.query('TRUNCATE TABLE delivery_outbox, deliveries, events, audit_logs RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM replay_locks');
  await redisConnection.flushdb();
});

afterAll(async () => {
  await closeServer(apiServer);
  await closeServer(receiverServer);
  await deliveryQueue.obliterate({ force: true }).catch(() => undefined);
  await closeQueue();
  await closeDb();
});

describe('Webhook Gateway real end-to-end flow', () => {
  it('rejects invalid signatures before durable persistence', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const response = await fetch(`${apiBaseUrl}/ingress/github-main`, {
      method: 'POST',
      headers: githubHeaders(body, crypto.randomUUID(), 'sha256=00'),
      body
    });
    expect(response.status).toBe(401);
    const count = await pool.query('SELECT count(*)::int AS count FROM events');
    expect(count.rows[0].count).toBe(0);
  });

  it('accepts a verified webhook only after event, delivery, and outbox are durable', async () => {
    const deliveryId = crypto.randomUUID();
    const first = await postGitHubWebhook(deliveryId);
    expect(first.response.status).toBe(202);
    expect(first.json).toMatchObject({ duplicate: false, deliveries: 1, enqueueMode: 'deferred+outbox' });

    const durable = await pool.query(
      `SELECT e.provider_event_id, d.status AS delivery_status, o.status AS outbox_status
       FROM events e
       JOIN deliveries d ON d.event_id=e.id
       JOIN delivery_outbox o ON o.delivery_id=d.id
       WHERE e.provider_event_id=$1`,
      [deliveryId]
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0].delivery_status).toBe('queued');
    expect(durable.rows[0].outbox_status).toBe('pending');

    const duplicate = await postGitHubWebhook(deliveryId);
    expect(duplicate.response.status).toBe(202);
    expect(duplicate.json).toMatchObject({ duplicate: true, deliveries: 0 });
    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM events) AS events,
         (SELECT count(*)::int FROM deliveries) AS deliveries,
         (SELECT count(*)::int FROM delivery_outbox) AS outbox`
    );
    expect(counts.rows[0]).toEqual({ events: 1, deliveries: 1, outbox: 1 });
  });

  it('publishes the transactional outbox to real BullMQ and marks it published', async () => {
    const accepted = await postGitHubWebhook(crypto.randomUUID());
    const deliveryId = String((await pool.query('SELECT id FROM deliveries LIMIT 1')).rows[0].id);
    expect(accepted.response.status).toBe(202);

    expect(await publishOutboxBatch()).toBeGreaterThanOrEqual(1);
    const outbox = await pool.query('SELECT status, published_at FROM delivery_outbox WHERE delivery_id=$1', [deliveryId]);
    expect(outbox.rows[0].status).toBe('published');
    expect(outbox.rows[0].published_at).not.toBeNull();
    expect(await deliveryQueue.getJob(deliveryId)).not.toBeNull();
  });

  it('delivers exactly once when duplicate workers race for the same delivery', async () => {
    const providerDeliveryId = crypto.randomUUID();
    await postGitHubWebhook(providerDeliveryId, JSON.stringify({ ref: 'refs/heads/feature' }));
    const deliveryId = String((await pool.query('SELECT id FROM deliveries LIMIT 1')).rows[0].id);

    await Promise.all([
      processDelivery(deliveryId),
      processDelivery(deliveryId),
      processDelivery(deliveryId)
    ]);

    expect(receiverCount).toBe(1);
    const row = await pool.query('SELECT status, attempt_count, delivered_at FROM deliveries WHERE id=$1', [deliveryId]);
    expect(row.rows[0].status).toBe('delivered');
    expect(row.rows[0].attempt_count).toBe(1);
    expect(row.rows[0].delivered_at).not.toBeNull();
    expect(JSON.parse(lastReceiverBody)).toMatchObject({ specversion: '1.0', type: 'push' });
    expect(lastReceiverHeaders['x-gace-delivery-id']).toBe(deliveryId);
    expect(lastReceiverHeaders['webhook-signature']).toMatch(/^v1,/);
  });

  it('classifies transient downstream failures for retry', async () => {
    receiverMode = 'server_error';
    await postGitHubWebhook(crypto.randomUUID());
    const deliveryId = String((await pool.query('SELECT id FROM deliveries LIMIT 1')).rows[0].id);

    await processDelivery(deliveryId);

    const row = await pool.query(
      'SELECT status, attempt_count, next_attempt_at, last_status_code FROM deliveries WHERE id=$1',
      [deliveryId]
    );
    expect(receiverCount).toBe(1);
    expect(row.rows[0].status).toBe('retrying');
    expect(row.rows[0].attempt_count).toBe(1);
    expect(row.rows[0].next_attempt_at).not.toBeNull();
    expect(row.rows[0].last_status_code).toBe(503);
  });

  it('stops retrying a destination that returns 410 Gone', async () => {
    receiverMode = 'gone';
    await postGitHubWebhook(crypto.randomUUID());
    const deliveryId = String((await pool.query('SELECT id FROM deliveries LIMIT 1')).rows[0].id);

    await processDelivery(deliveryId);

    const row = await pool.query('SELECT status, next_attempt_at, last_status_code FROM deliveries WHERE id=$1', [deliveryId]);
    expect(row.rows[0]).toMatchObject({ status: 'skipped', next_attempt_at: null, last_status_code: 410 });
  });

  it('bounds oversized downstream response bodies and schedules a safe retry', async () => {
    receiverMode = 'large';
    await postGitHubWebhook(crypto.randomUUID());
    const deliveryId = String((await pool.query('SELECT id FROM deliveries LIMIT 1')).rows[0].id);

    await processDelivery(deliveryId);

    const row = await pool.query('SELECT status, last_error FROM deliveries WHERE id=$1', [deliveryId]);
    expect(row.rows[0].status).toBe('retrying');
    expect(row.rows[0].last_error).toContain('DELIVERY_RESPONSE_BODY_TOO_LARGE');
  });
});
