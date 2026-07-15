import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { verifyInbound } from '../src/verifiers.js';
import { normalizeProviderEventId } from '../src/normalizer.js';
import { sanitizeObject, sanitizeText } from '../src/sanitize.js';
import { parseChronycOffset } from '../src/clock.js';
import type { SourceConfig } from '../src/types.js';

function req(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}
function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

const baseSource = (provider: SourceConfig['provider'], secretEnv: string): SourceConfig => ({
  id: 's', appId: 'app', name: provider, slug: provider, provider, secretEnv, toleranceSeconds: 300, enabled: true
});

describe('inbound verifiers', () => {
  it('verifies GitHub sha256 signature', () => {
    process.env.GITHUB_SECRET = 'secret';
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = crypto.createHmac('sha256', 'secret').update(body).digest('hex');
    const result = verifyInbound(req({ 'x-hub-signature-256': `sha256=${sig}`, 'x-github-delivery': 'd1', 'x-github-event': 'push' }), baseSource('github','GITHUB_SECRET'), body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerEventId).toBe('d1');
  });

  it('rejects invalid GitHub sha256 signature', () => {
    process.env.GITHUB_SECRET = 'secret';
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const result = verifyInbound(req({ 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-delivery': 'd1', 'x-github-event': 'push' }), baseSource('github','GITHUB_SECRET'), body);
    expect(result.ok).toBe(false);
  });

  it('verifies Standard Webhooks signature and supports multiple signatures', () => {
    process.env.STANDARD_SECRET = 'base64:' + Buffer.from('secretsecretsecretsecretsecret12').toString('base64');
    const body = Buffer.from(JSON.stringify({ type: 'demo.created' }));
    const id = 'evt_1';
    const ts = nowSeconds().toString();
    const secret = Buffer.from(process.env.STANDARD_SECRET.slice('base64:'.length), 'base64');
    const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body.toString('utf8')}`).digest('base64');
    const result = verifyInbound(req({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,bad v1,${sig}` }), baseSource('standard','STANDARD_SECRET'), body);
    expect(result.ok).toBe(true);
  });

  it('rejects expired Standard Webhooks timestamp', () => {
    process.env.STANDARD_SECRET = 'base64:' + Buffer.from('secretsecretsecretsecretsecret12').toString('base64');
    const body = Buffer.from(JSON.stringify({ type: 'demo.created' }));
    const id = 'evt_expired';
    const ts = (nowSeconds() - 350).toString();
    const secret = Buffer.from(process.env.STANDARD_SECRET.slice('base64:'.length), 'base64');
    const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body.toString('utf8')}`).digest('base64');
    const result = verifyInbound(req({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }), baseSource('standard','STANDARD_SECRET'), body);
    expect(result.ok).toBe(false);
  });

  it('verifies Stripe signature and supports multiple v1 values', () => {
    process.env.STRIPE_SECRET = 'whsec_test';
    const body = Buffer.from(JSON.stringify({ id: 'evt_stripe_1', type: 'payment_intent.succeeded' }));
    const ts = nowSeconds().toString();
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const result = verifyInbound(req({ 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)},v1=${sig}` }), baseSource('stripe','STRIPE_SECRET'), body);
    expect(result.ok).toBe(true);
  });

  it('rejects expired Stripe timestamp', () => {
    process.env.STRIPE_SECRET = 'whsec_test';
    const body = Buffer.from(JSON.stringify({ id: 'evt_stripe_old', type: 'payment_intent.succeeded' }));
    const ts = (nowSeconds() - 350).toString();
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const result = verifyInbound(req({ 'stripe-signature': `t=${ts},v1=${sig}` }), baseSource('stripe','STRIPE_SECRET'), body);
    expect(result.ok).toBe(false);
  });

  it('verifies Slack signature', () => {
    process.env.SLACK_SECRET = 'slack_secret';
    const body = Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev123', event: { type: 'message' } }));
    const ts = nowSeconds().toString();
    const base = `v0:${ts}:${body.toString('utf8')}`;
    const sig = crypto.createHmac('sha256', 'slack_secret').update(base).digest('hex');
    const result = verifyInbound(req({ 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${sig}` }), baseSource('slack','SLACK_SECRET'), body);
    expect(result.ok).toBe(true);
  });

  it('verifies Telegram secret token', () => {
    process.env.TELEGRAM_SECRET = 'telegram_token';
    const body = Buffer.from(JSON.stringify({ update_id: 123, message: { text: 'hi' } }));
    const result = verifyInbound(req({ 'x-telegram-bot-api-secret-token': 'telegram_token' }), baseSource('telegram','TELEGRAM_SECRET'), body);
    expect(result.ok).toBe(true);
  });

  it('verifies Generic HMAC timestamp.body signature and normalizes id', () => {
    process.env.GENERIC_SECRET = 'generic_secret';
    const body = Buffer.from(JSON.stringify({ id: 'evt_generic_1', type: 'generic.created' }));
    const ts = nowSeconds().toString();
    const sig = crypto.createHmac('sha256', 'generic_secret').update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const source: SourceConfig = { ...baseSource('generic-hmac-sha256','GENERIC_SECRET'), generic: { signatureHeader: 'x-signature', timestampHeader: 'x-timestamp', idHeader: 'x-event-id', eventTypeHeader: 'x-event-type', signatureEncoding: 'hex', signaturePrefix: 'sha256=', signedContent: 'timestamp.body' } };
    const result = verifyInbound(req({ 'x-signature': `sha256=${sig}`, 'x-timestamp': ts, 'x-event-id': ' EVT_GENERIC_1 ', 'x-event-type': 'generic.created' }), source, body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerEventId).toBe('evt_generic_1');
  });
});

describe('hardening helpers', () => {
  it('normalizes generic provider event ids only', () => {
    expect(normalizeProviderEventId('generic-hmac-sha256', ' ABC ')).toBe('abc');
    expect(normalizeProviderEventId('github', ' ABC ')).toBe(' ABC ');
  });

  it('sanitizes sensitive fields and values', () => {
    expect(sanitizeObject({ token: 'abc', nested: { ok: 'yes' } })).toEqual({ token: '[REDACTED]', nested: { ok: 'yes' } });
    expect(sanitizeText('Authorization: Bearer abc.def.ghi')).toContain('[REDACTED]');
  });

  it('parses chronyc offsets', () => {
    expect(parseChronycOffset('Last offset     : +0.012345 seconds')).toBeCloseTo(0.012345);
  });
});
