import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../part/env.js';
import { decodeSecret, hmacSha256, timingSafeEqual } from '../part/crypto.js';
import { sanitizeObject } from '../part/sanitize.js';

export interface SpoolPayload {
  receivedAt: string;
  source: Record<string, unknown>;
  headers: unknown;
  body: string;
  verified: unknown;
  cloudEvent: unknown;
}

export type SpoolImportResult = 'success' | 'duplicate' | 'corrupted' | 'db_error';

interface EncryptedSpoolCore {
  version: 1;
  algorithm: 'aes-256-gcm+hmac-sha256';
  iv: string;
  tag: string;
  ciphertext: string;
}

interface EncryptedSpoolEnvelope extends EncryptedSpoolCore {
  hmac: string;
}

export async function ensureSpoolDirs(): Promise<void> {
  await fs.mkdir(env.SPOOL_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(env.SPOOL_DIR, 'failed'), { recursive: true, mode: 0o700 });
}

export async function writeSpoolFile(payload: SpoolPayload): Promise<string> {
  if (!env.ENABLE_EMERGENCY_SPOOL) throw new Error('Emergency spool disabled');
  await ensureSpoolDirs();
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const extension = env.SPOOL_STORAGE_MODE === 'encrypted_file' ? '.spool' : '.json';
  const tmp = path.join(env.SPOOL_DIR, `${id}${extension}.tmp`);
  const final = path.join(env.SPOOL_DIR, `${id}${extension}`);
  const serialized = Buffer.from(JSON.stringify(serializeSpoolPayload(payload)), 'utf8');
  const output = env.SPOOL_STORAGE_MODE === 'encrypted_file'
    ? JSON.stringify(encryptSpool(serialized))
    : serialized;
  await fs.writeFile(tmp, output, { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, final);
  return final;
}

export function serializeSpoolPayload(payload: SpoolPayload): SpoolPayload {
  return {
    ...payload,
    // The body, verification metadata, and CloudEvent are recovery data and
    // must remain exact. Headers are not needed for import and may contain secrets.
    headers: sanitizeObject(payload.headers)
  };
}

export async function listSpoolFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(env.SPOOL_DIR);
    return entries
      .filter((name) => name.endsWith('.json') || name.endsWith('.spool'))
      .sort()
      .map((name) => path.join(env.SPOOL_DIR, name));
  } catch {
    return [];
  }
}

export async function countSpoolFiles(): Promise<{ pending: number; failed: number }> {
  const pending = (await listSpoolFiles()).length;
  let failed = 0;
  try {
    failed = (await fs.readdir(path.join(env.SPOOL_DIR, 'failed')))
      .filter((name) => name.endsWith('.json') || name.endsWith('.spool'))
      .length;
  } catch {
    failed = 0;
  }
  return { pending, failed };
}

export async function lockSpoolFile(filePath: string): Promise<string | null> {
  const locked = `${filePath}.importing`;
  try {
    await fs.rename(filePath, locked);
    return locked;
  } catch {
    return null;
  }
}

export async function unlockSpoolFile(lockedPath: string): Promise<void> {
  const original = lockedPath.replace(/\.importing$/, '');
  try {
    await fs.rename(lockedPath, original);
  } catch {
    // Leave the file for manual inspection rather than deleting recovery data.
  }
}

export async function readSpoolFile(filePath: string): Promise<SpoolPayload> {
  const raw = await fs.readFile(filePath);
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  if (isEncryptedEnvelope(parsed)) {
    const plaintext = decryptSpool(parsed);
    return JSON.parse(plaintext.toString('utf8')) as SpoolPayload;
  }
  return parsed as SpoolPayload;
}

export async function removeSpoolFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

export async function moveSpoolFileToFailed(filePath: string): Promise<string> {
  await ensureSpoolDirs();
  const base = path.basename(filePath).replace(/\.importing$/, '');
  const failed = path.join(env.SPOOL_DIR, 'failed', base);
  await fs.rename(filePath, failed);
  return failed;
}

export async function purgeFailedSpoolFiles(): Promise<number> {
  const failedDir = path.join(env.SPOOL_DIR, 'failed');
  let entries: string[];
  try {
    entries = await fs.readdir(failedDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - env.SPOOL_FAILED_RETENTION_DAYS * 86_400_000;
  let purged = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json') && !entry.endsWith('.spool')) continue;
    const full = path.join(failedDir, entry);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full);
        purged += 1;
      }
    } catch {
      // Best effort retention cleanup.
    }
  }
  return purged;
}

function encryptSpool(plaintext: Buffer): EncryptedSpoolEnvelope {
  const encryptionKey = decodeSecret(env.SPOOL_ENCRYPTION_KEY);
  const hmacKey = decodeSecret(env.SPOOL_HMAC_KEY);
  if (encryptionKey.length !== 32) throw new Error('SPOOL_ENCRYPTION_KEY must decode to 32 bytes');
  if (hmacKey.length < 32) throw new Error('SPOOL_HMAC_KEY must decode to at least 32 bytes');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const core: EncryptedSpoolCore = {
    version: 1,
    algorithm: 'aes-256-gcm+hmac-sha256',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
  return {
    ...core,
    hmac: hmacSha256(hmacKey, canonicalEnvelope(core)).toString('base64')
  };
}

function decryptSpool(envelope: EncryptedSpoolEnvelope): Buffer {
  const encryptionKey = decodeSecret(env.SPOOL_ENCRYPTION_KEY);
  const hmacKey = decodeSecret(env.SPOOL_HMAC_KEY);
  if (encryptionKey.length !== 32) throw new Error('SPOOL_ENCRYPTION_KEY must decode to 32 bytes');
  if (hmacKey.length < 32) throw new Error('SPOOL_HMAC_KEY must decode to at least 32 bytes');

  const core: EncryptedSpoolCore = {
    version: envelope.version,
    algorithm: envelope.algorithm,
    iv: envelope.iv,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext
  };
  const expected = hmacSha256(hmacKey, canonicalEnvelope(core));
  const supplied = Buffer.from(envelope.hmac, 'base64');
  if (!timingSafeEqual(expected, supplied)) throw new Error('SPOOL_HMAC_INVALID');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]);
}

function canonicalEnvelope(core: EncryptedSpoolCore): string {
  return `${core.version}\n${core.algorithm}\n${core.iv}\n${core.tag}\n${core.ciphertext}`;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedSpoolEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && candidate.algorithm === 'aes-256-gcm+hmac-sha256'
    && typeof candidate.iv === 'string'
    && typeof candidate.tag === 'string'
    && typeof candidate.ciphertext === 'string'
    && typeof candidate.hmac === 'string';
}
