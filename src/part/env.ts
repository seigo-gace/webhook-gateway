import 'dotenv/config';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric env: ${name}`);
  return n;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: intEnv('PORT', 7373),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  LOG_TO_TGSERVER: boolEnv('LOG_TO_TGSERVER', true),
  TGSERVER_LOG_URL: process.env.TGSERVER_LOG_URL ?? '',
  TGSERVER_LOG_SECRET: process.env.TGSERVER_LOG_SECRET ?? '',
  TGSERVER_LOG_MIN_LEVEL: process.env.TGSERVER_LOG_MIN_LEVEL ?? 'info',
  TGSERVER_LOG_TIMEOUT_MS: intEnv('TGSERVER_LOG_TIMEOUT_MS', 1000),
  TGSERVER_LOG_FLUSH_INTERVAL_MS: intEnv('TGSERVER_LOG_FLUSH_INTERVAL_MS', 2000),
  TGSERVER_LOG_BATCH_SIZE: intEnv('TGSERVER_LOG_BATCH_SIZE', 50),
  TGSERVER_LOG_QUEUE_LIMIT: intEnv('TGSERVER_LOG_QUEUE_LIMIT', 1000),
  TRUST_PROXY: boolEnv('TRUST_PROXY', false),
  ADMIN_ALLOWED_CIDRS: process.env.ADMIN_ALLOWED_CIDRS ?? '',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://webhook:webhook_password@127.0.0.1:5432/webhook_gateway',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
  QUEUE_NAME: process.env.QUEUE_NAME ?? 'webhook-deliveries',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? '',
  MAX_BODY_BYTES: intEnv('MAX_BODY_BYTES', 1048576),
  DEFAULT_TOLERANCE_SECONDS: intEnv('DEFAULT_TOLERANCE_SECONDS', 300),
  DELIVERY_TIMEOUT_MS: intEnv('DELIVERY_TIMEOUT_MS', 30000),
  QUEUE_ENQUEUE_TIMEOUT_MS: intEnv('QUEUE_ENQUEUE_TIMEOUT_MS', 1500),
  INGRESS_RATE_LIMIT_PER_MINUTE: intEnv('INGRESS_RATE_LIMIT_PER_MINUTE', 600),
  ADMIN_RATE_LIMIT_PER_MINUTE: intEnv('ADMIN_RATE_LIMIT_PER_MINUTE', 60),
  REPLAY_RATE_LIMIT_PER_MINUTE: intEnv('REPLAY_RATE_LIMIT_PER_MINUTE', 10),
  REPLAY_EVENT_COOLDOWN_SECONDS: intEnv('REPLAY_EVENT_COOLDOWN_SECONDS', 300),
  REPLAY_DELIVERY_COOLDOWN_SECONDS: intEnv('REPLAY_DELIVERY_COOLDOWN_SECONDS', 60),
  REPLAY_MAX_DELIVERIES_PER_REQUEST: intEnv('REPLAY_MAX_DELIVERIES_PER_REQUEST', 100),
  STORE_RAW_BODY: boolEnv('STORE_RAW_BODY', false),
  BODY_RETENTION_DAYS: intEnv('BODY_RETENTION_DAYS', 7),
  ENABLE_CLOCK_SKEW_CHECK: boolEnv('ENABLE_CLOCK_SKEW_CHECK', false),
  CLOCK_SKEW_REQUIRED: boolEnv('CLOCK_SKEW_REQUIRED', false),
  MAX_CLOCK_SKEW_SECONDS: intEnv('MAX_CLOCK_SKEW_SECONDS', 30),
  CLOCK_SKEW_CACHE_SECONDS: intEnv('CLOCK_SKEW_CACHE_SECONDS', 30),
  CLOCK_SKEW_CHECK_MODE: process.env.CLOCK_SKEW_CHECK_MODE ?? 'chronyc',
  ENABLE_EMERGENCY_SPOOL: boolEnv('ENABLE_EMERGENCY_SPOOL', true),
  SPOOL_STORAGE_MODE: process.env.SPOOL_STORAGE_MODE ?? 'plain_dev',
  SPOOL_DIR: process.env.SPOOL_DIR ?? '/spool',
  SPOOL_RETENTION_DAYS: intEnv('SPOOL_RETENTION_DAYS', 7),
  SPOOL_FAILED_RETENTION_DAYS: intEnv('SPOOL_FAILED_RETENTION_DAYS', 7),
  SPOOL_IMPORT_BATCH_SIZE: intEnv('SPOOL_IMPORT_BATCH_SIZE', 50),
  RECOVERY_INTERVAL_MS: intEnv('RECOVERY_INTERVAL_MS', intEnv('RECOVERY_SWEEP_INTERVAL_MS', 30000)),
  RECOVERY_DELIVERY_BATCH_SIZE: intEnv('RECOVERY_DELIVERY_BATCH_SIZE', 100),
  STALE_DELIVERING_SECONDS: intEnv('STALE_DELIVERING_SECONDS', 120),
  WORKER_CONCURRENCY: intEnv('WORKER_CONCURRENCY', 10),
  UNKNOWN_RETRY_ENABLED: boolEnv('UNKNOWN_RETRY_ENABLED', true),
  UNKNOWN_RETRY_BACKOFF_BASE_MS: intEnv('UNKNOWN_RETRY_BACKOFF_BASE_MS', 5000)
};

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
