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
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://webhook:webhook_password@127.0.0.1:5432/webhook_gateway',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
  QUEUE_NAME: process.env.QUEUE_NAME ?? 'webhook-deliveries',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? '',
  MAX_BODY_BYTES: intEnv('MAX_BODY_BYTES', 1048576),
  DEFAULT_TOLERANCE_SECONDS: intEnv('DEFAULT_TOLERANCE_SECONDS', 300),
  ENABLE_EMERGENCY_SPOOL: boolEnv('ENABLE_EMERGENCY_SPOOL', true),
  SPOOL_DIR: process.env.SPOOL_DIR ?? '/spool',
  RECOVERY_SWEEP_INTERVAL_MS: intEnv('RECOVERY_SWEEP_INTERVAL_MS', 30000),
  STALE_DELIVERING_SECONDS: intEnv('STALE_DELIVERING_SECONDS', 120)
};

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}
