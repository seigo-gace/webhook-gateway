import 'dotenv/config';
import { z } from 'zod';

const nonNegativeInt = (fallback: number) => z.preprocess(
  (value) => value === undefined || value === '' ? fallback : Number(value),
  z.number().int().nonnegative()
);

const positiveInt = (fallback: number) => z.preprocess(
  (value) => value === undefined || value === '' ? fallback : Number(value),
  z.number().int().positive()
);

const booleanValue = (fallback: boolean) => z.preprocess((value) => {
  if (value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(7373),
  LOG_LEVEL: z.string().min(1).default('info'),
  LOG_TO_TGSERVER: booleanValue(true),
  TGSERVER_LOG_URL: z.string().default(''),
  TGSERVER_LOG_SECRET: z.string().default(''),
  TGSERVER_LOG_MIN_LEVEL: z.string().min(1).default('info'),
  TGSERVER_LOG_TIMEOUT_MS: positiveInt(1000),
  TGSERVER_LOG_FLUSH_INTERVAL_MS: positiveInt(2000),
  TGSERVER_LOG_BATCH_SIZE: positiveInt(50),
  TGSERVER_LOG_QUEUE_LIMIT: positiveInt(1000),
  TRUST_PROXY: booleanValue(false),
  ADMIN_ALLOWED_CIDRS: z.string().default(''),
  DATABASE_URL: z.string().min(1).default('postgres://webhook:webhook_password@127.0.0.1:5432/webhook_gateway'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379/0'),
  QUEUE_NAME: z.string().min(1).default('webhook-deliveries'),
  ADMIN_TOKEN: z.string().default(''),
  MAX_BODY_BYTES: positiveInt(1_048_576),
  DEFAULT_TOLERANCE_SECONDS: nonNegativeInt(300),
  DELIVERY_TIMEOUT_MS: positiveInt(30_000),
  DELIVERY_MAX_RESPONSE_BYTES: positiveInt(65_536),
  DELIVERY_LEASE_SECONDS: positiveInt(90),
  QUEUE_ENQUEUE_TIMEOUT_MS: positiveInt(1500),
  REDIS_OPERATION_TIMEOUT_MS: positiveInt(500),
  INGRESS_RATE_LIMIT_PER_MINUTE: positiveInt(600),
  ADMIN_RATE_LIMIT_PER_MINUTE: positiveInt(60),
  REPLAY_RATE_LIMIT_PER_MINUTE: positiveInt(10),
  REPLAY_EVENT_COOLDOWN_SECONDS: nonNegativeInt(300),
  REPLAY_DELIVERY_COOLDOWN_SECONDS: nonNegativeInt(60),
  REPLAY_MAX_DELIVERIES_PER_REQUEST: positiveInt(100),
  STORE_RAW_BODY: booleanValue(false),
  BODY_RETENTION_DAYS: nonNegativeInt(7),
  ENABLE_CLOCK_SKEW_CHECK: booleanValue(false),
  CLOCK_SKEW_REQUIRED: booleanValue(false),
  MAX_CLOCK_SKEW_SECONDS: nonNegativeInt(30),
  CLOCK_SKEW_CACHE_SECONDS: positiveInt(30),
  CLOCK_SKEW_CHECK_MODE: z.string().min(1).default('chronyc'),
  ENABLE_EMERGENCY_SPOOL: booleanValue(true),
  SPOOL_STORAGE_MODE: z.enum(['plain_dev', 'encrypted_volume', 'encrypted_file']).default('plain_dev'),
  SPOOL_DIR: z.string().min(1).default('/spool'),
  SPOOL_ENCRYPTION_KEY: z.string().default(''),
  SPOOL_HMAC_KEY: z.string().default(''),
  SPOOL_RETENTION_DAYS: nonNegativeInt(7),
  SPOOL_FAILED_RETENTION_DAYS: nonNegativeInt(7),
  SPOOL_IMPORT_BATCH_SIZE: positiveInt(50),
  RECOVERY_INTERVAL_MS: positiveInt(30_000),
  RECOVERY_DELIVERY_BATCH_SIZE: positiveInt(100),
  STALE_DELIVERING_SECONDS: positiveInt(120),
  OUTBOX_PUBLISH_INTERVAL_MS: positiveInt(500),
  OUTBOX_BATCH_SIZE: positiveInt(100),
  OUTBOX_LEASE_SECONDS: positiveInt(30),
  WORKER_CONCURRENCY: positiveInt(10),
  UNKNOWN_RETRY_ENABLED: booleanValue(true),
  UNKNOWN_RETRY_BACKOFF_BASE_MS: positiveInt(5000),
  RETRY_AFTER_MAX_SECONDS: positiveInt(21_600),
  THROTTLE_RETRY_BACKOFF_BASE_MS: positiveInt(30_000),
  INFRA_RETRY_BACKOFF_BASE_MS: positiveInt(10_000),
  CLIENT_ERROR_RETRY_ENABLED: booleanValue(false),
  DESTINATION_CIRCUIT_BREAKER_FAILURE_THRESHOLD: positiveInt(5),
  DESTINATION_CIRCUIT_BREAKER_OPEN_SECONDS: positiveInt(300)
});

const input = {
  ...process.env,
  RECOVERY_INTERVAL_MS: process.env.RECOVERY_INTERVAL_MS ?? process.env.RECOVERY_SWEEP_INTERVAL_MS
};

const parsed = environmentSchema.safeParse(input);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = Object.freeze(parsed.data);

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
