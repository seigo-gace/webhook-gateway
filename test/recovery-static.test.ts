import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('production recovery static guards', () => {
  it('worker recovery imports emergency spool files instead of only counting them', () => {
    const worker = read('src/system/worker-system.ts');
    for (const required of [
      'listSpoolFiles',
      'lockSpoolFile',
      'readSpoolFile',
      'removeSpoolFile',
      'moveSpoolFileToFailed',
      'unlockSpoolFile',
      'insertEvent',
      'createDeliveries',
      'getMatchingRoutes',
      'spool_import_success',
      'spool_import_duplicate',
      'spool_import_corrupted',
      'spool_import_db_error'
    ]) {
      expect(worker).toContain(required);
    }
  });

  it('worker resets stale delivering rows before selecting due deliveries', () => {
    const worker = read('src/system/worker-system.ts');
    const staleReset = worker.indexOf("status='delivering'");
    const dueSelect = worker.indexOf("status IN ('queued','retrying','unknown')");
    expect(staleReset).toBeGreaterThan(-1);
    expect(dueSelect).toBeGreaterThan(-1);
    expect(staleReset).toBeLessThan(dueSelect);
  });

  it('ci keeps the GitHub-side validation loop active', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('npm test');
    expect(ci).toContain('npm audit --audit-level=high');
  });
});
