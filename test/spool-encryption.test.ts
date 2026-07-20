import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/part/env.js';
import { readSpoolFile, writeSpoolFile } from '../src/feature/spool.js';

const payload = {
  receivedAt: '2026-07-21T00:00:00.000Z',
  source: { id: 'source-1' },
  headers: { authorization: 'Bearer secret', 'x-safe': 'ok' },
  body: '{"sensitive":"must-not-be-plaintext"}',
  verified: { ok: true, providerEventId: 'evt-1', eventType: 'demo' },
  cloudEvent: { data: { sensitive: 'must-not-be-plaintext' } }
};

beforeEach(async () => {
  await fs.rm(env.SPOOL_DIR, { recursive: true, force: true });
  await fs.mkdir(env.SPOOL_DIR, { recursive: true });
});

describe('encrypted emergency spool', () => {
  it('encrypts payload bytes and restores the exact recovery data', async () => {
    const file = await writeSpoolFile(payload);
    expect(file.endsWith('.spool')).toBe(true);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('must-not-be-plaintext');
    expect(raw).not.toContain('Bearer secret');

    const restored = await readSpoolFile(file);
    expect(restored.body).toBe(payload.body);
    expect(restored.cloudEvent).toEqual(payload.cloudEvent);
    expect(restored.headers).toEqual({ authorization: '[REDACTED]', 'x-safe': 'ok' });
  });

  it('rejects a modified encrypted envelope before decryption', async () => {
    const file = await writeSpoolFile(payload);
    const envelope = JSON.parse(await fs.readFile(file, 'utf8')) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await fs.writeFile(file, JSON.stringify(envelope));
    await expect(readSpoolFile(file)).rejects.toThrow('SPOOL_HMAC_INVALID');
  });
});
