import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`async function ${functionName}`);
  expect(start).toBeGreaterThan(-1);
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  return nextFunction === -1 ? source.slice(start) : source.slice(start, nextFunction);
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

  it('worker only delivers queued, retrying, or unknown rows', () => {
    const worker = read('src/system/worker-system.ts');
    expect(worker).toContain("const deliverableStatuses = new Set(['queued', 'retrying', 'unknown'])");
    expect(worker).toContain('delivery_skipped_status');
  });

  it('worker claims deliveries atomically before dispatch', () => {
    const worker = read('src/system/worker-system.ts');
    const processDelivery = functionBody(worker, 'processDelivery');
    expect(processDelivery).toContain("WHERE id=$1 AND status IN ('queued','retrying','unknown')");
    expect(processDelivery).toContain('RETURNING attempt_count');
    expect(processDelivery).toContain('delivery_claim_skipped');
  });

  it('worker purges expired raw event bodies during recovery', () => {
    const worker = read('src/system/worker-system.ts');
    const db = read('src/feature/db.ts');
    const recovery = functionBody(worker, 'recoverySweep');
    expect(worker).toContain('purgeExpiredEventBodies');
    expect(recovery).toContain('raw_body_retention_purged');
    expect(db).toContain('body_text=NULL');
    expect(db).toContain('BODY_RETENTION_DAYS must be >= 0');
  });

  it('worker resets stale delivering rows before selecting due deliveries inside recoverySweep', () => {
    const worker = read('src/system/worker-system.ts');
    const recovery = functionBody(worker, 'recoverySweep');
    const staleReset = recovery.indexOf("status='delivering'");
    const spoolImport = recovery.indexOf('importSpoolBatch');
    const dueSelect = recovery.indexOf("status IN ('queued','retrying','unknown')");
    expect(staleReset).toBeGreaterThan(-1);
    expect(spoolImport).toBeGreaterThan(-1);
    expect(dueSelect).toBeGreaterThan(-1);
    expect(staleReset).toBeLessThan(spoolImport);
    expect(spoolImport).toBeLessThan(dueSelect);
  });

  it('ci keeps the GitHub-side validation loop active', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('npm test');
    expect(ci).toContain('npm audit --audit-level=high');
  });
});
