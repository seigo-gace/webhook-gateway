import { Pool, type PoolClient } from 'pg';
import { env } from '../part/env.js';
import { sanitizeObject, sanitizeText } from '../part/sanitize.js';
import type { DeliveryStatus, DestinationConfig, RouteConfig } from '../part/types.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export interface IngressPersistenceInput {
  sourceId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  bodySha256: string;
  bodyText: string | null;
  parsedJson: unknown;
  normalizedPayload: unknown;
  cloudEvent: unknown;
  receivedIp?: string;
}

export interface ClaimedDelivery {
  lockToken: string;
  attemptCount: number;
}

export interface ClaimedOutbox {
  id: string;
  deliveryId: string;
  lockToken: string;
}

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id text NOT NULL,
      provider text NOT NULL,
      provider_event_id text NOT NULL,
      event_type text NOT NULL,
      body_sha256 text NOT NULL,
      body_text text,
      parsed_json jsonb,
      normalized_payload jsonb,
      cloud_event jsonb NOT NULL,
      status text NOT NULL DEFAULT 'received',
      duplicate_of uuid,
      received_ip text,
      received_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(source_id, provider_event_id)
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      destination_id text NOT NULL,
      route_id text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      attempt_count int NOT NULL DEFAULT 0,
      max_attempts int NOT NULL DEFAULT 8,
      lock_token uuid,
      lock_expires_at timestamptz,
      last_status_code int,
      last_error text,
      response_body text,
      next_attempt_at timestamptz,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(event_id, destination_id, route_id)
    );

    ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS lock_token uuid;
    ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS lock_expires_at timestamptz;

    CREATE TABLE IF NOT EXISTS delivery_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_id uuid NOT NULL UNIQUE REFERENCES deliveries(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending',
      attempt_count int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      lock_token uuid,
      lock_expires_at timestamptz,
      last_error text,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id bigserial PRIMARY KEY,
      actor text NOT NULL,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text NOT NULL,
      result text NOT NULL DEFAULT 'ok',
      details jsonb,
      ip text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS replay_locks (
      resource_key text PRIMARY KEY,
      last_replayed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status_due ON deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_lock_expiry ON deliveries(status, lock_expires_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_event_id ON deliveries(event_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_outbox_due ON delivery_outbox(status, next_attempt_at, lock_expires_at);
  `);
}

export async function persistIngressWithDeliveries(
  input: IngressPersistenceInput,
  routes: RouteConfig[],
  destinations: DestinationConfig[]
): Promise<{ id: string; duplicate: boolean; deliveryIds: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await insertEventWithClient(client, input);
    if (event.duplicate) {
      await client.query('COMMIT');
      return { ...event, deliveryIds: [] };
    }
    const deliveryIds = await createDeliveriesWithClient(client, event.id, routes, destinations);
    await client.query('COMMIT');
    return { ...event, deliveryIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function insertEvent(input: IngressPersistenceInput): Promise<{ id: string; duplicate: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await insertEventWithClient(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertEventWithClient(
  client: PoolClient,
  input: IngressPersistenceInput
): Promise<{ id: string; duplicate: boolean }> {
  const insert = await client.query(
    `INSERT INTO events (source_id, provider, provider_event_id, event_type, body_sha256, body_text, parsed_json, normalized_payload, cloud_event, received_ip, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received')
     ON CONFLICT (source_id, provider_event_id) DO NOTHING
     RETURNING id`,
    [
      input.sourceId,
      input.provider,
      input.providerEventId,
      input.eventType,
      input.bodySha256,
      input.bodyText,
      JSON.stringify(input.parsedJson ?? null),
      JSON.stringify(input.normalizedPayload ?? null),
      JSON.stringify(input.cloudEvent ?? null),
      input.receivedIp ?? null
    ]
  );
  if (insert.rows[0]?.id) return { id: String(insert.rows[0].id), duplicate: false };
  const existing = await client.query(
    'SELECT id FROM events WHERE source_id=$1 AND provider_event_id=$2 LIMIT 1',
    [input.sourceId, input.providerEventId]
  );
  if (!existing.rows[0]?.id) throw new Error('EVENT_DEDUPLICATION_LOOKUP_FAILED');
  return { id: String(existing.rows[0].id), duplicate: true };
}

export async function createDeliveries(
  eventId: string,
  routes: RouteConfig[],
  destinations: DestinationConfig[]
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = await createDeliveriesWithClient(client, eventId, routes, destinations);
    await client.query('COMMIT');
    return ids;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createDeliveriesWithClient(
  client: PoolClient,
  eventId: string,
  routes: RouteConfig[],
  destinations: DestinationConfig[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const route of routes.filter((candidate) => candidate.enabled)) {
    const destination = destinations.find((candidate) => candidate.id === route.destinationId && candidate.enabled);
    if (!destination) continue;
    const result = await client.query(
      `INSERT INTO deliveries (event_id, destination_id, route_id, max_attempts, status)
       VALUES ($1,$2,$3,$4,'queued')
       ON CONFLICT (event_id, destination_id, route_id) DO NOTHING
       RETURNING id`,
      [eventId, destination.id, route.id, destination.maxAttempts]
    );
    const deliveryId = result.rows[0]?.id ? String(result.rows[0].id) : null;
    if (!deliveryId) continue;
    ids.push(deliveryId);
    await client.query(
      `INSERT INTO delivery_outbox (delivery_id, status)
       VALUES ($1, 'pending')
       ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId]
    );
  }
  return ids;
}

export async function claimDelivery(deliveryId: string, leaseSeconds: number): Promise<ClaimedDelivery | null> {
  const result = await pool.query(
    `UPDATE deliveries
     SET status='delivering',
         lock_token=gen_random_uuid(),
         lock_expires_at=now() + ($2 || ' seconds')::interval,
         updated_at=now()
     WHERE id=$1
       AND (
         status IN ('queued','retrying','unknown')
         OR (status='delivering' AND lock_expires_at < now())
       )
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     RETURNING lock_token, attempt_count`,
    [deliveryId, String(leaseSeconds)]
  );
  if (!result.rows[0]) return null;
  return {
    lockToken: String(result.rows[0].lock_token),
    attemptCount: Number(result.rows[0].attempt_count ?? 0)
  };
}

export async function beginDeliveryAttempt(deliveryId: string, lockToken: string): Promise<number | null> {
  const result = await pool.query(
    `UPDATE deliveries
     SET attempt_count=attempt_count+1, updated_at=now()
     WHERE id=$1 AND status='delivering' AND lock_token=$2 AND lock_expires_at > now()
     RETURNING attempt_count`,
    [deliveryId, lockToken]
  );
  return result.rows[0] ? Number(result.rows[0].attempt_count) : null;
}

export async function releaseDeliveryClaim(input: {
  deliveryId: string;
  lockToken: string;
  status: 'queued' | 'retrying' | 'unknown';
  nextAttemptAt: Date | null;
  error?: unknown;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE deliveries
     SET status=$3,
         next_attempt_at=$4,
         last_error=$5,
         lock_token=NULL,
         lock_expires_at=NULL,
         updated_at=now()
     WHERE id=$1 AND lock_token=$2`,
    [
      input.deliveryId,
      input.lockToken,
      input.status,
      input.nextAttemptAt?.toISOString() ?? null,
      input.error === undefined ? null : sanitizeText(input.error, 2000)
    ]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function markDeliveryDelivered(input: {
  deliveryId: string;
  lockToken: string;
  statusCode: number;
  responseBody: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE deliveries
     SET status='delivered',
         last_status_code=$3,
         response_body=$4,
         last_error=NULL,
         next_attempt_at=NULL,
         delivered_at=now(),
         lock_token=NULL,
         lock_expires_at=NULL,
         updated_at=now()
     WHERE id=$1 AND lock_token=$2`,
    [input.deliveryId, input.lockToken, input.statusCode, sanitizeText(input.responseBody, 4000)]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function updateDeliveryFailure(input: {
  deliveryId: string;
  status: DeliveryStatus;
  error: unknown;
  nextAttemptAt: Date | null;
  lastStatusCode?: number | null;
  responseBody?: string | null;
  lockToken?: string;
}): Promise<boolean> {
  const params = [
    input.deliveryId,
    input.status,
    sanitizeText(input.error, 2000),
    input.nextAttemptAt?.toISOString() ?? null,
    input.lastStatusCode ?? null,
    input.responseBody ? sanitizeText(input.responseBody, 4000) : null,
    input.lockToken ?? null
  ];
  const result = await pool.query(
    `UPDATE deliveries
     SET status=$2,
         last_error=$3,
         next_attempt_at=$4,
         last_status_code=$5,
         response_body=$6,
         lock_token=NULL,
         lock_expires_at=NULL,
         updated_at=now()
     WHERE id=$1 AND ($7::uuid IS NULL OR lock_token=$7::uuid)`,
    params
  );
  return (result.rowCount ?? 0) === 1;
}

export async function claimOutboxBatch(limit: number, leaseSeconds: number): Promise<ClaimedOutbox[]> {
  const result = await pool.query(
    `WITH candidates AS (
       SELECT id
       FROM delivery_outbox
       WHERE (
         (status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
         OR (status='publishing' AND lock_expires_at < now())
       )
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE delivery_outbox o
     SET status='publishing',
         lock_token=gen_random_uuid(),
         lock_expires_at=now() + ($2 || ' seconds')::interval,
         attempt_count=o.attempt_count+1,
         updated_at=now()
     FROM candidates
     WHERE o.id=candidates.id
     RETURNING o.id, o.delivery_id, o.lock_token`,
    [limit, String(leaseSeconds)]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    deliveryId: String(row.delivery_id),
    lockToken: String(row.lock_token)
  }));
}

export async function markOutboxPublished(id: string, lockToken: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE delivery_outbox
     SET status='published',
         published_at=now(),
         last_error=NULL,
         lock_token=NULL,
         lock_expires_at=NULL,
         next_attempt_at=NULL,
         updated_at=now()
     WHERE id=$1 AND lock_token=$2`,
    [id, lockToken]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function markOutboxFailed(
  id: string,
  lockToken: string,
  error: unknown,
  retryAt: Date
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE delivery_outbox
     SET status='failed',
         last_error=$3,
         next_attempt_at=$4,
         lock_token=NULL,
         lock_expires_at=NULL,
         updated_at=now()
     WHERE id=$1 AND lock_token=$2`,
    [id, lockToken, sanitizeText(error, 2000), retryAt.toISOString()]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function audit(input: {
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result?: string;
  details?: unknown;
  ip?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (actor, action, resource_type, resource_id, result, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      sanitizeText(input.actor, 200),
      sanitizeText(input.action, 200),
      sanitizeText(input.resourceType, 200),
      sanitizeText(input.resourceId, 300),
      sanitizeText(input.result ?? 'ok', 100),
      JSON.stringify(sanitizeObject(input.details ?? null)),
      sanitizeText(input.ip ?? '', 100)
    ]
  );
}

export async function purgeExpiredEventBodies(retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('BODY_RETENTION_DAYS must be >= 0');
  }
  const result = await pool.query(
    `UPDATE events
     SET body_text=NULL, updated_at=now()
     WHERE body_text IS NOT NULL
       AND received_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)]
  );
  return result.rowCount ?? 0;
}

export async function checkReplayCooldown(
  resourceKey: string,
  cooldownSeconds: number
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const result = await pool.query(
    `INSERT INTO replay_locks (resource_key, last_replayed_at)
     VALUES ($1, now())
     ON CONFLICT (resource_key) DO UPDATE
       SET last_replayed_at=now()
       WHERE replay_locks.last_replayed_at <= now() - ($2 || ' seconds')::interval
     RETURNING last_replayed_at`,
    [resourceKey, String(cooldownSeconds)]
  );
  if (result.rows[0]) return { allowed: true };

  const existing = await pool.query(
    `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
       last_replayed_at + ($2 || ' seconds')::interval - now()
     ))))::int AS retry_after
     FROM replay_locks WHERE resource_key=$1`,
    [resourceKey, String(cooldownSeconds)]
  );
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Number(existing.rows[0]?.retry_after ?? cooldownSeconds))
  };
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
