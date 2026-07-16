import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../part/env.js';
import { sanitizeObject } from '../part/sanitize.js';

export interface SpoolPayload {
  receivedAt: string;
  source: unknown;
  headers: unknown;
  body: string;
  verified: unknown;
  cloudEvent: unknown;
}

export type SpoolImportResult = 'success' | 'duplicate' | 'corrupted' | 'db_error';

export async function ensureSpoolDirs(): Promise<void> {
  await fs.mkdir(env.SPOOL_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(env.SPOOL_DIR, 'failed'), { recursive: true, mode: 0o700 });
}

export async function writeSpoolFile(payload: SpoolPayload): Promise<string> {
  if (!env.ENABLE_EMERGENCY_SPOOL) throw new Error('Emergency spool disabled');
  await ensureSpoolDirs();
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const tmp = path.join(env.SPOOL_DIR, `${id}.json.tmp`);
  const final = path.join(env.SPOOL_DIR, `${id}.json`);
  await fs.writeFile(tmp, JSON.stringify(serializeSpoolPayload(payload), null, 2), { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, final);
  return final;
}

export function serializeSpoolPayload(payload: SpoolPayload): SpoolPayload {
  // Spool is a recovery ledger, not an operational log. Do not sanitize body,
  // verified metadata, or CloudEvent data because doing so can corrupt replay.
  // Only headers are sanitized because they are not required for import and may
  // carry Authorization/Cookie material from providers or proxies.
  return {
    ...payload,
    headers: sanitizeObject(payload.headers)
  };
}

export async function listSpoolFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(env.SPOOL_DIR);
    return entries.filter((name) => name.endsWith('.json')).map((name) => path.join(env.SPOOL_DIR, name));
  } catch {
    return [];
  }
}

export async function countSpoolFiles(): Promise<{ pending: number; failed: number }> {
  const pending = (await listSpoolFiles()).length;
  let failed = 0;
  try {
    failed = (await fs.readdir(path.join(env.SPOOL_DIR, 'failed'))).filter((name) => name.endsWith('.json')).length;
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
    // If unlock fails, leave the file for manual inspection rather than deleting it.
  }
}

export async function readSpoolFile(filePath: string): Promise<SpoolPayload> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as SpoolPayload;
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
  const cutoff = Date.now() - env.SPOOL_FAILED_RETENTION_DAYS * 86400000;
  let purged = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(failedDir, entry);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full);
        purged += 1;
      }
    } catch {
      // best effort
    }
  }
  return purged;
}
