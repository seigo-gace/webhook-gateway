import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './env.js';

export async function writeSpoolFile(payload: unknown): Promise<string> {
  if (!env.ENABLE_EMERGENCY_SPOOL) throw new Error('Emergency spool disabled');
  await fs.mkdir(env.SPOOL_DIR, { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const tmp = path.join(env.SPOOL_DIR, `${id}.json.tmp`);
  const final = path.join(env.SPOOL_DIR, `${id}.json`);
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, final);
  return final;
}
