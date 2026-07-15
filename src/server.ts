import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import client from 'prom-client';
import { env } from './env.js';
import { loadGatewayConfig } from './config.js';
import { verifyInbound } from './verifiers.js';
import { sha256Hex } from './crypto.js';
import { migrate, insertEvent, createDeliveries, closeDb } from './db.js';
import { enqueueDelivery, closeQueue } from './queue.js';
import { writeSpoolFile } from './spool.js';

const cfg = loadGatewayConfig();
const app = express();
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const ingressCounter = new client.Counter({ name: 'webhook_ingress_total', help: 'Webhook ingress count', labelNames: ['source', 'result'] });
registry.registerMetric(ingressCounter);

app.use(helmet());

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try {
    await migrate();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: err.message });
  }
});
app.get('/metrics', async (_req, res) => {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
});

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!env.ADMIN_TOKEN || req.header('x-admin-token') !== env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

app.get('/admin/events', requireAdmin, async (_req, res) => {
  const { pool } = await import('./db.js');
  const rows = await pool.query('SELECT id, source_id, provider, provider_event_id, event_type, status, received_at FROM events ORDER BY received_at DESC LIMIT 50');
  res.json({ events: rows.rows });
});

app.post('/ingress/:slug', express.raw({ type: '*/*', limit: env.MAX_BODY_BYTES }), async (req, res) => {
  const source = cfg.sources.find((s) => s.slug === req.params.slug && s.enabled);
  if (!source) return res.status(404).json({ error: 'unknown source' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  const verified = verifyInbound(req, source as any, raw);
  if (!verified.ok) {
    ingressCounter.inc({ source: source.id, result: 'rejected' });
    return res.status(verified.statusCode).json({ error: verified.reason });
  }

  const cloudEvent = {
    specversion: '1.0',
    id: verified.providerEventId,
    source: `${source.provider}:${source.id}`,
    type: verified.eventType,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: verified.parsedJson ?? raw.toString('utf8'),
    extensions: {
      gatewayEventId: crypto.randomUUID(),
      sourceId: source.id,
      provider: source.provider,
      bodySha256: sha256Hex(raw)
    }
  };

  try {
    const event = await insertEvent({
      sourceId: source.id,
      provider: source.provider,
      providerEventId: verified.providerEventId,
      eventType: verified.eventType,
      bodySha256: sha256Hex(raw),
      bodyText: raw.toString('utf8'),
      parsedJson: verified.parsedJson,
      cloudEvent
    });
    const routes = cfg.routes.filter((r) => r.sourceId === source.id && r.enabled);
    const deliveries = event.duplicate ? [] : await createDeliveries(event.id, routes, cfg.destinations);
    await Promise.allSettled(deliveries.map((id) => enqueueDelivery(id)));
    ingressCounter.inc({ source: source.id, result: event.duplicate ? 'duplicate' : 'accepted' });
    return res.status(202).json({ ok: true, eventId: event.id, duplicate: event.duplicate, deliveries: deliveries.length });
  } catch (err: any) {
    const file = await writeSpoolFile({ receivedAt: new Date().toISOString(), source, headers: req.headers, body: raw.toString('utf8'), verified, cloudEvent });
    ingressCounter.inc({ source: source.id, result: 'spooled' });
    return res.status(202).json({ ok: true, spooled: true, file });
  }
});

async function main() {
  await migrate();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`webhook gateway listening on ${env.PORT}`);
  });
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
