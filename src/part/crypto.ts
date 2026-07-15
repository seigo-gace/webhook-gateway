import crypto from 'node:crypto';

export function decodeSecret(value: string): Buffer {
  if (value.startsWith('base64:')) return Buffer.from(value.slice('base64:'.length), 'base64');
  return Buffer.from(value, 'utf8');
}

export function hmacSha256(secret: Buffer | string, content: Buffer | string): Buffer {
  return crypto.createHmac('sha256', secret).update(content).digest();
}

export function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function sha256Hex(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function randomId(): string {
  return crypto.randomUUID();
}
