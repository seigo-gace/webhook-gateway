import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('config validation static guards', () => {
  it('rejects production placeholder secrets and URLs', () => {
    const config = read('src/feature/config.ts');
    expect(config).toContain('validateProductionValue');
    expect(config).toContain('replace_with');
    expect(config).toContain('example\\.com');
    expect(config).toContain('example-app');
    expect(config).toContain('webhook_password');
  });

  it('validates cross references and duplicate IDs at startup', () => {
    const config = read('src/feature/config.ts');
    expect(config).toContain("addUnique(sourceIds, source.id, 'source id')");
    expect(config).toContain("addUnique(destinationIds, destination.id, 'destination id')");
    expect(config).toContain('references missing source');
    expect(config).toContain('references missing destination');
  });

  it('keeps unsafe development providers out of production', () => {
    const config = read('src/feature/config.ts');
    expect(config).toContain('provider=none is forbidden in production');
    expect(config).toContain('SPOOL_STORAGE_MODE=plain_dev is forbidden in production');
  });
});
