import type { Request } from 'express';
import { decodeSecret, hmacSha256, timingSafeEqual } from '../part/crypto.js';
import { getHeader, parseJsonSafe } from '../part/http.js';
import { env, optionalEnv, requireEnv } from '../part/env.js';
import { normalizeProviderEventId } from '../part/normalizer.js';
import type { SourceConfig, VerificationResult } from '../part/types.js';

export function verifyInbound(req: Request, source: SourceConfig, raw: Buffer): VerificationResult {
  const tolerance = source.toleranceSeconds ?? env.DEFAULT_TOLERANCE_SECONDS;
  const secrets = getSecrets(source);
  switch (source.provider) {
    case 'standard': return verifyStandard(req, raw, source, secrets, tolerance);
    case 'github': return verifyGitHub(req, raw, source, secrets);
    case 'stripe': return verifyStripe(req, raw, source, secrets, tolerance);
    case 'slack': return verifySlack(req, raw, source, secrets, tolerance);
    case 'telegram': return verifyTelegram(req, raw, source, secrets);
    case 'generic-hmac-sha256': return verifyGeneric(req, raw, source, secrets, tolerance);
    case 'none': return verifyNone(source, raw);
    default: return { ok: false, reason: `Unsupported provider: ${String(source.provider)}`, statusCode: 400 };
  }
}

function getSecrets(source: SourceConfig): string[] {
  if (source.provider === 'none') return [];
  const primary = source.secretEnv ? requireEnv(source.secretEnv) : '';
  const secondary = source.secondarySecretEnv ? optionalEnv(source.secondarySecretEnv) : undefined;
  return [primary, secondary].filter((v): v is string => Boolean(v));
}

function verifyStandard(req: Request, raw: Buffer, source: SourceConfig, secrets: string[], toleranceSeconds: number): VerificationResult {
  const id = getHeader(req.headers, 'webhook-id');
  const timestamp = getHeader(req.headers, 'webhook-timestamp');
  const signature = getHeader(req.headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'Missing Standard Webhooks headers', statusCode: 401 };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'Invalid webhook-timestamp', statusCode: 401 };
  if (!timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Webhook timestamp outside tolerance', statusCode: 401 };
  const signedContent = `${id}.${timestamp}.${raw.toString('utf8')}`;
  const signatures = parseStandardSignatures(signature);
  const ok = secrets.some((secretValue) => {
    const expected = hmacSha256(decodeSecret(secretValue), signedContent);
    return signatures.some((sig) => safeCompareEncoded(sig, 'base64', expected));
  });
  if (!ok) return { ok: false, reason: 'Invalid Standard Webhooks signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw);
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, id), eventType: getEventTypeFromJson(parsed) ?? getHeader(req.headers, 'webhook-event') ?? 'standard.event', timestamp: ts, parsedJson: parsed };
}

function verifyGitHub(req: Request, raw: Buffer, source: SourceConfig, secrets: string[]): VerificationResult {
  const signature = getHeader(req.headers, 'x-hub-signature-256');
  const deliveryId = getHeader(req.headers, 'x-github-delivery');
  const eventType = getHeader(req.headers, 'x-github-event') ?? 'github.event';
  if (!signature || !signature.startsWith('sha256=')) return { ok: false, reason: 'Missing or invalid GitHub signature header', statusCode: 401 };
  if (!deliveryId) return { ok: false, reason: 'Missing GitHub delivery id', statusCode: 400 };
  const receivedHex = signature.slice('sha256='.length);
  const ok = secrets.some((secretValue) => safeCompareEncoded(receivedHex, 'hex', hmacSha256(decodeSecret(secretValue), raw)));
  if (!ok) return { ok: false, reason: 'Invalid GitHub signature', statusCode: 401 };
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, deliveryId), eventType, parsedJson: parseJsonSafe(raw) };
}

function verifyStripe(req: Request, raw: Buffer, source: SourceConfig, secrets: string[], toleranceSeconds: number): VerificationResult {
  const header = getHeader(req.headers, 'stripe-signature');
  if (!header) return { ok: false, reason: 'Missing Stripe-Signature header', statusCode: 401 };
  const parts = new Map<string, string[]>();
  for (const token of header.split(',')) {
    const [k, v] = token.split('=', 2);
    if (!k || !v) continue;
    const values = parts.get(k) ?? [];
    values.push(v);
    parts.set(k, values);
  }
  const tsRaw = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!tsRaw || signatures.length === 0) return { ok: false, reason: 'Invalid Stripe-Signature format', statusCode: 401 };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Stripe timestamp outside tolerance', statusCode: 401 };
  const signedContent = `${tsRaw}.${raw.toString('utf8')}`;
  const ok = secrets.some((secretValue) => {
    const expected = hmacSha256(decodeSecret(secretValue), signedContent);
    return signatures.some((sig) => safeCompareEncoded(sig, 'hex', expected));
  });
  if (!ok) return { ok: false, reason: 'Invalid Stripe signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  if (!parsed?.id) return { ok: false, reason: 'Missing Stripe event id', statusCode: 400 };
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, parsed.id), eventType: parsed?.type ?? 'stripe.event', timestamp: ts, parsedJson: parsed };
}

function verifySlack(req: Request, raw: Buffer, source: SourceConfig, secrets: string[], toleranceSeconds: number): VerificationResult {
  const signature = getHeader(req.headers, 'x-slack-signature');
  const tsRaw = getHeader(req.headers, 'x-slack-request-timestamp');
  if (!signature || !signature.startsWith('v0=') || !tsRaw) return { ok: false, reason: 'Missing Slack signature headers', statusCode: 401 };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Slack timestamp outside tolerance', statusCode: 401 };
  const base = `v0:${tsRaw}:${raw.toString('utf8')}`;
  const ok = secrets.some((secretValue) => {
    const expected = Buffer.from(`v0=${hmacSha256(decodeSecret(secretValue), base).toString('hex')}`, 'utf8');
    return timingSafeEqual(Buffer.from(signature, 'utf8'), expected);
  });
  if (!ok) return { ok: false, reason: 'Invalid Slack signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  if (!parsed?.event_id) return { ok: false, reason: 'Missing Slack event id', statusCode: 400 };
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, parsed.event_id), eventType: parsed?.type ?? parsed?.event?.type ?? 'slack.event', timestamp: ts, parsedJson: parsed };
}

function verifyTelegram(req: Request, raw: Buffer, source: SourceConfig, secrets: string[]): VerificationResult {
  const token = getHeader(req.headers, 'x-telegram-bot-api-secret-token');
  if (!token) return { ok: false, reason: 'Missing Telegram secret token header', statusCode: 401 };
  const ok = secrets.some((secretValue) => timingSafeEqual(Buffer.from(token), Buffer.from(secretValue)));
  if (!ok) return { ok: false, reason: 'Invalid Telegram secret token', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  const updateId = parsed?.update_id != null ? String(parsed.update_id) : undefined;
  if (!updateId) return { ok: false, reason: 'Missing Telegram update id', statusCode: 400 };
  const eventType = Object.keys(parsed ?? {}).find((k) => k !== 'update_id') ?? 'update';
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, updateId), eventType: `telegram.${eventType}`, parsedJson: parsed };
}

function verifyGeneric(req: Request, raw: Buffer, source: SourceConfig, secrets: string[], toleranceSeconds: number): VerificationResult {
  const generic = source.generic;
  if (!generic) return { ok: false, reason: 'Missing generic verifier config', statusCode: 500 };
  const sigHeader = getHeader(req.headers, generic.signatureHeader);
  if (!sigHeader) return { ok: false, reason: 'Missing generic signature header', statusCode: 401 };
  const timestampRaw = generic.timestampHeader ? getHeader(req.headers, generic.timestampHeader) : undefined;
  if (generic.signedContent === 'timestamp.body') {
    if (!timestampRaw) return { ok: false, reason: 'Missing generic timestamp header', statusCode: 401 };
    const ts = Number(timestampRaw);
    if (!Number.isFinite(ts) || !timestampWithinTolerance(ts, toleranceSeconds)) return { ok: false, reason: 'Generic timestamp outside tolerance', statusCode: 401 };
  }
  const content = generic.signedContent === 'timestamp.body' ? `${timestampRaw}.${raw.toString('utf8')}` : raw;
  const candidates = sigHeader.split(',').map((v) => v.trim()).filter(Boolean);
  const ok = secrets.some((secretValue) => {
    const expected = hmacSha256(decodeSecret(secretValue), content);
    return candidates.some((candidate) => {
      const cleaned = generic.signaturePrefix && candidate.startsWith(generic.signaturePrefix) ? candidate.slice(generic.signaturePrefix.length) : candidate;
      return safeCompareEncoded(cleaned, generic.signatureEncoding, expected);
    });
  });
  if (!ok) return { ok: false, reason: 'Invalid generic HMAC signature', statusCode: 401 };
  const parsed = parseJsonSafe(raw) as any;
  const eventId = generic.idHeader ? getHeader(req.headers, generic.idHeader) : undefined;
  const resolvedEventId = eventId ?? parsed?.id;
  if (!resolvedEventId) return { ok: false, reason: 'Missing generic event id', statusCode: 400 };
  const eventType = generic.eventTypeHeader ? getHeader(req.headers, generic.eventTypeHeader) : undefined;
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, resolvedEventId), eventType: eventType ?? parsed?.type ?? 'generic.event', parsedJson: parsed };
}

function verifyNone(source: SourceConfig, raw: Buffer): VerificationResult {
  const parsed = parseJsonSafe(raw) as any;
  return { ok: true, providerEventId: normalizeProviderEventId(source.provider, parsed?.id), eventType: parsed?.type ?? 'unsafe.none', parsedJson: parsed };
}

function parseStandardSignatures(header: string): string[] {
  return header.split(/\s+/).map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const [version, value] = part.split(',', 2);
    return version === 'v1' && value ? [value] : [];
  });
}

function safeCompareEncoded(value: string, encoding: BufferEncoding, expected: Buffer): boolean {
  try {
    return timingSafeEqual(Buffer.from(value, encoding), expected);
  } catch {
    return false;
  }
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
