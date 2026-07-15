import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { verifyInbound } from '../src/verifiers.js';

function req(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('inbound verifiers', () => {
  it('verifies GitHub sha256 signature', () => {
    process.env.GITHUB_SECRET = 'secret';
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = crypto.createHmac('sha256', 'secret').update(body).digest('hex');
    const result = verifyInbound(req({
      'x-hub-signature-256': `sha256=${sig}`,
      'x-github-delivery': 'd1',
      'x-github-event': 'push'
    }), { id: 's', provider: 'github', secret_env: 'GITHUB_SECRET' } as any, body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerEventId).toBe('d1');
  });

  it('rejects invalid GitHub sha256 signature', () => {
    process.env.GITHUB_SECRET = 'secret';
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const result = verifyInbound(req({
      'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      'x-github-delivery': 'd1',
      'x-github-event': 'push'
    }), { id: 's', provider: 'github', secret_env: 'GITHUB_SECRET' } as any, body);
    expect(result.ok).toBe(false);
  });

  it('verifies Standard Webhooks signature', () => {
    process.env.STANDARD_SECRET = 'base64:' + Buffer.from('secretsecretsecretsecretsecret12').toString('base64');
    const body = Buffer.from(JSON.stringify({ type: 'demo.created' }));
    const id = 'evt_1';
    const ts = nowSeconds().toString();
    const secret = Buffer.from(process.env.STANDARD_SECRET.slice('base64:'.length), 'base64');
    const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body.toString('utf8')}`).digest('base64');
    const result = verifyInbound(req({
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${sig}`
    }), { id: 's', provider: 'standard', secret_env: 'STANDARD_SECRET', tolerance_seconds: 300 } as any, body);
    expect(result.ok).toBe(true);
  });

  it('rejects expired Standard Webhooks timestamp', () => {
    process.env.STANDARD_SECRET = 'base64:' + Buffer.from('secretsecretsecretsecretsecret12').toString('base64');
    const body = Buffer.from(JSON.stringify({ type: 'demo.created' }));
    const id = 'evt_expired';
    const ts = (nowSeconds() - 350).toString();
    const secret = Buffer.from(process.env.STANDARD_SECRET.slice('base64:'.length), 'base64');
    const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body.toString('utf8')}`).digest('base64');
    const result = verifyInbound(req({
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${sig}`
    }), { id: 's', provider: 'standard', secret_env: 'STANDARD_SECRET', tolerance_seconds: 300 } as any, body);
    expect(result.ok).toBe(false);
  });

  it('verifies Stripe signature', () => {
    process.env.STRIPE_SECRET = 'whsec_test';
    const body = Buffer.from(JSON.stringify({ id: 'evt_stripe_1', type: 'payment_intent.succeeded' }));
    const ts = nowSeconds().toString();
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const result = verifyInbound(req({ 'stripe-signature': `t=${ts},v1=${sig}` }), { id: 's', provider: 'stripe', secret_env: 'STRIPE_SECRET', tolerance_seconds: 300 } as any, body);
    expect(result.ok).toBe(true);
  });

  it('rejects expired Stripe timestamp', () => {
    process.env.STRIPE_SECRET = 'whsec_test';
    const body = Buffer.from(JSON.stringify({ id: 'evt_stripe_old', type: 'payment_intent.succeeded' }));
    const ts = (nowSeconds() - 350).toString();
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const result = verifyInbound(req({ 'stripe-signature': `t=${ts},v1=${sig}` }), { id: 's', provider: 'stripe', secret_env: 'STRIPE_SECRET', tolerance_seconds: 300 } as any, body);
    expect(result.ok).toBe(false);
  });

  it('verifies Slack signature', () => {
    process.env.SLACK_SECRET = 'slack_secret';
    const body = Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev123', event: { type: 'message' } }));
    const ts = nowSeconds().toString();
    const base = `v0:${ts}:${body.toString('utf8')}`;
    const sig = crypto.createHmac('sha256', 'slack_secret').update(base).digest('hex');
    const result = verifyInbound(req({
      'x-slack-request-timestamp': ts,
      'x-slack-signature': `v0=${sig}`
    }), { id: 's', provider: 'slack', secret_env: 'SLACK_SECRET', tolerance_seconds: 300 } as any, body);
    expect(result.ok).toBe(true);
  });

  it('verifies Telegram secret token', () => {
    process.env.TELEGRAM_SECRET = 'telegram_token';
    const body = Buffer.from(JSON.stringify({ update_id: 123, message: { text: 'hi' } }));
    const result = verifyInbound(req({
      'x-telegram-bot-api-secret-token': 'telegram_token'
    }), { id: 's', provider: 'telegram', secret_env: 'TELEGRAM_SECRET' } as any, body);
    expect(result.ok).toBe(true);
  });

  it('verifies Generic HMAC timestamp.body signature', () => {
    process.env.GENERIC_SECRET = 'generic_secret';
    const body = Buffer.from(JSON.stringify({ id: 'evt_generic_1', type: 'generic.created' }));
    const ts = nowSeconds().toString();
    const sig = crypto.createHmac('sha256', 'generic_secret').update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const result = verifyInbound(req({
      'x-signature': `sha256=${sig}`,
      'x-timestamp': ts
    }), {
      id: 's',
      provider: 'generic-hmac-sha256',
      secret_env: 'GENERIC_SECRET',
      tolerance_seconds: 300,
      generic: {
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        signatureEncoding: 'hex',
        signaturePrefix: 'sha256=',
        signedContent: 'timestamp.body'
      }
    } as any, body);
    expect(result.ok).toBe(true);
  });
});
