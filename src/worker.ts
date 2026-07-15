import crypto from 'node:crypto';
import { Worker } from 'bullmq';
import { env, requireEnv } from './env.js';
import { loadGatewayConfig, validateGatewayConfig } from './config.js';
import { decodeSecret, hmacSha256 } from './crypto.js';
import { pool, migrate, insertEvent, createDeliveries, closeDb, updateDeliveryFailure, audit } from './db.js';
import { redisConnection, enqueueDeliveryBestEffort, closeQueue } from './queue.js';
import { countSpoolFiles, listSpoolFiles, lockSpoolFile, moveSpoolFileToFailed, purgeFailedSpoolFiles, readSpoolFile, removeSpoolFile, unlockSpoolFile } from './spool.js';
import { deliveryCounter, spoolCorruptedCounter, spoolFailedFileGauge, spoolFileGauge, spoolPurgedCounter } from './metrics.js';
import { sanitizeObject, sanitizeText, safeMetricLabel } from './sanitize.js';
import type { DeliveryStatus, DestinationConfig, RouteConfig, SourceConfig } from './types.js';

const config = loadGatewayConfig();
validateGatewayConfig(config);

function signBody(body: string, secretValue: string): { id: string; timestamp: string; signature: string } {
  const id = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = hmacSha256(decodeSecret(secretValue), `${id}.${timestamp}.${body}`).toString('base64');
  return { id, timestamp, signature: `v1,${sig}` };
}

async function processDelivery(deliveryId: string): Promise<void> {
  const result = await pool.query(
    `SELECT d.*, e.cloud_event, e.normalized_payload, e.body_text, e.provider, e.source_id
     FROM deliveries d JOIN events e ON e.id=d.event_id
     WHERE d.id=$1`,
    [deliveryId]
  );
  const row = result.rows[0];
  if (!row || row.status === 'delivered') return;
  const destination = config.destinations.find((item) => item.id === row.destination_id && item.enabled);
  if (!destination) throw new Error(`Destination not found: ${row.destination_id}`);

  await pool.query(`UPDATE deliveries SET status='delivering', attempt_count=attempt_count+1, updated_at=now() WHERE id=$1`, [deliveryId]);
  const currentAttempt = Number(row.attempt_count ?? 0) + 1;
  const body = buildPayload(destination, row.body_text, row.normalized_payload, row.cloud_event);
  const headers: Record<string, string> = {
    'content-type': destination.payloadMode === 'raw' ? 'application/octet-stream' : 'application/json',
    'x-gace-event-id': row.event_id,
    'x-gace-delivery-id': row.id,
    'x-gace-provider': row.provider,
    ...(destination.headers ?? {})
  };
  if (destination.signingSecretEnv) {
    const signed = signBody(body, requireEnv(destination.signingSecretEnv));
    headers['webhook-id'] = signed.id;
    headers['webhook-timestamp'] = signed.timestamp;
    headers['webhook-signature'] = signed.signature;
  }

  try {
    const url = requireEnv(destination.urlEnv);
    const response = await fetch(url, { method: destination.method, headers, body, signal: AbortSignal.timeout(destination.timeoutMs ?? env.DELIVERY_TIMEOUT_MS) });
    const responseBody = await response.text();
    const accepted = evaluateSuccess(destination, response);
    if (accepted === 'delivered') {
      await pool.query(
        `UPDATE deliveries SET status='delivered', last_status_code=$2, response_body=$3, delivered_at=now(), updated_at=now() WHERE id=$1`,
        [deliveryId, response.status, sanitizeText(responseBody, 4000)]
      );
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'delivered' });
      await updateEventAggregateStatus(row.event_id);
      return;
    }
    if (accepted === 'unknown') {
      await markUnknownOrDead(deliveryId, destination, currentAttempt, response.status, responseBody, '2xx without required accepted header');
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'unknown' });
      await updateEventAggregateStatus(row.event_id);
      return;
    }
    throw new Error(`Downstream returned ${response.status}: ${sanitizeText(responseBody, 1000)}`);
  } catch (err: any) {
    const isTimeout = isAbortError(err);
    if (isTimeout) {
      await markUnknownOrDead(deliveryId, destination, currentAttempt, null, null, 'delivery timeout result unknown');
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'unknown' });
    } else {
      await markRetryOrDead(deliveryId, destination, currentAttempt, err, null, null);
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'failed' });
    }
    await updateEventAggregateStatus(row.event_id);
    if (!isFinalAttempt(currentAttempt, destination.maxAttempts)) throw err;
  }
}

function evaluateSuccess(destination: DestinationConfig, response: Response): 'delivered' | 'unknown' | 'failed' {
  if (response.status < 200 || response.status >= 300) return 'failed';
  if ((destination.successMode ?? 'status_only') === 'status_only') return 'delivered';
  const header = destination.acceptedHeader ?? 'x-gace-accepted';
  const expected = destination.acceptedHeaderValue ?? 'true';
  return response.headers.get(header)?.toLowerCase() === expected.toLowerCase() ? 'delivered' : 'unknown';
}

async function markUnknownOrDead(deliveryId: string, destination: DestinationConfig, attempt: number, statusCode: number | null, responseBody: string | null, reason: string): Promise<void> {
  const policy = destination.unknownPolicy ?? 'retry_then_dead';
  if (policy === 'treat_2xx_as_delivered' && statusCode && statusCode >= 200 && statusCode < 300) {
    await pool.query(`UPDATE deliveries SET status='delivered', last_status_code=$2, response_body=$3, delivered_at=now(), updated_at=now() WHERE id=$1`, [deliveryId, statusCode, sanitizeText(responseBody ?? '', 4000)]);
    return;
  }
  const final = policy === 'dead_immediately' || isFinalAttempt(attempt, destination.maxAttempts) || !env.UNKNOWN_RETRY_ENABLED;
  await updateDeliveryFailure({ deliveryId, status: final ? 'dead' : 'unknown', error: reason, nextAttemptAt: final ? null : nextBackoff(attempt), lastStatusCode: statusCode, responseBody });
}

async function markRetryOrDead(deliveryId: string, destination: DestinationConfig, attempt: number, error: unknown, statusCode: number | null, responseBody: string | null): Promise<void> {
  const final = isFinalAttempt(attempt, destination.maxAttempts);
  await updateDeliveryFailure({ deliveryId, status: final ? 'dead' : 'retrying', error, nextAttemptAt: final ? null : nextBackoff(attempt), lastStatusCode: statusCode, responseBody });
}

function buildPayload(destination: DestinationConfig, bodyText: string | null, normalizedPayload: unknown, cloudEvent: unknown): string {
  if (destination.payloadMode === 'raw') return String(bodyText ?? JSON.stringify(normalizedPayload ?? {}));
  if (destination.payloadMode === 'json') return JSON.stringify(normalizedPayload ?? {});
  return JSON.stringify(cloudEvent ?? {});
}

function nextBackoff(attempts: number): Date {
  const delayMs = Math.min(21_600_000, env.UNKNOWN_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMs);
}

function isFinalAttempt(attempt: number, maxAttempts: number): boolean {
  return attempt >= maxAttempts;
}

function isAbortError(err: any): boolean {
  return err?.name === 'AbortError' || /timeout|aborted/i.test(String(err?.message ?? err));
}

async function updateEventAggregateStatus(eventId: string): Promise<void> {
  const rows = await pool.query(`SELECT status, count(*)::int AS count FROM deliveries WHERE event_id=$1 GROUP BY status`, [eventId]);
  const counts = new Map<string, number>();
  for (const row of rows.rows) counts.set(row.status, Number(row.count));
  let status = 'queued';
  if ((counts.get('dead') ?? 0) > 0) status = 'dead';
  else if ((counts.get('unknown') ?? 0) > 0 || (counts.get('retrying') ?? 0) > 0 || (counts.get('delivering') ?? 0) > 0) status = 'partial';
  else if ((counts.get('queued') ?? 0) > 0) status = 'queued';
  else if ((counts.get('delivered') ?? 0) > 0) status = 'delivered';
  await pool.query(`UPDATE events SET status=$2, updated_at=now() WHERE id=$1`, [eventId, status]);
}

async function recoverDueDeliveries(): Promise<void> {
  const due = await pool.query(
    `SELECT id FROM deliveries
     WHERE status IN ('queued','retrying','unknown')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     LIMIT $1`,
    [env.RECOVERY_DELIVERY_BATCH_SIZE]
  );
  await Promise.allSettled(due.rows.map((row) => enqueueDeliveryBestEffort(row.id)));
  await pool.query(
    `UPDATE deliveries SET status='retrying', updated_at=now()
     WHERE status='delivering'
       AND updated_at < now() - ($1 || ' seconds')::interval`,
    [String(env.STALE_DELIVERING_SECONDS)]
  );
}

async function importSpoolFiles(): Promise<void> {
  const files = (await listSpoolFiles()).slice(0, env.SPOOL_IMPORT_BATCH_SIZE);
  for (const file of files) {
    const locked = await lockSpoolFile(file);
    if (!locked) continue;
    try {
      const payload = await readSpoolFile(locked);
      const source = payload.source as SourceConfig;
      const verified = payload.verified as any;
      if (!source?.id || !source?.provider || !verified?.providerEventId || !verified?.eventType || !payload.cloudEvent) {
        await moveCorrupted(locked, 'missing required spool fields');
        continue;
      }
      try {
        const event = await insertEvent({
          sourceId: source.id,
          provider: source.provider,
          providerEventId: verified.providerEventId,
          eventType: verified.eventType,
          bodySha256: (payload.cloudEvent as any)?.extensions?.bodySha256 ?? '',
          bodyText: env.STORE_RAW_BODY ? payload.body : null,
          parsedJson: verified.parsedJson,
          normalizedPayload: verified.parsedJson ?? { base64: Buffer.from(payload.body).toString('base64') },
          cloudEvent: payload.cloudEvent
        });
        if (!event.duplicate) {
          const routes = getMatchingRoutes(source.id, verified.eventType);
          const deliveries = await createDeliveries(event.id, routes, config.destinations);
          await Promise.allSettled(deliveries.map((id) => enqueueDeliveryBestEffort(id)));
          await audit({ actor: 'worker', action: 'spool.import', resourceType: 'spool', resourceId: locked, result: 'success', details: { eventId: event.id, deliveries: deliveries.length } });
        } else {
          await audit({ actor: 'worker', action: 'spool.import', resourceType: 'spool', resourceId: locked, result: 'duplicate', details: { sourceId: source.id } });
        }
        await removeSpoolFile(locked);
      } catch (err) {
        await audit({ actor: 'worker', action: 'spool.import', resourceType: 'spool', resourceId: locked, result: 'db_error', details: { error: sanitizeText(err) } });
        await unlockSpoolFile(locked);
      }
    } catch (err) {
      await moveCorrupted(locked, err);
    }
  }
}

async function moveCorrupted(lockedPath: string, reason: unknown): Promise<void> {
  const failed = await moveSpoolFileToFailed(lockedPath);
  spoolCorruptedCounter.inc();
  await audit({ actor: 'worker', action: 'spool.import', resourceType: 'spool', resourceId: failed, result: 'corrupted', details: { reason: sanitizeText(reason) } });
}

async function cleanupRawBodies(): Promise<void> {
  await pool.query(
    `UPDATE events SET body_text=NULL, updated_at=now()
     WHERE body_text IS NOT NULL
       AND received_at < now() - ($1 || ' days')::interval`,
    [String(env.BODY_RETENTION_DAYS)]
  );
}

async function updateSpoolMetricsAndPurge(): Promise<void> {
  const before = await countSpoolFiles();
  spoolFileGauge.set(before.pending);
  spoolFailedFileGauge.set(before.failed);
  const purged = await purgeFailedSpoolFiles();
  if (purged > 0) spoolPurgedCounter.inc(purged);
  const after = await countSpoolFiles();
  spoolFileGauge.set(after.pending);
  spoolFailedFileGauge.set(after.failed);
}

function getMatchingRoutes(sourceId: string, eventType: string): RouteConfig[] {
  return config.routes.filter((route) => route.enabled && route.sourceId === sourceId && (route.eventTypePattern === '*' || route.eventTypePattern === eventType));
}

async function recoverySweep(): Promise<void> {
  await importSpoolFiles();
  await recoverDueDeliveries();
  await cleanupRawBodies();
  await updateSpoolMetricsAndPurge();
}

async function main(): Promise<void> {
  await migrate();
  const worker = new Worker(env.QUEUE_NAME, async (job) => processDelivery(job.data.deliveryId), {
    connection: redisConnection as any,
    concurrency: env.WORKER_CONCURRENCY
  });
  const timer = setInterval(() => void recoverySweep().catch((err) => console.error('recovery sweep failed', sanitizeText(err))), env.RECOVERY_INTERVAL_MS);
  console.log('webhook gateway worker started');
  const shutdown = async () => {
    clearInterval(timer);
    await worker.close();
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(sanitizeText(err));
  process.exit(1);
});
