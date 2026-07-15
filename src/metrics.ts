import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const ingressCounter = new client.Counter({
  name: 'webhook_ingress_total',
  help: 'Webhook ingress count',
  labelNames: ['source', 'provider', 'result'],
  registers: [registry]
});

export const rateLimitedCounter = new client.Counter({
  name: 'webhook_rate_limited_total',
  help: 'Rate limited requests',
  labelNames: ['scope', 'source'],
  registers: [registry]
});

export const deliveryCounter = new client.Counter({
  name: 'webhook_delivery_total',
  help: 'Delivery attempts by result',
  labelNames: ['destination', 'result'],
  registers: [registry]
});

export const clockSkewGauge = new client.Gauge({
  name: 'webhook_clock_skew_seconds',
  help: 'Measured clock skew in seconds',
  registers: [registry]
});

export const clockSkewCheckFailedCounter = new client.Counter({
  name: 'webhook_clock_skew_check_failed_total',
  help: 'Clock skew check failures',
  registers: [registry]
});

export const spoolFileGauge = new client.Gauge({
  name: 'webhook_spool_file_count',
  help: 'Pending spool file count',
  registers: [registry]
});

export const spoolFailedFileGauge = new client.Gauge({
  name: 'webhook_spool_failed_file_count',
  help: 'Failed spool file count',
  registers: [registry]
});

export const spoolCorruptedCounter = new client.Counter({
  name: 'webhook_spool_corrupted_total',
  help: 'Corrupted spool files moved to failed',
  registers: [registry]
});

export const spoolPurgedCounter = new client.Counter({
  name: 'webhook_spool_purged_total',
  help: 'Purged failed spool files',
  registers: [registry]
});
