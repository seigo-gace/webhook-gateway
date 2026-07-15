import { Pool } from 'pg';
import { env } from './env.js';
import type { DestinationConfig, RouteConfig } from './types.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id text NOT NULL,
      provider text NOT NULL,
      provider_event_id text NOT NULL,
      event_type text NOT NULL,
      body_sha256 text NOT NULL,
      body_text text,
      parsed_json jsonb,
      cloud_event jsonb,
      status text NOT NULL DEFAULT 'received',
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
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function insertEvent(input: {
  sourceId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  bodySha256: string;
  bodyText: string;
  parsedJson: unknown;
  cloudEvent: unknown;
}): Promise<{ id: string; duplicate: boolean }> {
  const res = await pool.query(
    `INSERT INTO events (source_id, provider, provider_event_id, event_type, body_sha256, body_text, parsed_json, cloud_event)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source_id, provider_event_id)
     DO UPDATE SET updated_at=events.updated_at
     RETURNING id, xmax = 0 AS inserted`,
    [input.sourceId, input.provider, input.providerEventId, input.eventType, input.bodySha256, input.bodyText, JSON.stringify(input.parsedJson ?? null), JSON.stringify(input.cloudEvent)]
  );
  return { id: res.rows[0].id, duplicate: !res.rows[0].inserted };
}

export async function createDeliveries(eventId: string, routes: RouteConfig[], destinations: DestinationConfig[]): Promise<string[]> {
  const ids: string[] = [];
  for (const route of routes.filter((r) => r.enabled)) {
    const dest = destinations.find((d) => d.id === route.destinationId && d.enabled);
    if (!dest) continue;
    const res = await pool.query(
      `INSERT INTO deliveries (event_id, destination_id, route_id, max_attempts)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id, destination_id, route_id) DO NOTHING
       RETURNING id`,
      [eventId, dest.id, route.id, dest.maxAttempts]
    );
    if (res.rows[0]?.id) ids.push(res.rows[0].id);
  }
  return ids;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
