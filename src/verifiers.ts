import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { decodeSecret, hmacSha256, timingSafeEqual } from './crypto.js';
import { getHeader, parseJsonSafe } from './http.js';
import { env, requireEnv } from './env.js';
import type { Provider, VerificationResult } from './types.js';

interface SourceRow {
  id: string;
  provider: Provider;
  secretEnv?: string;
  secret_env?: string;
  toleranceSeconds?: number;
  tolerance_seconds?: number;
  generic?: any;
}

export function verifyInbound(req: Request, source: SourceRow, raw: Buffer): VerificationResult {
  const provider = source.provider;
  const tolerance = Number(source.toleranceSeconds ?? source.tolerance_seconds ?? env.DEFAULT_TOLERANCE_SECONDS);
  const secretEnv = source.secretEnv ?? source.secret_env;
  const secret = secretEnv ? requireEnv(secretEnv) : '';

  switch (provider) {
    case 'standard': return verifyStandard(req, raw, secret, tolerance);
    case 'github': return verifyGitHub(req, raw, secret);
    case 'stripe': return verifyStripe(req, raw, secret, tolerance);
    case 'slack': return verifySlack(req, raw, secret, tolerance);
    case 'telegram': return verifyTelegram(req, raw, secret);
    case 'generic-hmac-sha256': return verifyGeneric(req, raw, secret, tolerance, source.generic);
    case 'none': return verifyNone(raw);
    default: return { ok: false, reason: `Unsupported provider: ${provider}`, statusCode: 400 };
  }
}

function verifyStandard(req: Request, raw: Buffer, secretValue: string, toleranceSeconds: number): VerificationResult {
  const id = getHeader(req.headers, 'webhook-id');
  const timestamp = getHeader(req.headers, 'webhook-timestamp');
  const signature = getHeader(req.headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'Missing Standard Webhooks headers', statusCode: 401 };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'Invalid webhook-timestamp', statusCode: 401 };
  if (!timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Webhook timestamp outside tolerance', statusCode: 401 };

  const secret = decodeSecret(secretValue);
  const signed = `${id}.${timestamp}.${raw.toString('utf8')}`;
  const expected = hmacSha256(secret, signed);
  const signatures = signature.split(' ').flatMap((part) => part.split(',')[0] === 'v1' ? [part.split(',')[1]] : []);
  const ok = signatures.some((sig) => {
    if (!sig) return false;
    try { return timingSafeEqual(Buffer.from(sig, 'base64'), expected); } catch { return false; }
  });
  if (!ok) return { ok: false, reason: 'Invalid Standard Webhooks signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw);
  const eventType = getEventTypeFromJson(parsed) ?? getHeader(req.headers, 'webhook-event') ?? 'standard.event';
  return { ok: true, providerEventId: id, eventType, timestamp: ts, parsedJson: parsed };
}

function verifyGitHub(req: Request, raw: Buffer, secretValue: string): VerificationResult {
  const signature = getHeader(req.headers, 'x-hub-signature-256');
  const deliveryId = getHeader(req.headers, 'x-github-delivery');
  const eventType = getHeader(req.headers, 'x-github-event') ?? 'github.event';
  if (!signature || !signature.startsWith('sha256=')) return { ok: false, reason: 'Missing or invalid GitHub signature header', statusCode: 401 };
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = hmacSha256(decodeSecret(secretValue), raw);
  if (!timingSafeEqual(received, expected)) return { ok: false, reason: 'Invalid GitHub signature', statusCode: 401 };
  return { ok: true, providerEventId: deliveryId ?? randomUUID(), eventType, parsedJson: parseJsonSafe(raw) };
}

function verifyStripe(req: Request, raw: Buffer, secretValue: string, toleranceSeconds: number): VerificationResult {
  const header = getHeader(req.headers, 'stripe-signature');
  if (!header) return { ok: false, reason: 'Missing Stripe-Signature header', statusCode: 401 };
  const parts = new Map<string, string[]>();
  for (const token of header.split(',')) {
    const [k, v] = token.split('=', 2);
    if (!k || !v) continue;
    const arr = parts.get(k) ?? [];
    arr.push(v);
    parts.set(k, arr);
  }
  const tsRaw = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!tsRaw || signatures.length === 0) return { ok: false, reason: 'Invalid Stripe-Signature format', statusCode: 401 };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Stripe timestamp outside tolerance', statusCode: 401 };
  const expected = hmacSha256(decodeSecret(secretValue), `${tsRaw}.${raw.toString('utf8')}`);
  const ok = signatures.some((sig) => timingSafeEqual(Buffer.from(sig, 'hex'), expected));
  if (!ok) return { ok: false, reason: 'Invalid Stripe signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  return { ok: true, providerEventId: parsed?.id ?? randomUUID(), eventType: parsed?.type ?? 'stripe.event', timestamp: ts, parsedJson: parsed };
}

function verifySlack(req: Request, raw: Buffer, secretValue: string, toleranceSeconds: number): VerificationResult {
  const signature = getHeader(req.headers, 'x-slack-signature');
  const tsRaw = getHeader(req.headers, 'x-slack-request-timestamp');
  if (!signature || !signature.startsWith('v0=') || !tsRaw) return { ok: false, reason: 'Missing Slack signature headers', statusCode: 401 };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Slack timestamp outside tolerance', statusCode: 401 };
  const base = `v0:${tsRaw}:${raw.toString('utf8')}`;
  const expectedHex = hmacSha256(decodeSecret(secretValue), base).toString('hex');
  const expected = Buffer.from(`v0=${expectedHex}`);
  const received = Buffer.from(signature);
  if (!timingSafeEqual(received, expected)) return { ok: false, reason: 'Invalid Slack signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  return { ok: true, providerEventId: parsed?.event_id ?? randomUUID(), eventType: parsed?.type ?? parsed?.event?.type ?? 'slack.event', timestamp: ts, parsedJson: parsed };
}

function verifyTelegram(req: Request, raw: Buffer, secretValue: string): VerificationResult {
  const token = getHeader(req.headers, 'x-telegram-bot-api-secret-token');
  if (!token) return { ok: false, reason: 'Missing Telegram secret token header', statusCode: 401 };
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(secretValue))) return { ok: false, reason: 'Invalid Telegram secret token', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  const updateId = parsed?.update_id != null ? String(parsed.update_id) : randomUUID();
  const eventType = Object.keys(parsed ?? {}).find((k) => k !== 'update_id') ?? 'telegram.update';
  return { ok: true, providerEventId: updateId, eventType: `telegram.${eventType}`, parsedJson: parsed };
}

function verifyGeneric(req: Request, raw: Buffer, secretValue: string, toleranceSeconds: number, generic: any): VerificationResult {
  if (!generic) return { ok: false, reason: 'Missing generic verifier config', statusCode: 500 };
  const sigHeader = getHeader(req.headers, generic.signatureHeader);
  if (!sigHeader) return { ok: false, reason: 'Missing generic signature header', statusCode: 401 };
  const timestampRaw = generic.timestampHeader ? getHeader(req.headers, generic.timestampHeader) : undefined;
  if (generic.signedContent === 'timestamp.body') {
    if (!timestampRaw) return { ok: false, reason: 'Missing generic timestamp header', statusCode: 401 };
    const ts = Number(timestampRaw);
    if (!Number.isFinite(ts) || !timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Generic timestamp outside tolerance', statusCode: 401 };
  }
  const content = generic.signedContent === 'timestamp.body'
    ? `${timestampRaw}.${raw.toString('utf8')}`
    : raw;
  const expected = hmacSha256(decodeSecret(secretValue), content);
  const cleaned = generic.signaturePrefix && sigHeader.startsWith(generic.signaturePrefix)
    ? sigHeader.slice(generic.signaturePrefix.length)
    : sigHeader;
  const received = Buffer.from(cleaned, generic.signatureEncoding);
  if (!timingSafeEqual(received, expected)) return { ok: false, reason: 'Invalid generic HMAC signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  const eventId = generic.idHeader ? getHeader(req.headers, generic.idHeader) : undefined;
  const eventType = generic.eventTypeHeader ? getHeader(req.headers, generic.eventTypeHeader) : undefined;
  return { ok: true, providerEventId: eventId ?? parsed?.id ?? randomUUID(), eventType: eventType ?? parsed?.type ?? 'generic.event', parsedJson: parsed };
}

function verifyNone(raw: Buffer): VerificationResult {
  const parsed = parseJsonSafe(raw) as any;
  return { ok: true, providerEventId: parsed?.id ?? randomUUID(), eventType: parsed?.type ?? 'unsafe.none', parsedJson: parsed };
}

function timestampWithinTolerance(tsSeconds: number, toleranceSeconds: number): boolean {
  if (toleranceSeconds === 0) return true;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - tsSeconds) <= toleranceSeconds;
}

function getEventTypeFromJson(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = (parsed as any).type ?? (parsed as any).event_type ?? (parsed as any).event;
  return typeof value === 'string' ? value : undefined;
}
