import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  backend: 'redis' | 'memory';
}

interface MemoryWindow {
  count: number;
  expiresAt: number;
}

const REDIS_SCRIPT = `
local providerCount = redis.call('INCR', KEYS[1])
if providerCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
local ipCount = redis.call('INCR', KEYS[2])
if ipCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
local providerTtl = redis.call('TTL', KEYS[1])
local ipTtl = redis.call('TTL', KEYS[2])
local allowed = 1
if providerCount > tonumber(ARGV[1]) or ipCount > tonumber(ARGV[2]) then allowed = 0 end
return {allowed, math.max(providerTtl, ipTtl)}
`;

export class CompositeRateLimiter {
  private readonly memory = new Map<string, MemoryWindow>();

  constructor(
    private readonly redis: Redis,
    private readonly providerLimit: number,
    private readonly ipLimit: number,
    private readonly windowSeconds = 60,
    private readonly operationTimeoutMs = 500,
    private readonly prefix = 'webhook:rate',
    private readonly maxMemoryEntries = 10_000
  ) {
    if (!Number.isInteger(maxMemoryEntries) || maxMemoryEntries < 2) {
      throw new Error('maxMemoryEntries must be an integer >= 2');
    }
  }

  async check(provider: string, ip: string): Promise<RateLimitDecision> {
    const providerKey = `${this.prefix}:provider:${stableKey(provider)}`;
    const ipKey = `${this.prefix}:ip:${stableKey(ip)}`;

    try {
      const result = await withTimeout(
        this.redis.eval(
          REDIS_SCRIPT,
          2,
          providerKey,
          ipKey,
          String(this.providerLimit),
          String(this.ipLimit),
          String(this.windowSeconds)
        ) as Promise<[number, number]>,
        this.operationTimeoutMs
      );
      const allowed = Number(result[0]) === 1;
      const retryAfterSeconds = Math.max(1, Number(result[1]) || this.windowSeconds);
      return allowed
        ? { allowed: true, backend: 'redis' }
        : { allowed: false, retryAfterSeconds, backend: 'redis' };
    } catch {
      return this.checkMemory(providerKey, ipKey);
    }
  }

  private checkMemory(providerKey: string, ipKey: string): RateLimitDecision {
    const now = Date.now();
    const provider = this.incrementMemory(providerKey, now);
    const ip = this.incrementMemory(ipKey, now);
    const allowed = provider.count <= this.providerLimit && ip.count <= this.ipLimit;
    if (allowed) return { allowed: true, backend: 'memory' };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((Math.max(provider.expiresAt, ip.expiresAt) - now) / 1000)
      ),
      backend: 'memory'
    };
  }

  private incrementMemory(key: string, now: number): MemoryWindow {
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      // Refresh insertion order so active keys are evicted after colder keys.
      this.memory.delete(key);
      this.memory.set(key, existing);
      return existing;
    }

    this.ensureMemoryCapacity(now);
    const fresh = { count: 1, expiresAt: now + this.windowSeconds * 1000 };
    this.memory.set(key, fresh);
    return fresh;
  }

  private ensureMemoryCapacity(now: number): void {
    for (const [key, window] of this.memory) {
      if (window.expiresAt <= now) this.memory.delete(key);
    }
    while (this.memory.size >= this.maxMemoryEntries) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
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
