export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  check(key: string): RateLimitResult {
    if (this.limit <= 0) return { allowed: true };
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      this.cleanup(now);
      return { allowed: true };
    }
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    current.count += 1;
    return { allowed: true };
  }

  private cleanup(now: number): void {
    if (this.buckets.size < 10000) return;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
