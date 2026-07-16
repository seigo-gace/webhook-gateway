import { describe, expect, it } from 'vitest';
import { buildDeliveryPayload, evaluateDeliverySuccess, isFinalDeliveryAttempt } from '../src/component/delivery.js';
import type { DestinationConfig } from '../src/part/types.js';

const destination = (overrides: Partial<DestinationConfig>): DestinationConfig => ({
  id: 'dest',
  appId: 'app',
  name: 'Destination',
  urlEnv: 'DEST_URL',
  method: 'POST',
  payloadMode: 'json',
  maxAttempts: 3,
  enabled: true,
  ...overrides
});

describe('delivery payload and outcome helpers', () => {
  it('uses stored raw body when raw payload mode has body text', () => {
    const payload = buildDeliveryPayload(destination({ payloadMode: 'raw' }), 'raw-body', { base64: Buffer.from('fallback').toString('base64') }, {});
    expect(payload).toBe('raw-body');
  });

  it('rebuilds raw payload from normalized base64 when raw body is not stored', () => {
    const original = JSON.stringify({ hello: 'world' });
    const payload = buildDeliveryPayload(destination({ payloadMode: 'raw' }), null, { base64: Buffer.from(original).toString('base64') }, {});
    expect(payload).toBe(original);
  });

  it('keeps status-and-header 2xx responses unknown until the accepted header is present', () => {
    const response = new Response('ok', { status: 202, headers: { 'x-gace-accepted': 'false' } });
    expect(evaluateDeliverySuccess(destination({ successMode: 'status_and_header' }), response)).toBe('unknown');
  });

  it('detects final delivery attempts', () => {
    expect(isFinalDeliveryAttempt(3, 3)).toBe(true);
    expect(isFinalDeliveryAttempt(2, 3)).toBe(false);
  });
});
