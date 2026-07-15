import type { IncomingHttpHeaders } from 'node:http';

export function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseJsonSafe(raw: Buffer): unknown | undefined {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}
