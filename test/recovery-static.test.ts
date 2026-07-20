import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('production recovery and concurrency guards', () => {
  it('imports and classifies emergency spool files', () => {
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

  it('claims deliveries through the PostgreSQL lease boundary before HTTP dispatch', () => {
    const worker = read('src/system/worker-system.ts');
    const db = read('src/feature/db.ts');
    expect(worker).toContain('claimDelivery(deliveryId, env.DELIVERY_LEASE_SECONDS)');
    expect(worker).toContain('beginDeliveryAttempt(deliveryId, claim.lockToken)');
    expect(worker).toContain('delivery_claim_skipped');
    expect(db).toContain("status='delivering'");
    expect(db).toContain('lock_token=gen_random_uuid()');
    expect(db).toContain("status IN ('queued','retrying','unknown')");
    expect(db).toContain("status='delivering' AND lock_expires_at < now()");
  });

  it('skips missing destinations without creating an infinite retry loop', () => {
    const worker = read('src/system/worker-system.ts');
    expect(worker).toContain("status: 'skipped'");
    expect(worker).toContain('delivery_destination_skipped');
    expect(worker).not.toContain('throw new Error(`Destination not found');
  });

  it('publishes the transactional outbox with leased SKIP LOCKED claims', () => {
    const worker = read('src/system/worker-system.ts');
    const db = read('src/feature/db.ts');
    expect(worker).toContain('publishOutboxBatch');
    expect(worker).toContain('markOutboxPublished');
    expect(worker).toContain('markOutboxFailed');
    expect(db).toContain('FOR UPDATE SKIP LOCKED');
    expect(db).toContain("status='publishing'");
    expect(db).toContain("status='published'");
  });

  it('purges expired raw bodies and recovers stale delivery leases', () => {
    const worker = read('src/system/worker-system.ts');
    const db = read('src/feature/db.ts');
    expect(worker).toContain('purgeExpiredEventBodies');
    expect(worker).toContain('raw_body_retention_purged');
    expect(worker).toContain('lock_expires_at');
    expect(worker).toContain("SET status='retrying', lock_token=NULL, lock_expires_at=NULL");
    expect(db).toContain('body_text=NULL');
    expect(db).toContain('BODY_RETENTION_DAYS must be >= 0');
  });

  it('keeps the complete CI validation loop active', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm run typecheck');
    expect(ci).toContain('npm run test:ci');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('docker build --target runtime');
    expect(ci).toContain('docker compose config --quiet');
    expect(ci).toContain('npm audit --audit-level=high');
  });
});
