import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { env } from './env.js';
import { loadGatewayConfig, validateGatewayConfig } from './config.js';
import { verifyInbound } from './verifiers.js';
import { sha256Hex } from './crypto.js';
import { migrate, insertEvent, createDeliveries, audit, closeDb, pool, checkReplayCooldown } from './db.js';
import { enqueueDeliveryBestEffort, closeQueue, redisConnection } from './queue.js';
import { writeSpoolFile, countSpoolFiles } from './spool.js';
import { FixedWindowRateLimiter } from './rateLimit.js';
import { checkClockSkew } from './clock.js';
import { sanitizeObject, safeMetricLabel } from './sanitize.js';
import { clockSkewCheckFailedCounter, clockSkewGauge, ingressCounter, rateLimitedCounter, registry, spoolFailedFileGauge, spoolFileGauge } from './metrics.js';
import type { RouteConfig } from './types.js';

const config = loadGatewayConfig();
validateGatewayConfig(config);

const app = express();
const ingressLimiter = new FixedWindowRateLimiter(env.INGRESS_RATE_LIMIT_PER_MINUTE, 60_000);
const adminLimiter = new FixedWindowRateLimiter(env.ADMIN_RATE_LIMIT_PER_MINUTE, 60_000);
const replayLimiter = new FixedWindowRateLimiter(env.REPLAY_RATE_LIMIT_PER_MINUTE, 60_000);

app.use(helmet());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/readyz', async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    await pool.query('SELECT 1');
    checks.postgres = true;
  } catch (err: any) {
    ok = false;
    checks.postgres = String(err.message ?? err);
  }
  try {
    await redisConnection.ping();
    checks.redis = true;
  } catch (err: any) {
    ok = false;
    checks.redis = String(err.message ?? err);
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
});

app.get('/metrics', async (_req, res) => {
  const spoolCounts = await countSpoolFiles();
  spoolFileGauge.set(spoolCounts.pending);
  spoolFailedFileGauge.set(spoolCounts.failed);
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
});

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
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

app.get('/admin/events', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const rows = await pool.query(
    `SELECT id, source_id, provider, provider_event_id, event_type, status, received_at, updated_at
     FROM events ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ events: rows.rows });
});

app.get('/admin/events/:id', requireAdmin, async (req, res) => {
  const event = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
  if (!event.rows[0]) return res.status(404).json({ error: 'event not found' });
  const deliveries = await pool.query('SELECT * FROM deliveries WHERE event_id=$1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ event: event.rows[0], deliveries: deliveries.rows });
});

app.post('/admin/events/:id/replay', requireAdmin, async (req, res) => {
  const rate = replayLimiter.check(`event:${req.params.id}`);
  if (!rate.allowed) return replayDenied(req, res, 'event', req.params.id, rate.retryAfterSeconds ?? env.REPLAY_EVENT_COOLDOWN_SECONDS);
  const cooldown = await checkReplayCooldown(`event:${req.params.id}`, env.REPLAY_EVENT_COOLDOWN_SECONDS);
  if (!cooldown.allowed) return replayDenied(req, res, 'event', req.params.id, cooldown.retryAfterSeconds ?? env.REPLAY_EVENT_COOLDOWN_SECONDS);

  const deliveries = await pool.query(
    `WITH picked AS (
      SELECT id FROM deliveries
      WHERE event_id=$1 AND status IN ('queued','retrying','unknown','dead')
      ORDER BY created_at ASC
      LIMIT $2
    )
    UPDATE deliveries d SET status='queued', next_attempt_at=NULL, updated_at=now()
    FROM picked WHERE d.id=picked.id
    RETURNING d.id`,
    [req.params.id, env.REPLAY_MAX_DELIVERIES_PER_REQUEST]
  );
  await Promise.allSettled(deliveries.rows.map((row) => enqueueDeliveryBestEffort(row.id)));
  await audit({ actor: 'admin', action: 'event.replay', resourceType: 'event', resourceId: req.params.id, result: 'ok', details: { deliveries: deliveries.rows.length }, ip: req.ip });
  res.json({ ok: true, requeued: deliveries.rows.length });
});

app.post('/admin/deliveries/:id/replay', requireAdmin, async (req, res) => {
  const rate = replayLimiter.check(`delivery:${req.params.id}`);
  if (!rate.allowed) return replayDenied(req, res, 'delivery', req.params.id, rate.retryAfterSeconds ?? env.REPLAY_DELIVERY_COOLDOWN_SECONDS);
  const cooldown = await checkReplayCooldown(`delivery:${req.params.id}`, env.REPLAY_DELIVERY_COOLDOWN_SECONDS);
  if (!cooldown.allowed) return replayDenied(req, res, 'delivery', req.params.id, cooldown.retryAfterSeconds ?? env.REPLAY_DELIVERY_COOLDOWN_SECONDS);
  const delivery = await pool.query(
    `UPDATE deliveries SET status='queued', next_attempt_at=NULL, updated_at=now() WHERE id=$1 RETURNING id`,
    [req.params.id]
  );
  if (!delivery.rows[0]) return res.status(404).json({ error: 'delivery not found' });
  await enqueueDeliveryBestEffort(delivery.rows[0].id);
  await audit({ actor: 'admin', action: 'delivery.replay', resourceType: 'delivery', resourceId: req.params.id, result: 'ok', ip: req.ip });
  res.json({ ok: true, deliveryId: delivery.rows[0].id });
});

app.get('/admin/audit-logs', requireAdmin, async (_req, res) => {
  const rows = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
  res.json({ auditLogs: rows.rows });
});

app.post('/ingress/:slug', express.raw({ type: '*/*', limit: env.MAX_BODY_BYTES }), async (req, res) => {
  const source = config.sources.find((item) => item.slug === req.params.slug && item.enabled);
  if (!source) return res.status(404).json({ error: 'unknown source' });
  const limit = ingressLimiter.check(`ingress:${source.provider}:${source.slug}`);
  if (!limit.allowed) {
    rateLimitedCounter.inc({ scope: 'ingress', source: safeMetricLabel(source.slug) });
    res.setHeader('retry-after', String(limit.retryAfterSeconds ?? 60));
    return res.status(429).json({ error: 'ingress rate limited', retryAfterSeconds: limit.retryAfterSeconds });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  const verified = verifyInbound(req, source, raw);
  if (!verified.ok) {
    ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'rejected' });
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
    extensions: { gatewayEventId: crypto.randomUUID(), sourceId: source.id, provider: source.provider, bodySha256, dataMode: verified.parsedJson ? 'json_object' : 'base64_raw' }
  };
  try {
    const event = await insertEvent({
      sourceId: source.id,
      provider: source.provider,
      providerEventId: verified.providerEventId,
      eventType: verified.eventType,
      bodySha256,
      bodyText: env.STORE_RAW_BODY ? raw.toString('utf8') : null,
      parsedJson: verified.parsedJson,
      normalizedPayload,
      cloudEvent,
      receivedIp: req.ip
    });
    if (event.duplicate) {
      ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'duplicate' });
      return res.status(202).json({ ok: true, duplicate: true, eventId: event.id, deliveries: 0 });
    }
    const routes = getMatchingRoutes(source.id, verified.eventType);
    const deliveryIds = await createDeliveries(event.id, routes, config.destinations);
    const enqueueResults = await Promise.allSettled(deliveryIds.map((id) => enqueueDeliveryBestEffort(id)));
    const enqueued = enqueueResults.filter((result) => result.status === 'fulfilled' && result.value === true).length;
    ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'accepted' });
    res.status(202).json({ ok: true, duplicate: false, eventId: event.id, deliveries: deliveryIds.length, enqueued });
  } catch (err: any) {
    const file = await writeSpoolFile({ receivedAt: new Date().toISOString(), source, headers: sanitizeObject(req.headers), body: raw.toString('utf8'), verified, cloudEvent });
    ingressCounter.inc({ source: safeMetricLabel(source.id), provider: source.provider, result: 'spooled' });
    res.status(202).json({ ok: true, spooled: true, file });
  }
});

async function replayDenied(req: express.Request, res: express.Response, type: 'event' | 'delivery', id: string, retryAfterSeconds: number): Promise<void> {
  rateLimitedCounter.inc({ scope: 'replay', source: type });
  await audit({ actor: 'admin', action: `${type}.replay`, resourceType: type, resourceId: id, result: 'rate_limited', details: { retryAfterSeconds }, ip: req.ip });
  res.setHeader('retry-after', String(retryAfterSeconds));
  res.status(429).json({ error: 'replay rate limited', retryAfterSeconds });
}

function getMatchingRoutes(sourceId: string, eventType: string): RouteConfig[] {
  return config.routes.filter((route) => route.enabled && route.sourceId === sourceId && (route.eventTypePattern === '*' || route.eventTypePattern === eventType));
}

async function main(): Promise<void> {
  await migrate();
  const server = app.listen(env.PORT, '0.0.0.0', () => console.log(`webhook gateway api listening on ${env.PORT}`));
  const shutdown = async () => {
    server.close();
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
