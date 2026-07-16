import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('environment validation static guards', () => {
  it('rejects malformed integer and boolean env values', () => {
    const env = read('src/part/env.ts');
    expect(env).toContain('Invalid non-negative integer env');
    expect(env).toContain('Number.isInteger(n)');
    expect(env).toContain('Invalid boolean env');
    expect(env).toContain("['0', 'false', 'no', 'off']");
  });

  it('does not evaluate legacy recovery interval when RECOVERY_INTERVAL_MS is present', () => {
    const env = read('src/part/env.ts');
    expect(env).toContain('function legacyRecoveryIntervalMs()');
    expect(env).toContain('process.env.RECOVERY_INTERVAL_MS');
    expect(env).toContain("RECOVERY_INTERVAL_MS: legacyRecoveryIntervalMs()");
  });
});
