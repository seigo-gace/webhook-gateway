import crypto from 'node:crypto';
import { Worker } from 'bullmq';
import { env, requireEnv } from './env.js';
import { loadGatewayConfig } from './config.js';
import { decodeSecret, hmacSha256 } from './crypto.js';
import { pool, migrate, closeDb } from './db.js';
import { redisConnection, closeQueue } from './queue.js';

const cfg = loadGatewayConfig();

function signBody(body: string, secretValue: string) {
  const id = crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = hmacSha256(decodeSecret(secretValue), `${id}.${ts}.${body}`).toString('base64');
  return { id, ts, sig: `v1,${sig}` };
}

async function processDelivery(deliveryId: string): Promise<void> {
  const res = await pool.query(
    `SELECT d.*, e.cloud_event, e.body_text, e.provider, e.source_id
     FROM deliveries d JOIN events e ON e.id=d.event_id
     WHERE d.id=$1`,
    [deliveryId]
  );
  const row = res.rows[0];
  if (!row || row.status === 'delivered') return;
  const dest = cfg.destinations.find((d) => d.id === row.destination_id && d.enabled);
  if (!dest) throw new Error(`Destination not found: ${row.destination_id}`);

  await pool.query('UPDATE deliveries SET status=$2, attempt_count=attempt_count+1, updated_at=now() WHERE id=$1', [deliveryId, 'delivering']);

  const body = dest.payloadMode === 'raw'
    ? String(row.body_text ?? '')
    : JSON.stringify(row.cloud_event ?? {});

  const headers: Record<string, string> = {
    'content-type': dest.payloadMode === 'raw' ? 'application/octet-stream' : 'application/json',
    'x-gace-event-id': row.event_id,
    'x-gace-delivery-id': row.id,
    'x-gace-provider': row.provider,
    ...(dest.headers ?? {})
  };

  if (dest.signingSecretEnv) {
    const signed = signBody(body, requireEnv(dest.signingSecretEnv));
    headers['webhook-id'] = signed.id;
    headers['webhook-timestamp'] = signed.ts;
    headers['webhook-signature'] = signed.sig;
  }

  try {
    const url = requireEnv(dest.urlEnv);
    const response = await fetch(url, { method: dest.method, headers, body, signal: AbortSignal.timeout(dest.timeoutMs) });
    if (response.status >= 200 && response.status < 300) {
      await pool.query('UPDATE deliveries SET status=$2, last_status_code=$3, delivered_at=now(), updated_at=now() WHERE id=$1', [deliveryId, 'delivered', response.status]);
      return;
    }
    throw new Error(`Downstream returned ${response.status}: ${await response.text()}`);
  } catch (err: any) {
    const current = await pool.query('SELECT attempt_count, max_attempts FROM deliveries WHERE id=$1', [deliveryId]);
    const attempts = Number(current.rows[0]?.attempt_count ?? 1);
    const max = Number(current.rows[0]?.max_attempts ?? dest.maxAttempts);
    const final = attempts >= max;
    await pool.query(
      'UPDATE deliveries SET status=$2, last_error=$3, next_attempt_at=$4, updated_at=now() WHERE id=$1',
      [deliveryId, final ? 'dead' : 'retrying', String(err.message ?? err).slice(0, 2000), final ? null : new Date(Date.now() + Math.min(21600000, 5000 * 2 ** Math.max(0, attempts - 1))).toISOString()]
    );
    if (!final) throw err;
  }
}

async function recoverDueDeliveries(): Promise<void> {
  const due = await pool.query(
    `SELECT id FROM deliveries
     WHERE status IN ('queued','retrying')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     LIMIT 100`
  );
  const { enqueueDelivery } = await import('./queue.js');
  await Promise.allSettled(due.rows.map((r) => enqueueDelivery(r.id)));

  await pool.query(
    `UPDATE deliveries SET status='retrying', updated_at=now()
     WHERE status='delivering'
       AND updated_at < now() - ($1 || ' seconds')::interval`,
    [String(env.STALE_DELIVERING_SECONDS)]
  );
}

async function main() {
  await migrate();
  const worker = new Worker(env.QUEUE_NAME, async (job) => processDelivery(job.data.deliveryId), {
    connection: redisConnection as any,
    concurrency: 10
  });
  const timer = setInterval(() => void recoverDueDeliveries().catch(console.error), env.RECOVERY_SWEEP_INTERVAL_MS);
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
  console.error(err);
  process.exit(1);
});
