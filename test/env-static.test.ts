import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('environment validation static guards', () => {
  it('uses one schema to reject malformed integer and boolean values', () => {
    const source = read('src/part/env.ts');
    expect(source).toContain("import { z } from 'zod'");
    expect(source).toContain('environmentSchema.safeParse');
    expect(source).toContain('Invalid environment configuration');
    expect(source).toContain("['0', 'false', 'no', 'off']");
    expect(source).toContain('z.number().int().nonnegative()');
  });

  it('preserves the legacy recovery interval alias without eagerly parsing both values', () => {
    const source = read('src/part/env.ts');
    expect(source).toContain('process.env.RECOVERY_INTERVAL_MS ?? process.env.RECOVERY_SWEEP_INTERVAL_MS');
    expect(source).toContain('RECOVERY_INTERVAL_MS: positiveInt(30_000)');
  });

  it('validates delivery leases, outbox publishing, and encrypted spool settings', () => {
    const source = read('src/part/env.ts');
    for (const name of [
      'DELIVERY_LEASE_SECONDS',
      'OUTBOX_PUBLISH_INTERVAL_MS',
      'OUTBOX_BATCH_SIZE',
      'OUTBOX_LEASE_SECONDS',
      'SPOOL_ENCRYPTION_KEY',
      'SPOOL_HMAC_KEY'
    ]) {
      expect(source).toContain(name);
    }
  });
});
