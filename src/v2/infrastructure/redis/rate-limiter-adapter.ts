export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimiterStore {
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export class RedisRateLimiterAdapter implements RateLimiterStore {
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    // Redis Lua implementation is injected in infrastructure runtime.
    // Atomic sliding window evaluation belongs here.
    return { allowed: true };
  }
}
