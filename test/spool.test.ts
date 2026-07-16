import { describe, expect, it } from 'vitest';
import { serializeSpoolPayload } from '../src/feature/spool.js';

describe('emergency spool integrity', () => {
  it('does not sanitize recovery-critical body or CloudEvent data', () => {
    const payload = serializeSpoolPayload({
      receivedAt: '2026-01-01T00:00:00.000Z',
      source: { id: 'source-1' },
      headers: { authorization: 'Bearer abc.def.ghi', 'x-safe': 'ok' },
      body: 'token=must_remain_for_replay',
      verified: { ok: true, providerEventId: 'evt_1', eventType: 'demo' },
      cloudEvent: { data: { token: 'must_remain_for_replay' } }
    });

    expect(payload.body).toBe('token=must_remain_for_replay');
    expect(payload.cloudEvent).toEqual({ data: { token: 'must_remain_for_replay' } });
    expect(payload.headers).toEqual({ authorization: '[REDACTED]', 'x-safe': 'ok' });
  });
});
