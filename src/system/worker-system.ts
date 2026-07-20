import crypto from 'node:crypto';
import { Worker } from 'bullmq';
import { env, requireEnv } from '../part/env.js';
import { loadGatewayConfig, validateGatewayConfig } from '../feature/config.js';
import { decodeSecret, hmacSha256, sha256Hex } from '../part/crypto.js';
import {
  migrate,
  closeDb,
  pool,
  updateDeliveryFailure,
  insertEvent,
  createDeliveries,
  purgeExpiredEventBodies,
  claimDelivery,
  beginDeliveryAttempt,
  releaseDeliveryClaim,
  markDeliveryDelivered,
  claimOutboxBatch,
  markOutboxPublished,
  markOutboxFailed
} from '../feature/db.js';
import { closeQueue, enqueueDeliveryBestEffort, redisConnection } from '../feature/queue.js';
import {
  countSpoolFiles,
  listSpoolFiles,
  lockSpoolFile,
  readSpoolFile,
  removeSpoolFile,
  moveSpoolFileToFailed,
  unlockSpoolFile,
  purgeFailedSpoolFiles
} from '../feature/spool.js';
import { getMatchingRoutes } from '../component/routing.js';
import {
  buildDeliveryPayload,
  deliveryFailurePolicy,
  evaluateDeliverySuccess,
  isDeliveryTimeoutError,
  isFinalDeliveryAttempt,
  nextDeliveryBackoff
} from '../component/delivery.js';
import {
  deliveryCounter,
  spoolCorruptedCounter,
  spoolFailedFileGauge,
  spoolFileGauge,
  spoolPurgedCounter
} from '../part/metrics.js';
import { safeMetricLabel, sanitizeText } from '../part/sanitize.js';
import { logGatewayEvent, tgServerLogSink } from '../feature/tgserver-log.js';
import { RedisCircuitBreaker } from '../feature/circuit-breaker.js';
import { dispatchPinnedWebhook, readResponseBodyLimited } from '../feature/destination-http.js';
import type { DestinationConfig, SourceConfig, VerificationResult } from '../part/types.js';
import type { SpoolImportResult, SpoolPayload } from '../feature/spool.js';

const config = loadGatewayConfig();
validateGatewayConfig(config);
const circuitBreaker = new RedisCircuitBreaker(redisConnection, env.REDIS_OPERATION_TIMEOUT_MS);

type SpoolSweepResult = SpoolImportResult | 'skipped';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVerifiedOk(value: unknown): value is Extract<VerificationResult, { ok: true }> {
  return isRecord(value)
    && value.ok === true
    && typeof value.providerEventId === 'string'
    && typeof value.eventType === 'string';
}

function findSpoolSource(payload: SpoolPayload): SourceConfig | null {
  if (!isRecord(payload.source) || typeof payload.source.id !== 'string') return null;
  return config.sources.find((item) => item.id === payload.source.id && item.enabled) ?? null;
}

function signBody(body: string, secretValue: string): { id: string; timestamp: string; signature: string } {
  const id = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacSha256(decodeSecret(secretValue), `${id}.${timestamp}.${body}`).toString('base64');
  return { id, timestamp, signature: `v1,${signature}` };
}

function circuitConfig(destination: DestinationConfig): { threshold: number; openSeconds: number } {
  return {
    threshold: destination.circuitBreaker?.failureThreshold
      ?? env.DESTINATION_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    openSeconds: destination.circuitBreaker?.openSeconds
      ?? env.DESTINATION_CIRCUIT_BREAKER_OPEN_SECONDS
  };
}

function isSecurityConfigurationError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error);
  return /DESTINATION_DNS_PRIVATE_ADDRESS|DESTINATION_DNS_NO_ALLOWED_ADDRESS|destination URL/i.test(message);
}

export async function processDelivery(deliveryId: string): Promise<void> {
  const result = await pool.query(
    `SELECT d.*, e.cloud_event, e.normalized_payload, e.body_text, e.provider, e.source_id
     FROM deliveries d JOIN events e ON e.id=d.event_id
     WHERE d.id=$1`,
    [deliveryId]
  );
  const row = result.rows[0];
  if (!row) return;

  const claim = await claimDelivery(deliveryId, env.DELIVERY_LEASE_SECONDS);
  if (!claim) {
    logGatewayEvent({
      level: 'info',
      event: 'delivery_claim_skipped',
      component: 'worker-system',
      message: 'Delivery job skipped because another worker owns it or it is not due',
      eventId: row.event_id,
      deliveryId,
      details: { status: row.status }
    });
    return;
  }

  const destination = config.destinations.find((item) => item.id === row.destination_id && item.enabled);
  if (!destination) {
    await updateDeliveryFailure({
      deliveryId,
      lockToken: claim.lockToken,
      status: 'skipped',
      error: `Destination not found or disabled: ${String(row.destination_id)}`,
      nextAttemptAt: null
    });
    logGatewayEvent({
      level: 'warn',
      event: 'delivery_destination_skipped',
      component: 'worker-system',
      message: 'Delivery skipped because destination is missing or disabled',
      eventId: row.event_id,
      deliveryId,
      destinationId: row.destination_id
    });
    return;
  }

  const cb = circuitConfig(destination);
  const permit = await circuitBreaker.beforeRequest(destination.id, cb.openSeconds);
  if (!permit.allowed) {
    const retryAt = new Date(Date.now() + (permit.retryAfterSeconds ?? cb.openSeconds) * 1000);
    await releaseDeliveryClaim({
      deliveryId,
      lockToken: claim.lockToken,
      status: 'retrying',
      nextAttemptAt: retryAt,
      error: 'CIRCUIT_OPEN'
    });
    logGatewayEvent({
      level: 'warn',
      event: 'delivery_circuit_open',
      component: 'worker-system',
      message: 'Delivery deferred because destination circuit is open',
      eventId: row.event_id,
      deliveryId,
      destinationId: destination.id,
      details: { retryAfterSeconds: permit.retryAfterSeconds }
    });
    return;
  }

  const attempt = await beginDeliveryAttempt(deliveryId, claim.lockToken);
  if (attempt === null) {
    logGatewayEvent({
      level: 'warn',
      event: 'delivery_lease_lost_before_attempt',
      component: 'worker-system',
      message: 'Delivery lease was lost before the HTTP attempt began',
      eventId: row.event_id,
      deliveryId,
      destinationId: destination.id
    });
    return;
  }

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
    const dispatched = await dispatchPinnedWebhook({
      url: requireEnv(destination.urlEnv),
      method: destination.method,
      headers,
      body,
      timeoutMs: destination.timeoutMs ?? env.DELIVERY_TIMEOUT_MS,
      allowPrivateNetwork: destination.allowPrivateNetwork === true
    });

    let responseBody = '';
    try {
      responseBody = await readResponseBodyLimited(dispatched.response, env.DELIVERY_MAX_RESPONSE_BYTES);
    } finally {
      await dispatched.close();
    }

    const outcome = evaluateDeliverySuccess(destination, dispatched.response);
    if (outcome === 'delivered') {
      const updated = await markDeliveryDelivered({
        deliveryId,
        lockToken: claim.lockToken,
        statusCode: dispatched.response.status,
        responseBody
      });
      await circuitBreaker.recordSuccess(destination.id);
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'delivered' });
      logGatewayEvent({
        level: updated ? 'info' : 'error',
        event: updated ? 'delivery_delivered' : 'delivery_result_lease_lost',
        component: 'worker-system',
        message: updated
          ? 'Delivery succeeded and was committed'
          : 'Delivery succeeded remotely but its lease was replaced before commit',
        eventId: row.event_id,
        deliveryId,
        destinationId: destination.id,
        details: { resolvedAddress: dispatched.resolved.address }
      });
      return;
    }

    if (outcome === 'unknown') {
      await markUnknownOrDead({
        deliveryId,
        lockToken: claim.lockToken,
        destination,
        attempt,
        statusCode: dispatched.response.status,
        responseBody,
        reason: '2xx response did not include the required acceptance proof'
      });
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'unknown' });
      logGatewayEvent({
        level: 'warn',
        event: 'delivery_unknown',
        component: 'worker-system',
        message: 'Delivery result is unknown',
        eventId: row.event_id,
        deliveryId,
        destinationId: destination.id
      });
      return;
    }

    const policy = deliveryFailurePolicy({
      response: dispatched.response,
      destination,
      attempt,
      responseBody
    });
    await updateDeliveryFailure({
      deliveryId,
      lockToken: claim.lockToken,
      status: policy.status,
      error: policy.reason,
      nextAttemptAt: policy.nextAttemptAt,
      lastStatusCode: dispatched.response.status,
      responseBody
    });
    if (policy.retryClass === 'infrastructure' || policy.retryClass === 'normal') {
      await circuitBreaker.recordFailure(destination.id, cb.threshold, cb.openSeconds);
    }
    deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: policy.status });
    logGatewayEvent({
      level: 'warn',
      event: 'delivery_http_failed',
      component: 'worker-system',
      message: 'Delivery received a non-success HTTP response',
      eventId: row.event_id,
      deliveryId,
      destinationId: destination.id,
      details: {
        statusCode: dispatched.response.status,
        retryClass: policy.retryClass,
        nextStatus: policy.status
      }
    });
  } catch (error) {
    if (isSecurityConfigurationError(error)) {
      await updateDeliveryFailure({
        deliveryId,
        lockToken: claim.lockToken,
        status: 'dead',
        error,
        nextAttemptAt: null
      });
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'security_blocked' });
      logGatewayEvent({
        level: 'error',
        event: 'delivery_security_blocked',
        component: 'worker-system',
        message: 'Delivery was blocked by destination URL or DNS security policy',
        eventId: row.event_id,
        deliveryId,
        destinationId: destination.id,
        details: { error: sanitizeText(error, 300) }
      });
      return;
    }

    await circuitBreaker.recordFailure(destination.id, cb.threshold, cb.openSeconds);
    if (isDeliveryTimeoutError(error)) {
      await markUnknownOrDead({
        deliveryId,
        lockToken: claim.lockToken,
        destination,
        attempt,
        statusCode: null,
        responseBody: null,
        reason: 'delivery timeout result unknown'
      });
      deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'unknown' });
      logGatewayEvent({
        level: 'warn',
        event: 'delivery_timeout_unknown',
        component: 'worker-system',
        message: 'Delivery timed out and was classified as unknown',
        eventId: row.event_id,
        deliveryId,
        destinationId: destination.id
      });
      return;
    }

    const final = isFinalDeliveryAttempt(attempt, destination.maxAttempts);
    await updateDeliveryFailure({
      deliveryId,
      lockToken: claim.lockToken,
      status: final ? 'dead' : 'retrying',
      error,
      nextAttemptAt: final ? null : nextDeliveryBackoff(attempt, { retryClass: 'infrastructure' })
    });
    deliveryCounter.inc({ destination: safeMetricLabel(destination.id), result: 'failed' });
    logGatewayEvent({
      level: 'warn',
      event: 'delivery_transport_failed',
      component: 'worker-system',
      message: 'Delivery transport failed',
      eventId: row.event_id,
      deliveryId,
      destinationId: destination.id,
      details: { final, error: sanitizeText(error, 300) }
    });
  }
}

async function markUnknownOrDead(input: {
  deliveryId: string;
  lockToken: string;
  destination: DestinationConfig;
  attempt: number;
  statusCode: number | null;
  responseBody: string | null;
  reason: string;
}): Promise<void> {
  const policy = input.destination.unknownPolicy ?? 'retry_then_dead';
  const final = policy === 'dead_immediately'
    || isFinalDeliveryAttempt(input.attempt, input.destination.maxAttempts)
    || !env.UNKNOWN_RETRY_ENABLED;
  await updateDeliveryFailure({
    deliveryId: input.deliveryId,
    lockToken: input.lockToken,
    status: final ? 'dead' : 'unknown',
    error: input.reason,
    nextAttemptAt: final ? null : nextDeliveryBackoff(input.attempt, { retryClass: 'unknown' }),
    lastStatusCode: input.statusCode,
    responseBody: input.responseBody
  });
}

export async function publishOutboxBatch(): Promise<number> {
  const items = await claimOutboxBatch(env.OUTBOX_BATCH_SIZE, env.OUTBOX_LEASE_SECONDS);
  if (items.length === 0) return 0;
  await Promise.all(items.map(async (item) => {
    const enqueued = await enqueueDeliveryBestEffort(item.deliveryId);
    if (enqueued) {
      await markOutboxPublished(item.id, item.lockToken);
      return;
    }
    await markOutboxFailed(
      item.id,
      item.lockToken,
      'BullMQ enqueue failed or timed out',
      new Date(Date.now() + env.INFRA_RETRY_BACKOFF_BASE_MS)
    );
  }));
  return items.length;
}

async function createAndEnqueueDeliveriesForImportedEvent(
  eventId: string,
  source: SourceConfig,
  eventType: string
): Promise<{ deliveries: number; enqueued: number }> {
  const routes = getMatchingRoutes(config.routes, source.id, eventType);
  const deliveryIds = await createDeliveries(eventId, routes, config.destinations);
  const enqueueResults = await Promise.allSettled(deliveryIds.map((id) => enqueueDeliveryBestEffort(id)));
  const enqueued = enqueueResults.filter(
    (result) => result.status === 'fulfilled' && result.value === true
  ).length;
  return { deliveries: deliveryIds.length, enqueued };
}

async function moveCorruptedSpoolFile(filePath: string, reason: string, error?: unknown): Promise<void> {
  try {
    const failed = await moveSpoolFileToFailed(filePath);
    spoolCorruptedCounter.inc();
    logGatewayEvent({
      level: 'error',
      event: 'spool_import_corrupted',
      component: 'worker-system',
      message: 'Corrupted emergency spool file moved to failed',
      details: { spoolFile: failed, reason, error: sanitizeText(error ?? '', 300) }
    });
  } catch (moveError) {
    logGatewayEvent({
      level: 'error',
      event: 'spool_import_corrupted_move_failed',
      component: 'worker-system',
      message: 'Corrupted emergency spool file could not be moved to failed',
      details: { spoolFile: filePath, reason, error: sanitizeText(moveError, 300) }
    });
  }
}

async function importSpoolFile(filePath: string): Promise<SpoolSweepResult> {
  const lockedPath = await lockSpoolFile(filePath);
  if (!lockedPath) return 'skipped';

  let payload: SpoolPayload;
  try {
    payload = await readSpoolFile(lockedPath);
  } catch (error) {
    await moveCorruptedSpoolFile(lockedPath, 'read_failed', error);
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
    const deliverySummary = event.duplicate
      ? { deliveries: 0, enqueued: 0 }
      : await createAndEnqueueDeliveriesForImportedEvent(event.id, source, verified.eventType);
    await removeSpoolFile(lockedPath);
    logGatewayEvent({
      level: event.duplicate ? 'info' : 'warn',
      event: event.duplicate ? 'spool_import_duplicate' : 'spool_import_success',
      component: 'worker-system',
      message: event.duplicate
        ? 'Emergency spool file matched an existing event and was reconciled'
        : 'Emergency spool file imported into the durable ledger',
      eventId: event.id,
      sourceId: source.id,
      details: {
        provider: source.provider,
        eventType: verified.eventType,
        deliveries: deliverySummary.deliveries,
        enqueued: deliverySummary.enqueued
      }
    });
    return event.duplicate ? 'duplicate' : 'success';
  } catch (error) {
    await unlockSpoolFile(lockedPath);
    logGatewayEvent({
      level: 'error',
      event: 'spool_import_db_error',
      component: 'worker-system',
      message: 'Emergency spool import failed on the durable DB path and will be retried',
      sourceId: source.id,
      details: { error: sanitizeText(error, 300) }
    });
    return 'db_error';
  }
}

async function importSpoolBatch(): Promise<Record<SpoolSweepResult, number>> {
  const summary: Record<SpoolSweepResult, number> = {
    success: 0,
    duplicate: 0,
    corrupted: 0,
    db_error: 0,
    skipped: 0
  };
  const files = (await listSpoolFiles()).slice(0, env.SPOOL_IMPORT_BATCH_SIZE);
  for (const file of files) {
    const result = await importSpoolFile(file);
    summary[result] += 1;
  }
  if (files.length > 0) {
    logGatewayEvent({
      level: 'info',
      event: 'spool_import_sweep',
      component: 'worker-system',
      message: 'Emergency spool import sweep completed',
      details: summary
    });
  }
  return summary;
}

async function recoverySweep(): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status='retrying', lock_token=NULL, lock_expires_at=NULL, updated_at=now()
     WHERE status='delivering'
       AND COALESCE(lock_expires_at, updated_at + ($1 || ' seconds')::interval) < now()`,
    [String(env.STALE_DELIVERING_SECONDS)]
  );
  await importSpoolBatch();
  await publishOutboxBatch();

  const purgedBodies = await purgeExpiredEventBodies(env.BODY_RETENTION_DAYS);
  if (purgedBodies > 0) {
    logGatewayEvent({
      level: 'info',
      event: 'raw_body_retention_purged',
      component: 'worker-system',
      message: 'Expired raw event bodies were purged',
      details: { purged: purgedBodies, retentionDays: env.BODY_RETENTION_DAYS }
    });
  }

  const due = await pool.query(
    `SELECT id FROM deliveries
     WHERE status IN ('queued','retrying','unknown')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     ORDER BY COALESCE(next_attempt_at, created_at) ASC
     LIMIT $1`,
    [env.RECOVERY_DELIVERY_BATCH_SIZE]
  );
  await Promise.allSettled(due.rows.map((row) => enqueueDeliveryBestEffort(String(row.id))));

  const counts = await countSpoolFiles();
  spoolFileGauge.set(counts.pending);
  spoolFailedFileGauge.set(counts.failed);
  const purged = await purgeFailedSpoolFiles();
  if (purged > 0) spoolPurgedCounter.inc(purged);
}

export async function startWorkerSystem(): Promise<void> {
  await migrate();
  tgServerLogSink.start();
  const worker = new Worker(
    env.QUEUE_NAME,
    async (job) => processDelivery(String(job.data.deliveryId)),
    { connection: redisConnection as never, concurrency: env.WORKER_CONCURRENCY }
  );

  worker.on('error', (error) => {
    logGatewayEvent({
      level: 'error',
      event: 'worker_runtime_error',
      component: 'worker-system',
      message: 'BullMQ worker emitted an error',
      details: { error: sanitizeText(error, 300) }
    });
  });
  worker.on('failed', (job, error) => {
    logGatewayEvent({
      level: 'warn',
      event: 'worker_job_failed',
      component: 'worker-system',
      message: 'BullMQ worker job failed',
      deliveryId: String(job?.data?.deliveryId ?? ''),
      details: { jobId: job?.id, error: sanitizeText(error, 300) }
    });
  });

  let outboxRunning = false;
  const outboxTick = async () => {
    if (outboxRunning) return;
    outboxRunning = true;
    try {
      await publishOutboxBatch();
    } finally {
      outboxRunning = false;
    }
  };

  let recoveryRunning = false;
  const recoveryTick = async () => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      await recoverySweep();
    } finally {
      recoveryRunning = false;
    }
  };

  const outboxTimer = setInterval(
    () => void outboxTick().catch((error) => logGatewayEvent({
      level: 'error',
      event: 'outbox_publish_failed',
      component: 'worker-system',
      message: 'Outbox publish cycle failed',
      details: { error: sanitizeText(error, 300) }
    })),
    env.OUTBOX_PUBLISH_INTERVAL_MS
  );
  const recoveryTimer = setInterval(
    () => void recoveryTick().catch((error) => logGatewayEvent({
      level: 'error',
      event: 'recovery_sweep_failed',
      component: 'worker-system',
      message: 'Recovery sweep failed',
      details: { error: sanitizeText(error, 300) }
    })),
    env.RECOVERY_INTERVAL_MS
  );
  outboxTimer.unref?.();
  recoveryTimer.unref?.();

  await recoveryTick();
  logGatewayEvent({
    level: 'info',
    event: 'worker_started',
    component: 'worker-system',
    message: 'webhook gateway worker started',
    details: { concurrency: env.WORKER_CONCURRENCY }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(outboxTimer);
    clearInterval(recoveryTimer);
    await tgServerLogSink.flush();
    tgServerLogSink.stop();
    await worker.close();
    await closeQueue();
    await closeDb();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
