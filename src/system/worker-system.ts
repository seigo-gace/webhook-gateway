import crypto from 'node:crypto';
import { Worker } from 'bullmq';
import { env, requireEnv } from '../part/env.js';
import { loadGatewayConfig, validateGatewayConfig } from '../feature/config.js';
import { decodeSecret, hmacSha256, sha256Hex } from '../part/crypto.js';
import { migrate, closeDb, pool, updateDeliveryFailure, insertEvent, createDeliveries } from '../feature/db.js';
import { closeQueue, enqueueDeliveryBestEffort, redisConnection } from '../feature/queue.js';
import { countSpoolFiles, listSpoolFiles, lockSpoolFile, readSpoolFile, removeSpoolFile, moveSpoolFileToFailed, unlockSpoolFile, purgeFailedSpoolFiles } from '../feature/spool.js';
import { getMatchingRoutes } from '../component/routing.js';
import { buildDeliveryPayload, evaluateDeliverySuccess, isDeliveryTimeoutError, isFinalDeliveryAttempt, nextDeliveryBackoff } from '../component/delivery.js';
import { deliveryCounter, spoolCorruptedCounter, spoolFailedFileGauge, spoolFileGauge, spoolPurgedCounter } from '../part/metrics.js';
import { safeMetricLabel, sanitizeText } from '../part/sanitize.js';
import { logGatewayEvent, tgServerLogSink } from '../feature/tgserver-log.js';
import type { DestinationConfig, SourceConfig, VerificationResult } from '../part/types.js';
import type { SpoolImportResult, SpoolPayload } from '../feature/spool.js';

const config = loadGatewayConfig();
validateGatewayConfig(config);

type SpoolSweepResult = SpoolImportResult | 'skipped';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVerifiedOk(value: unknown): value is Extract<VerificationResult, { ok: true }> {
  return isRecord(value) && value.ok === true && typeof value.providerEventId === 'string' && typeof value.eventType === 'string';
}

function findSpoolSource(payload: SpoolPayload): SourceConfig | null {
  if (!isRecord(payload.source) || typeof payload.source.id !== 'string') return null;
  return config.sources.find((item) => item.id === payload.source.id && item.enabled) ?? null;
}

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
  const attempt = Number(row.attempt_count ?? 0) + 1;
  const body = buildDeliveryPayload(destination, row.body_text, row.normalized_payload, row.cloud_event);
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
    const response = await fetch(requireEnv(destination.urlEnv), {
      method: destination.method,
      headers,
      body,
      signal: AbortSignal.timeout(destination.timeoutMs ?? env.DELIVERY_TIMEOUT_MS)
    });
    const responseBody = await response.text();
    const outcome = evaluateDeliverySuccess(destination, response);
    if (outcome === 'delivered') {
      await pool.query(`UPDATE deliveries SET status='delivered', last_status_code=$2, response_body=$3, delivered_at=now(), updated_at=now() WHERE id=$1`, [deliveryId, response.status, sanitizeText(responseBody, 4000)]);
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'delivered' });
      logGatewayEvent({ level: 'info', event: 'delivery_delivered', component: 'worker-system', message: 'Delivery succeeded', eventId: row.event_id, deliveryId, destinationId: destination.id });
      return;
    }
    if (outcome === 'unknown') {
      await markUnknownOrDead(deliveryId, destination, attempt, response.status, responseBody, '2xx without accepted header');
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'unknown' });
      logGatewayEvent({ level: 'warn', event: 'delivery_unknown', component: 'worker-system', message: 'Delivery result is unknown', eventId: row.event_id, deliveryId, destinationId: destination.id });
      return;
    }
    throw new Error(`Downstream returned ${response.status}: ${sanitizeText(responseBody, 1000)}`);
  } catch (err) {
    if (isDeliveryTimeoutError(err)) {
      await markUnknownOrDead(deliveryId, destination, attempt, null, null, 'delivery timeout result unknown');
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'unknown' });
      logGatewayEvent({ level: 'warn', event: 'delivery_timeout_unknown', component: 'worker-system', message: 'Delivery timed out and was marked unknown', eventId: row.event_id, deliveryId, destinationId: destination.id });
    } else {
      const final = isFinalDeliveryAttempt(attempt, destination.maxAttempts);
      await updateDeliveryFailure({ deliveryId, status: final ? 'dead' : 'retrying', error: err, nextAttemptAt: final ? null : nextDeliveryBackoff(attempt) });
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'failed' });
      logGatewayEvent({ level: 'warn', event: 'delivery_failed', component: 'worker-system', message: 'Delivery failed', eventId: row.event_id, deliveryId, destinationId: destination.id, details: { final, error: sanitizeText(err, 300) } });
    }
  }
}

async function markUnknownOrDead(deliveryId: string, destination: DestinationConfig, attempt: number, statusCode: number | null, responseBody: string | null, reason: string): Promise<void> {
  const policy = destination.unknownPolicy ?? 'retry_then_dead';
  const final = policy === 'dead_immediately' || isFinalDeliveryAttempt(attempt, destination.maxAttempts) || !env.UNKNOWN_RETRY_ENABLED;
  await updateDeliveryFailure({ deliveryId, status: final ? 'dead' : 'unknown', error: reason, nextAttemptAt: final ? null : nextDeliveryBackoff(attempt), lastStatusCode: statusCode, responseBody });
}

async function createAndEnqueueDeliveriesForImportedEvent(eventId: string, source: SourceConfig, eventType: string): Promise<{ deliveries: number; enqueued: number }> {
  const routes = getMatchingRoutes(config.routes, source.id, eventType);
  const deliveryIds = await createDeliveries(eventId, routes, config.destinations);
  const enqueueResults = await Promise.allSettled(deliveryIds.map((id) => enqueueDeliveryBestEffort(id)));
  const enqueued = enqueueResults.filter((result) => result.status === 'fulfilled' && result.value === true).length;
  return { deliveries: deliveryIds.length, enqueued };
}

async function moveCorruptedSpoolFile(filePath: string, reason: string, err?: unknown): Promise<void> {
  try {
    const failed = await moveSpoolFileToFailed(filePath);
    spoolCorruptedCounter.inc();
    logGatewayEvent({ level: 'error', event: 'spool_import_corrupted', component: 'worker-system', message: 'Corrupted emergency spool file moved to failed', details: { spoolFile: failed, reason, error: sanitizeText(err ?? '', 300) } });
  } catch (moveError) {
    logGatewayEvent({ level: 'error', event: 'spool_import_corrupted_move_failed', component: 'worker-system', message: 'Corrupted emergency spool file could not be moved to failed', details: { spoolFile: filePath, reason, error: sanitizeText(moveError, 300) } });
  }
}

async function importSpoolFile(filePath: string): Promise<SpoolSweepResult> {
  const lockedPath = await lockSpoolFile(filePath);
  if (!lockedPath) return 'skipped';

  let payload: SpoolPayload;
  try {
    payload = await readSpoolFile(lockedPath);
  } catch (err) {
    await moveCorruptedSpoolFile(lockedPath, 'read_failed', err);
    return 'corrupted';
  }

  const source = findSpoolSource(payload);
  const verified = payload.verified;
  if (!source || !isVerifiedOk(verified) || typeof payload.body !== 'string' || !isRecord(payload.cloudEvent)) {
    await moveCorruptedSpoolFile(lockedPath, 'invalid_payload');
    return 'corrupted';
  }

  try {
    const raw = Buffer.from(payload.body, 'utf8');
    const normalizedPayload = verified.parsedJson ?? { base64: raw.toString('base64') };
    const event = await insertEvent({
      sourceId: source.id,
      provider: source.provider,
      providerEventId: verified.providerEventId,
      eventType: verified.eventType,
      bodySha256: sha256Hex(raw),
      bodyText: env.STORE_RAW_BODY ? payload.body : null,
      parsedJson: verified.parsedJson,
      normalizedPayload,
      cloudEvent: payload.cloudEvent,
      receivedIp: undefined
    });
    const deliverySummary = await createAndEnqueueDeliveriesForImportedEvent(event.id, source, verified.eventType);
    await removeSpoolFile(lockedPath);
    logGatewayEvent({
      level: event.duplicate ? 'info' : 'warn',
      event: event.duplicate ? 'spool_import_duplicate' : 'spool_import_success',
      component: 'worker-system',
      message: event.duplicate ? 'Emergency spool file matched an existing event and was reconciled' : 'Emergency spool file imported into durable ledger',
      eventId: event.id,
      sourceId: source.id,
      details: { provider: source.provider, eventType: verified.eventType, deliveries: deliverySummary.deliveries, enqueued: deliverySummary.enqueued }
    });
    return event.duplicate ? 'duplicate' : 'success';
  } catch (err) {
    await unlockSpoolFile(lockedPath);
    logGatewayEvent({ level: 'error', event: 'spool_import_db_error', component: 'worker-system', message: 'Emergency spool import failed on durable DB path and will be retried', sourceId: source.id, details: { error: sanitizeText(err, 300) } });
    return 'db_error';
  }
}

async function importSpoolBatch(): Promise<Record<SpoolSweepResult, number>> {
  const summary: Record<SpoolSweepResult, number> = { success: 0, duplicate: 0, corrupted: 0, db_error: 0, skipped: 0 };
  const files = (await listSpoolFiles()).slice(0, env.SPOOL_IMPORT_BATCH_SIZE);
  for (const file of files) {
    const result = await importSpoolFile(file);
    summary[result] += 1;
  }
  if (files.length > 0) {
    logGatewayEvent({ level: 'info', event: 'spool_import_sweep', component: 'worker-system', message: 'Emergency spool import sweep completed', details: summary });
  }
  return summary;
}

async function recoverySweep(): Promise<void> {
  await pool.query(`UPDATE deliveries SET status='retrying', updated_at=now() WHERE status='delivering' AND updated_at < now() - ($1 || ' seconds')::interval`, [String(env.STALE_DELIVERING_SECONDS)]);
  await importSpoolBatch();
  const due = await pool.query(`SELECT id FROM deliveries WHERE status IN ('queued','retrying','unknown') AND (next_attempt_at IS NULL OR next_attempt_at <= now()) LIMIT $1`, [env.RECOVERY_DELIVERY_BATCH_SIZE]);
  await Promise.allSettled(due.rows.map((row) => enqueueDeliveryBestEffort(row.id)));
  const counts = await countSpoolFiles();
  spoolFileGauge.set(counts.pending);
  spoolFailedFileGauge.set(counts.failed);
  const purged = await purgeFailedSpoolFiles();
  if (purged > 0) spoolPurgedCounter.inc(purged);
}

export async function startWorkerSystem(): Promise<void> {
  await migrate();
  tgServerLogSink.start();
  const worker = new Worker(env.QUEUE_NAME, async (job) => processDelivery(job.data.deliveryId), { connection: redisConnection as any, concurrency: env.WORKER_CONCURRENCY });
  const timer = setInterval(() => void recoverySweep().catch((err) => console.error('recovery sweep failed', sanitizeText(err))), env.RECOVERY_INTERVAL_MS);
  await recoverySweep();
  logGatewayEvent({ level: 'info', event: 'worker_started', component: 'worker-system', message: 'webhook gateway worker started', details: { concurrency: env.WORKER_CONCURRENCY } });
  const shutdown = async () => {
    clearInterval(timer);
    await tgServerLogSink.flush();
    tgServerLogSink.stop();
    await worker.close();
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
