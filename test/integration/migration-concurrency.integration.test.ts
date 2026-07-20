import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, migrate, pool } from '../../src/feature/db.js';

afterAll(async () => {
  await closeDb();
});

describe('concurrent startup migration', () => {
  it('serializes API and worker migration attempts against an empty schema', async () => {
    await pool.query(`
      DROP TABLE IF EXISTS delivery_outbox CASCADE;
      DROP TABLE IF EXISTS deliveries CASCADE;
      DROP TABLE IF EXISTS events CASCADE;
      DROP TABLE IF EXISTS audit_logs CASCADE;
      DROP TABLE IF EXISTS replay_locks CASCADE;
    `);

    await expect(Promise.all(
      Array.from({ length: 12 }, () => migrate())
    )).resolves.toHaveLength(12);

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('events','deliveries','delivery_outbox','audit_logs','replay_locks')
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'audit_logs',
      'deliveries',
      'delivery_outbox',
      'events',
      'replay_locks'
    ]);

    const leaseColumns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='deliveries'
        AND column_name IN ('lock_token','lock_expires_at')
      ORDER BY column_name
    `);
    expect(leaseColumns.rows.map((row) => row.column_name)).toEqual([
      'lock_expires_at',
      'lock_token'
    ]);
  });
});
