import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { CompositeRateLimiter } from '../src/feature/composite-rate-limit.js';

function redisWithEval(result: unknown): Redis {
  return { eval: vi.fn().mockResolvedValue(result) } as unknown as Redis;
}

function failingRedis(): Redis {
  return { eval: vi.fn().mockRejectedValue(new Error('redis down')) } as unknown as Redis;
}

describe('CompositeRateLimiter', () => {
  it('uses the atomic Redis result when Redis is available', async () => {
    const limiter = new CompositeRateLimiter(redisWithEval([1, 60]), 10, 5, 60, 100);
    await expect(limiter.check('github', '203.0.113.10')).resolves.toEqual({
      allowed: true,
      backend: 'redis'
    });
  });

  it('falls back to a bounded in-memory window when Redis fails', async () => {
    const limiter = new CompositeRateLimiter(failingRedis(), 2, 2, 60, 10);
    expect(await limiter.check('github', '203.0.113.10')).toMatchObject({ allowed: true, backend: 'memory' });
    expect(await limiter.check('github', '203.0.113.10')).toMatchObject({ allowed: true, backend: 'memory' });
    const blocked = await limiter.check('github', '203.0.113.10');
    expect(blocked.allowed).toBe(false);
    expect(blocked.backend).toBe('memory');
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('evicts cold keys instead of growing without bound during a Redis outage', async () => {
    const limiter = new CompositeRateLimiter(
      failingRedis(),
      100,
      100,
      60,
      10,
      'test-rate',
      4
    );

    for (let index = 0; index < 20; index += 1) {
      await limiter.check(`provider-${index}`, `198.51.100.${index}`);
    }

    const memory = (limiter as unknown as { memory: Map<string, unknown> }).memory;
    expect(memory.size).toBeLessThanOrEqual(4);
  });

  it('rejects an invalid fallback capacity', () => {
    expect(() => new CompositeRateLimiter(failingRedis(), 10, 10, 60, 10, 'test', 1))
      .toThrow(/maxMemoryEntries/);
  });
});
