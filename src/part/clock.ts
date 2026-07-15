import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from './env.js';

const execFileAsync = promisify(execFile);
let cachedUntil = 0;
let cached: ClockSkewResult | undefined;

export interface ClockSkewResult {
  ok: boolean;
  required: boolean;
  skewSeconds: number | null;
  error?: string;
}

export async function checkClockSkew(): Promise<ClockSkewResult> {
  if (!env.ENABLE_CLOCK_SKEW_CHECK) return { ok: true, required: false, skewSeconds: null };
  const now = Date.now();
  if (cached && cachedUntil > now) return cached;
  cached = await measureClockSkew();
  cachedUntil = now + env.CLOCK_SKEW_CACHE_SECONDS * 1000;
  return cached;
}

async function measureClockSkew(): Promise<ClockSkewResult> {
  try {
    if (env.CLOCK_SKEW_CHECK_MODE !== 'chronyc') {
      return { ok: !env.CLOCK_SKEW_REQUIRED, required: env.CLOCK_SKEW_REQUIRED, skewSeconds: null, error: 'unsupported clock skew check mode' };
    }
    const { stdout } = await execFileAsync('chronyc', ['tracking'], { timeout: 1500 });
    const skew = parseChronycOffset(stdout);
    if (skew === null) throw new Error('could not parse chronyc offset');
    return { ok: Math.abs(skew) <= env.MAX_CLOCK_SKEW_SECONDS, required: env.CLOCK_SKEW_REQUIRED, skewSeconds: skew };
  } catch (err: any) {
    return { ok: !env.CLOCK_SKEW_REQUIRED, required: env.CLOCK_SKEW_REQUIRED, skewSeconds: null, error: String(err.message ?? err) };
  }
}

export function parseChronycOffset(output: string): number | null {
  const last = output.match(/Last offset\s*:\s*([+-]?[0-9.]+)\s+seconds/i);
  if (last) return Number(last[1]);
  const system = output.match(/System time\s*:\s*([+-]?[0-9.]+)\s+seconds/i);
  if (system) return Number(system[1]);
  return null;
}
