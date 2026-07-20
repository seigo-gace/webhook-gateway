import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { env } from '../part/env.js';
import { loadGatewayConfig, validateGatewayConfig } from '../feature/config.js';
import { verifyInbound } from '../feature/verifiers.js';
import { sha256Hex } from '../part/crypto.js';
import { asyncHandler, requireUuidParam } from '../part/http.js';
import { migrate, persistIngressWithDeliveries, audit, closeDb, pool, checkReplayCooldown } from '../feature/db.js';
import { enqueueDeliveryBestEffort, enqueueDeliveryDeferred, closeQueue, redisConnection } from '../feature/queue.js';
import { writeSpoolFile, countSpoolFiles } from '../feature/spool.js';
import { getMatchingRoutes } from '../component/routing.js';
import { FixedWindowRateLimiter } from '../part/rateLimit.js';
import { CompositeRateLimiter } from '../feature/composite-rate-limit.js';
import { checkClockSkew } from '../part/clock.js';
import { isIpAllowed, splitAllowlist } from '../part/ip-allowlist.js';
import { sanitizeObject, safeMetricLabel, sanitizeText } from '../part/sanitize.js';
import {
  clockSkewCheckFailedCounter,
  clockSkewGauge,
  ingressCounter,
  rateLimitedCounter,
  registry,
  spoolFailedFileGauge,
  spoolFileGauge
} from '../part/metrics.js';
import { logGatewayEvent, tgServerLogSink } from '../feature/tgserver-log.js';

const config = loadGatewayConfig();
validateGatewayConfig(config);

export const apiApp = express();
apiApp.disable('x-powered-by');
apiApp.set('trust proxy', env.TRUST_PROXY);
const adminAllowedCidrs = splitAllowlist(env.ADMIN_ALLOWED_CIDRS);
const ingressLimiter = new CompositeRateLimiter(
  redisConnection,
  env.INGRESS_RATE_LIMIT_PER_MINUTE,
  env.INGRESS_RATE_LIMIT_PER_MINUTE,
  60,
  env.REDIS_OPERATION_TIMEOUT_MS
);
const adminLimiter = new FixedWindowRateLimiter(env.ADMIN_RATE_LIMIT_PER_MINUTE, 60_000);
const replayLimiter = new FixedWindowRateLimiter(env.REPLAY_RATE_LIMIT_PER_MINUTE, 60_000);

apiApp.use(helmet());
apiApp.get('/healthz', (_req, res) => res.json({ ok: true }));

apiApp.get('/readyz', asyncHandler(async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    await pool.query('SELECT 1');
    checks.postgres = true;
  } catch (error) {
    ok = false;
    checks.postgres = sanitizeText(error, 300);
  }
  try {
    await redisConnection.ping();
    checks.redis = { ok: true, requiredForIngress: false };
  } catch (error) {
    // Redis transports delivery jobs but is not the durable source of truth.
    // Keep ingress ready while reporting degraded asynchronous delivery.
    checks.redis = {
      ok: false,
      requiredForIngress: false,
      degraded: true,
      error: sanitizeText(error, 300)
    };
  }
  const skew = await checkClockSkew();
  checks.clock = skew;
  if (skew.skewSeconds !== null) clockSkewGauge.set(Math.abs(skew.skewSeconds));
  if (skew.error) clockSkewCheckFailedCounter.inc();
  if (!skew.ok) ok = false;
  const spoolCounts = await countSpoolFiles();
  spoolFileGauge.set(spoolCounts.pending);
  spoolFailedFileGauge.set(spoolCounts.failed);
  res.status(ok ? 200 : 503).json({ ok, checks: sanitizeObject(checks) });
}));

apiApp.get('/metrics', asyncHandler(async (_req, res) => {
  const spoolCounts = await countSpoolFiles();
  spoolFileGauge.set(spoolCounts.pending);
  spoolFailedFileGauge.set(spoolCounts.failed);
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
}));

function requestIp(req: express.Request): string | undefined {
  return req.ip || req.socket.remoteAddress || undefined;
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = requestIp(req);
  if (!isIpAllowed(ip, adminAllowedCidrs)) {
    logGatewayEvent({
      level: 'warn',
      event: 'admin_ip_denied',
      component: 'api-system',
      message: 'Admin request denied by IP allowlist',
      details: { ip }
    });
    res.status(403).json({ error: 'admin ip denied' });
    return;
  }

  const key = `admin:${req.header('x-admin-token') ? 'token' : 'missing'}`;
  const limited = adminLimiter.check(key);
  if (!limited.allowed) {
    rateLimitedCounter.inc({ scope: 'admin', source: 'admin' });
    res.setHeader('retry-after', String(limited.retryAfterSeconds ?? 60));
    res.status(429).json({ error: 'admin rate limited', retryAfterSeconds: limited.retryAfterSeconds });
    return;
  }
  if (!env.ADMIN_TOKEN || req.header('x-admin-token') !== env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

apiApp.get('/admin/events', requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const rows = await pool.query(
    `SELECT id, source_id, provider, provider_event_id, event_type, status, received_at, updated_at
     FROM events ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ events: rows.rows });
}));

apiApp.get('/admin/events/:id', requireAdmin, requireUuidParam('id'), asyncHandler(async (req, res) => {
  const event = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
  if (!event.rows[0]) return res.status(404).json({ error: 'event not found' });
  const deliveries = await pool.query(
    'SELECT * FROM deliveries WHERE event_id=$1 ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json({ event: event.rows[0], deliveries: deliveries.rows });
}));

apiApp.post('/admin/events/:id/replay', requireAdmin, requireUuidParam('id'), asyncHandler(async (req, res) => {
  const rate = replayLimiter.check(`event:${req.params.id}`);
  if (!rate.allowed) {
    return replayDenied(req, res, 'event', req.params.id, rate.retryAfterSeconds ?? env.REPLAY_EVENT_COOLDOWN_SECONDS);
  }
  const cooldown = await checkReplayCooldown(`event:${req.params.id}`, env.REPLAY_EVENT_COOLDOWN_SECONDS);
  if (!cooldown.allowed) {
    return replayDenied(req, res, 'event', req.params.id, cooldown.retryAfterSeconds ?? env.REPLAY_EVENT_COOLDOWN_SECONDS);
  }
  const deliveries = await pool.query(
    `WITH picked AS (
       SELECT id FROM deliveries
       WHERE event_id=$1 AND status IN ('queued','retrying','unknown','dead','skipped')
       ORDER BY created_at ASC LIMIT $2
     )
     UPDATE deliveries d
     SET status='queued', next_attempt_at=NULL, lock_token=NULL, lock_expires_at=NULL, updated_at=now()
     FROM picked WHERE d.id=picked.id RETURNING d.id`,
    [req.params.id, env.REPLAY_MAX_DELIVERIES_PER_REQUEST]
  );
  await Promise.allSettled(deliveries.rows.map((row) => enqueueDeliveryBestEffort(String(row.id))));
  await audit({
    actor: 'admin',
    action: 'event.replay',
    resourceType: 'event',
    resourceId: req.params.id,
    result: 'ok',
    details: { deliveries: deliveries.rows.length },
    ip: req.ip
  });
  logGatewayEvent({
    level: 'warn',
    event: 'admin_event_replay',
    component: 'api-system',
    message: 'Admin replay requested for event',
    eventId: req.params.id,
    details: { requeued: deliveries.rows.length }
  });
  res.json({ ok: true, requeued: deliveries.rows.length });
}));

apiApp.post('/admin/deliveries/:id/replay', requireAdmin, requireUuidParam('id'), asyncHandler(async (req, res) => {
  const rate = replayLimiter.check(`delivery:${req.params.id}`);
  if (!rate.allowed) {
    return replayDenied(req, res, 'delivery', req.params.id, rate.retryAfterSeconds ?? env.REPLAY_DELIVERY_COOLDOWN_SECONDS);
  }
  const cooldown = await checkReplayCooldown(`delivery:${req.params.id}`, env.REPLAY_DELIVERY_COOLDOWN_SECONDS);
  if (!cooldown.allowed) {
    return replayDenied(req, res, 'delivery', req.params.id, cooldown.retryAfterSeconds ?? env.REPLAY_DELIVERY_COOLDOWN_SECONDS);
  }
  const delivery = await pool.query(
    `UPDATE deliveries
     SET status='queued', next_attempt_at=NULL, lock_token=NULL, lock_expires_at=NULL, updated_at=now()
     WHERE id=$1 RETURNING id`,
    [req.params.id]
  );
  if (!delivery.rows[0]) return res.status(404).json({ error: 'delivery not found' });
  await enqueueDeliveryBestEffort(String(delivery.rows[0].id));
  await audit({
    actor: 'admin',
    action: 'delivery.replay',
    resourceType: 'delivery',
    resourceId: req.params.id,
    result: 'ok',
    ip: req.ip
  });
  logGatewayEvent({
    level: 'warn',
    event: 'admin_delivery_replay',
    component: 'api-system',
    message: 'Admin replay requested for delivery',
    deliveryId: req.params.id
  });
  res.json({ ok: true, deliveryId: delivery.rows[0].id });
}));

apiApp.get('/admin/audit-logs', requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
  res.json({ auditLogs: rows.rows });
}));

apiApp.post('/ingress/:slug', express.raw({ type: '*/*', limit: env.MAX_BODY_BYTES }), asyncHandler(async (req, res) => {
  const source = config.sources.find((item) => item.slug === req.params.slug && item.enabled);
  if (!source) {
    logGatewayEvent({
      level: 'warn',
      event: 'ingress_unknown_source',
      component: 'api-system',
      message: 'Ingress rejected because source slug is unknown',
      details: { slug: req.params.slug }
    });
    return res.status(404).json({ error: 'unknown source' });
  }

  const ip = requestIp(req);
  if (!isIpAllowed(ip, source.allowedCidrs)) {
    ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'ip_denied' });
    logGatewayEvent({
      level: 'warn',
      event: 'ingress_ip_denied',
      component: 'api-system',
      message: 'Ingress request denied by source IP allowlist',
      sourceId: source.id,
      details: { provider: source.provider, ip }
    });
    return res.status(403).json({ error: 'source ip denied' });
  }

  const limit = await ingressLimiter.check(`${source.provider}:${source.slug}`, ip ?? 'unknown');
  if (!limit.allowed) {
    rateLimitedCounter.inc({ scope: 'ingress', source: safeMetricLabel(source.slug) });
    res.setHeader('retry-after', String(limit.retryAfterSeconds ?? 60));
    logGatewayEvent({
      level: 'warn',
      event: 'ingress_rate_limited',
      component: 'api-system',
      message: 'Ingress request rate limited',
      sourceId: source.id,
      details: {
        provider: source.provider,
        retryAfterSeconds: limit.retryAfterSeconds,
        backend: limit.backend
      }
    });
    return res.status(429).json({ error: 'ingress rate limited', retryAfterSeconds: limit.retryAfterSeconds });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  const verified = verifyInbound(req, source, raw);
  if (!verified.ok) {
    ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'rejected' });
    logGatewayEvent({
      level: 'warn',
      event: 'ingress_rejected',
      component: 'api-system',
      message: 'Ingress verification failed',
      sourceId: source.id,
      details: { provider: source.provider, reason: verified.reason, statusCode: verified.statusCode }
    });
    return res.status(verified.statusCode).json({ error: verified.reason });
  }

  const bodySha256 = sha256Hex(raw);
  const normalizedPayload = verified.parsedJson ?? { base64: raw.toString('base64') };
  const cloudEvent = {
    specversion: '1.0',
    id: verified.providerEventId,
    source: `${source.provider}:${source.id}`,
    type: verified.eventType,
    time: new Date().toISOString(),
    datacontenttype: verified.parsedJson ? 'application/json' : 'application/octet-stream',
    data: normalizedPayload,
    extensions: {
      gatewayEventId: crypto.randomUUID(),
      sourceId: source.id,
      provider: source.provider,
      bodySha256,
      dataMode: verified.parsedJson ? 'json_object' : 'base64_raw'
    }
  };

  try {
    const routes = getMatchingRoutes(config.routes, source.id, verified.eventType);
    const event = await persistIngressWithDeliveries(
      {
        sourceId: source.id,
        provider: source.provider,
        providerEventId: verified.providerEventId,
        eventType: verified.eventType,
        bodySha256,
        bodyText: env.STORE_RAW_BODY ? raw.toString('utf8') : null,
        parsedJson: verified.parsedJson,
        normalizedPayload,
        cloudEvent,
        receivedIp: ip
      },
      routes,
      config.destinations
    );

    if (event.duplicate) {
      ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'duplicate' });
      logGatewayEvent({
        level: 'info',
        event: 'ingress_duplicate',
        component: 'api-system',
        message: 'Duplicate webhook accepted without new delivery',
        eventId: event.id,
        sourceId: source.id,
        details: { provider: source.provider, eventType: verified.eventType }
      });
      return res.status(202).json({ ok: true, duplicate: true, eventId: event.id, deliveries: 0 });
    }

    event.deliveryIds.forEach((id) => enqueueDeliveryDeferred(id));
    ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'accepted' });
    logGatewayEvent({
      level: 'info',
      event: 'ingress_accepted',
      component: 'api-system',
      message: 'Webhook accepted after atomic event, delivery, and outbox persistence; enqueue is deferred',
      eventId: event.id,
      sourceId: source.id,
      details: {
        provider: source.provider,
        eventType: verified.eventType,
        deliveries: event.deliveryIds.length,
        enqueueMode: 'deferred+outbox'
      }
    });
    return res.status(202).json({
      ok: true,
      duplicate: false,
      eventId: event.id,
      deliveries: event.deliveryIds.length,
      enqueueMode: 'deferred+outbox'
    });
  } catch (error) {
    try {
      await writeSpoolFile({
        receivedAt: new Date().toISOString(),
        source,
        headers: sanitizeObject(req.headers),
        body: raw.toString('utf8'),
        verified,
        cloudEvent
      });
      ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'spooled' });
      logGatewayEvent({
        level: 'error',
        event: 'ingress_spooled',
        component: 'api-system',
        message: 'Webhook was spooled after the atomic durable DB path failed',
        sourceId: source.id,
        details: { provider: source.provider, dbError: sanitizeText(error, 300) }
      });
      return res.status(202).json({ ok: true, spooled: true });
    } catch (spoolError) {
      ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'spool_failed' });
      logGatewayEvent({
        level: 'error',
        event: 'ingress_spool_failed',
        component: 'api-system',
        message: 'Webhook could not be persisted to DB or emergency spool',
        sourceId: source.id,
        details: {
          provider: source.provider,
          dbError: sanitizeText(error, 300),
          spoolError: sanitizeText(spoolError, 300)
        }
      });
      return res.status(503).json({ ok: false, error: 'durable storage unavailable' });
    }
  }
}));

apiApp.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  logGatewayEvent({
    level: 'error',
    event: 'api_unhandled_error',
    component: 'api-system',
    message: 'Unhandled API route error',
    details: { error: sanitizeText(error, 300) }
  });
  res.status(500).json({ error: 'internal server error' });
});

async function replayDenied(
  req: express.Request,
  res: express.Response,
  type: 'event' | 'delivery',
  id: string,
  retryAfterSeconds: number
): Promise<void> {
  rateLimitedCounter.inc({ scope: 'replay', source: type });
  await audit({
    actor: 'admin',
    action: `${type}.replay`,
    resourceType: type,
    resourceId: id,
    result: 'rate_limited',
    details: { retryAfterSeconds },
    ip: req.ip
  });
  logGatewayEvent({
    level: 'warn',
    event: 'admin_replay_rate_limited',
    component: 'api-system',
    message: 'Admin replay was rate limited',
    details: { type, id, retryAfterSeconds }
  });
  res.setHeader('retry-after', String(retryAfterSeconds));
  res.status(429).json({ error: 'replay rate limited', retryAfterSeconds });
}

export async function startApiSystem(): Promise<void> {
  await migrate();
  tgServerLogSink.start();
  const server = apiApp.listen(env.PORT, '0.0.0.0', () => {
    logGatewayEvent({
      level: 'info',
      event: 'api_started',
      component: 'api-system',
      message: `webhook gateway api listening on ${env.PORT}`
    });
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logGatewayEvent({
      level: 'info',
      event: 'api_shutdown',
      component: 'api-system',
      message: 'webhook gateway api shutting down'
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tgServerLogSink.flush();
    tgServerLogSink.stop();
    await closeQueue();
    await closeDb();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
