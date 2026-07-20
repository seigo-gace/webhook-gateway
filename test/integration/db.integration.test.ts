import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginDeliveryAttempt,
  checkReplayCooldown,
  claimDelivery,
  claimOutboxBatch,
  closeDb,
  markOutboxPublished,
  migrate,
  persistIngressWithDeliveries,
  pool,
  releaseDeliveryClaim
} from '../../src/feature/db.js';
import type { DestinationConfig, RouteConfig } from '../../src/part/types.js';

const destination: DestinationConfig = {
  id: 'integration-destination',
  appId: 'integration',
  name: 'Integration destination',
  urlEnv: 'DEST_APP_URL',
  method: 'POST',
  payloadMode: 'json',
  maxAttempts: 5,
  enabled: true,
  allowPrivateNetwork: true
};

const route: RouteConfig = {
  id: 'integration-route',
  sourceId: 'integration-source',
  destinationId: destination.id,
  eventTypePattern: '*',
  enabled: true
};

function eventInput(providerEventId: string) {
  return {
    sourceId: route.sourceId,
    provider: 'github',
    providerEventId,
    eventType: 'push',
    bodySha256: crypto.createHash('sha256').update(providerEventId).digest('hex'),
    bodyText: null,
    parsedJson: { providerEventId },
    normalizedPayload: { providerEventId },
    cloudEvent: { specversion: '1.0', id: providerEventId, type: 'push', data: { providerEventId } },
    receivedIp: '203.0.113.10'
  };
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await closeDb();
});

describe('PostgreSQL durable ledger and concurrency controls', () => {
  it('commits event, delivery, and outbox atomically', async () => {
    const providerEventId = `atomic-${crypto.randomUUID()}`;
    const persisted = await persistIngressWithDeliveries(eventInput(providerEventId), [route], [destination]);

    expect(persisted.duplicate).toBe(false);
    expect(persisted.deliveryIds).toHaveLength(1);

    const rows = await pool.query(
      `SELECT e.id AS event_id, d.id AS delivery_id, o.id AS outbox_id, o.status AS outbox_status
       FROM events e
       JOIN deliveries d ON d.event_id=e.id
       JOIN delivery_outbox o ON o.delivery_id=d.id
       WHERE e.source_id=$1 AND e.provider_event_id=$2`,
      [route.sourceId, providerEventId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].event_id).toBe(persisted.id);
    expect(rows.rows[0].delivery_id).toBe(persisted.deliveryIds[0]);
    expect(rows.rows[0].outbox_status).toBe('pending');
  });

  it('rolls back the event when delivery creation fails', async () => {
    const providerEventId = `rollback-${crypto.randomUUID()}`;
    const invalidDestination = { ...destination, maxAttempts: 3_000_000_000 };

    await expect(
      persistIngressWithDeliveries(eventInput(providerEventId), [route], [invalidDestination])
    ).rejects.toThrow();

    const rows = await pool.query(
      'SELECT id FROM events WHERE source_id=$1 AND provider_event_id=$2',
      [route.sourceId, providerEventId]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('deduplicates repeated provider events without creating more deliveries', async () => {
    const providerEventId = `duplicate-${crypto.randomUUID()}`;
    const first = await persistIngressWithDeliveries(eventInput(providerEventId), [route], [destination]);
    const second = await persistIngressWithDeliveries(eventInput(providerEventId), [route], [destination]);

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ id: first.id, duplicate: true, deliveryIds: [] });

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM events WHERE source_id=$1 AND provider_event_id=$2) AS events,
         (SELECT count(*)::int FROM deliveries WHERE event_id=$3) AS deliveries,
         (SELECT count(*)::int FROM delivery_outbox o JOIN deliveries d ON d.id=o.delivery_id WHERE d.event_id=$3) AS outbox`,
      [route.sourceId, providerEventId, first.id]
    );
    expect(counts.rows[0]).toEqual({ events: 1, deliveries: 1, outbox: 1 });
  });

  it('allows only one concurrent delivery lease owner', async () => {
    const persisted = await persistIngressWithDeliveries(
      eventInput(`claim-${crypto.randomUUID()}`),
      [route],
      [destination]
    );
    const deliveryId = persisted.deliveryIds[0];
    const claims = await Promise.all([
      claimDelivery(deliveryId, 60),
      claimDelivery(deliveryId, 60),
      claimDelivery(deliveryId, 60)
    ]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);

    const attempt = await beginDeliveryAttempt(deliveryId, winners[0]!.lockToken);
    expect(attempt).toBe(1);
    await releaseDeliveryClaim({
      deliveryId,
      lockToken: winners[0]!.lockToken,
      status: 'retrying',
      nextAttemptAt: new Date(Date.now() + 1000),
      error: 'integration cleanup'
    });
  });

  it('uses SKIP LOCKED so concurrent outbox publishers never claim the same row', async () => {
    const first = await persistIngressWithDeliveries(
      eventInput(`outbox-a-${crypto.randomUUID()}`),
      [route],
      [destination]
    );
    const second = await persistIngressWithDeliveries(
      eventInput(`outbox-b-${crypto.randomUUID()}`),
      [route],
      [destination]
    );

    const [batchA, batchB] = await Promise.all([
      claimOutboxBatch(100, 60),
      claimOutboxBatch(100, 60)
    ]);
    const all = [...batchA, ...batchB];
    const ids = all.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.map((item) => item.deliveryId)).toEqual(expect.arrayContaining([
      first.deliveryIds[0],
      second.deliveryIds[0]
    ]));

    await Promise.all(all.map((item) => markOutboxPublished(item.id, item.lockToken)));
  });

  it('makes replay cooldown acquisition atomic under concurrency', async () => {
    const resourceKey = `delivery:${crypto.randomUUID()}`;
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => checkReplayCooldown(resourceKey, 60))
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(11);
    expect(decisions.filter((decision) => !decision.allowed).every(
      (decision) => (decision.retryAfterSeconds ?? 0) > 0
    )).toBe(true);
  });
});
