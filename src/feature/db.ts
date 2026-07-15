import { Pool } from 'pg';
import { env } from '../part/env.js';
import { sanitizeObject, sanitizeText } from '../part/sanitize.js';
import type { DeliveryStatus, DestinationConfig, RouteConfig } from '../part/types.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

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
      last_status_code int,
      last_error text,
      response_body text,
      next_attempt_at timestamptz,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(event_id, destination_id, route_id)
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
    CREATE INDEX IF NOT EXISTS idx_deliveries_event_id ON deliveries(event_id);
  `);
}

export async function insertEvent(input: {
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
}): Promise<{ id: string; duplicate: boolean }> {
  const insert = await pool.query(
    `INSERT INTO events (source_id, provider, provider_event_id, event_type, body_sha256, body_text, parsed_json, normalized_payload, cloud_event, received_ip, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received')
     ON CONFLICT (source_id, provider_event_id) DO NOTHING
     RETURNING id`,
    [input.sourceId, input.provider, input.providerEventId, input.eventType, input.bodySha256, input.bodyText, JSON.stringify(input.parsedJson ?? null), JSON.stringify(input.normalizedPayload ?? null), JSON.stringify(input.cloudEvent ?? null), input.receivedIp ?? null]
  );
  if (insert.rows[0]?.id) return { id: insert.rows[0].id, duplicate: false };
  const existing = await pool.query('SELECT id FROM events WHERE source_id=$1 AND provider_event_id=$2 LIMIT 1', [input.sourceId, input.providerEventId]);
  return { id: existing.rows[0].id, duplicate: true };
}

export async function createDeliveries(eventId: string, routes: RouteConfig[], destinations: DestinationConfig[]): Promise<string[]> {
  const ids: string[] = [];
  for (const route of routes.filter((r) => r.enabled)) {
    const destination = destinations.find((d) => d.id === route.destinationId && d.enabled);
    if (!destination) continue;
    const result = await pool.query(
      `INSERT INTO deliveries (event_id, destination_id, route_id, max_attempts, status)
       VALUES ($1,$2,$3,$4,'queued')
       ON CONFLICT (event_id, destination_id, route_id) DO NOTHING
       RETURNING id`,
      [eventId, destination.id, route.id, destination.maxAttempts]
    );
    if (result.rows[0]?.id) ids.push(result.rows[0].id);
  }
  return ids;
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
    [sanitizeText(input.actor, 200), sanitizeText(input.action, 200), sanitizeText(input.resourceType, 200), sanitizeText(input.resourceId, 300), sanitizeText(input.result ?? 'ok', 100), JSON.stringify(sanitizeObject(input.details ?? null)), sanitizeText(input.ip ?? '', 100)]
  );
}

export async function updateDeliveryFailure(input: {
  deliveryId: string;
  status: DeliveryStatus;
  error: unknown;
  nextAttemptAt: Date | null;
  lastStatusCode?: number | null;
  responseBody?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status=$2, last_error=$3, next_attempt_at=$4, last_status_code=$5, response_body=$6, updated_at=now()
     WHERE id=$1`,
    [input.deliveryId, input.status, sanitizeText(input.error, 2000), input.nextAttemptAt ? input.nextAttemptAt.toISOString() : null, input.lastStatusCode ?? null, input.responseBody ? sanitizeText(input.responseBody, 4000) : null]
  );
}

export async function checkReplayCooldown(resourceKey: string, cooldownSeconds: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const result = await pool.query('SELECT last_replayed_at FROM replay_locks WHERE resource_key=$1', [resourceKey]);
  const last = result.rows[0]?.last_replayed_at ? new Date(result.rows[0].last_replayed_at).getTime() : 0;
  const waitMs = cooldownSeconds * 1000 - (Date.now() - last);
  if (waitMs > 0) return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  await pool.query(
    `INSERT INTO replay_locks (resource_key, last_replayed_at)
     VALUES ($1, now())
     ON CONFLICT (resource_key) DO UPDATE SET last_replayed_at=now()`,
    [resourceKey]
  );
  return { allowed: true };
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
