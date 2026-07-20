import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

export interface CircuitBreakerPermit {
  allowed: boolean;
  retryAfterSeconds?: number;
  probe: boolean;
  backend: 'redis' | 'degraded';
}

const BEFORE_REQUEST_SCRIPT = `
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local now = tonumber(ARGV[1])
if openUntil > now then
  return {0, math.ceil((openUntil - now) / 1000), 0}
end
if openUntil > 0 then
  local probe = redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3], 'NX')
  if not probe then return {0, 1, 0} end
  return {1, 0, 1}
end
return {1, 0, 0}
`;

const RECORD_FAILURE_SCRIPT = `
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
local threshold = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local openMs = tonumber(ARGV[3])
if failures >= threshold then
  redis.call('HSET', KEYS[1], 'open_until', now + openMs)
  redis.call('PEXPIRE', KEYS[1], openMs * 2)
end
redis.call('DEL', KEYS[2])
return failures
`;

export class RedisCircuitBreaker {
  constructor(
    private readonly redis: Redis,
    private readonly operationTimeoutMs = 500,
    private readonly prefix = 'webhook:circuit'
  ) {}

  async beforeRequest(destinationId: string, openSeconds: number): Promise<CircuitBreakerPermit> {
    const stateKey = this.stateKey(destinationId);
    const probeKey = this.probeKey(destinationId);
    const probeToken = crypto.randomUUID();
    try {
      const result = await withTimeout(
        this.redis.eval(
          BEFORE_REQUEST_SCRIPT,
          2,
          stateKey,
          probeKey,
          String(Date.now()),
          probeToken,
          String(openSeconds * 1000)
        ) as Promise<[number, number, number]>,
        this.operationTimeoutMs
      );
      return Number(result[0]) === 1
        ? { allowed: true, probe: Number(result[2]) === 1, backend: 'redis' }
        : {
            allowed: false,
            retryAfterSeconds: Math.max(1, Number(result[1]) || 1),
            probe: false,
            backend: 'redis'
          };
    } catch {
      // Redis is transport infrastructure, not the source of truth. Fail open so
      // a Redis outage cannot permanently block durable PostgreSQL deliveries.
      return { allowed: true, probe: false, backend: 'degraded' };
    }
  }

  async recordSuccess(destinationId: string): Promise<void> {
    try {
      await withTimeout(
        this.redis.del(this.stateKey(destinationId), this.probeKey(destinationId)),
        this.operationTimeoutMs
      );
    } catch {
      // Best effort; delivery success remains authoritative in PostgreSQL.
    }
  }

  async recordFailure(destinationId: string, threshold: number, openSeconds: number): Promise<void> {
    try {
      await withTimeout(
        this.redis.eval(
          RECORD_FAILURE_SCRIPT,
          2,
          this.stateKey(destinationId),
          this.probeKey(destinationId),
          String(threshold),
          String(Date.now()),
          String(openSeconds * 1000)
        ) as Promise<number>,
        this.operationTimeoutMs
      );
    } catch {
      // Best effort; PostgreSQL retry state still protects delivery correctness.
    }
  }

  private stateKey(destinationId: string): string {
    return `${this.prefix}:state:${stableKey(destinationId)}`;
  }

  private probeKey(destinationId: string): string {
    return `${this.prefix}:probe:${stableKey(destinationId)}`;
  }
}

function stableKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Redis operation timeout')), timeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
