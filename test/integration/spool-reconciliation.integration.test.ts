import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, insertEvent, migrate, pool } from '../../src/feature/db.js';
import { closeQueue, redisConnection } from '../../src/feature/queue.js';
import { writeSpoolFile } from '../../src/feature/spool.js';
import { importSpoolFile } from '../../src/system/worker-system.js';

beforeAll(async () => {
  await migrate();
  await redisConnection.flushdb();
});

afterAll(async () => {
  await closeQueue();
  await closeDb();
});

describe('emergency spool reconciliation', () => {
  it('creates missing delivery and outbox rows when the event already exists', async () => {
    const providerEventId = `spool-reconcile-${crypto.randomUUID()}`;
    const body = JSON.stringify({ ref: 'refs/heads/main', id: providerEventId });
    const cloudEvent = {
      specversion: '1.0',
      id: providerEventId,
      source: 'github:github-main',
      type: 'push',
      data: JSON.parse(body)
    };

    const event = await insertEvent({
      sourceId: 'github-main',
      provider: 'github',
      providerEventId,
      eventType: 'push',
      bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
      bodyText: null,
      parsedJson: JSON.parse(body),
      normalizedPayload: JSON.parse(body),
      cloudEvent,
      receivedIp: '203.0.113.20'
    });
    expect(event.duplicate).toBe(false);

    const before = await pool.query('SELECT count(*)::int AS count FROM deliveries WHERE event_id=$1', [event.id]);
    expect(before.rows[0].count).toBe(0);

    const spoolFile = await writeSpoolFile({
      receivedAt: new Date().toISOString(),
      source: { id: 'github-main' },
      headers: { authorization: 'must-be-redacted' },
      body,
      verified: {
        ok: true,
        providerEventId,
        eventType: 'push',
        parsedJson: JSON.parse(body)
      },
      cloudEvent
    });

    await expect(importSpoolFile(spoolFile)).resolves.toBe('duplicate');

    const rows = await pool.query(
      `SELECT d.id AS delivery_id, o.id AS outbox_id, o.status AS outbox_status
       FROM deliveries d
       JOIN delivery_outbox o ON o.delivery_id=d.id
       WHERE d.event_id=$1`,
      [event.id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].delivery_id).toBeTruthy();
    expect(rows.rows[0].outbox_id).toBeTruthy();
    expect(['pending', 'published']).toContain(rows.rows[0].outbox_status);
    await expect(fs.stat(spoolFile)).rejects.toThrow();
  });
});
