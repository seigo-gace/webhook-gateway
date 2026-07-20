import { describe, expect, it } from 'vitest';
import { readResponseBodyLimited, resolveDestination } from '../src/feature/destination-http.js';

describe('destination HTTP security', () => {
  it('pins a public DNS answer', async () => {
    const resolved = await resolveDestination(
      'https://example.com/hooks',
      false,
      async () => [{ address: '93.184.216.34', family: 4 }]
    );
    expect(resolved.hostname).toBe('example.com');
    expect(resolved.address).toBe('93.184.216.34');
    expect(resolved.family).toBe(4);
  });

  it('rejects a hostname when any DNS answer is private', async () => {
    await expect(resolveDestination(
      'https://example.com/hooks',
      false,
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]
    )).rejects.toThrow('DESTINATION_DNS_PRIVATE_ADDRESS');
  });

  it('rejects IPv4-mapped IPv6 loopback answers', async () => {
    await expect(resolveDestination(
      'https://example.com/hooks',
      false,
      async () => [{ address: '::ffff:127.0.0.1', family: 6 }]
    )).rejects.toThrow('DESTINATION_DNS_PRIVATE_ADDRESS');
  });

  it('permits explicitly configured private destinations while still pinning the answer', async () => {
    const resolved = await resolveDestination(
      'http://internal-service/hooks',
      true,
      async () => [{ address: '10.0.0.10', family: 4 }]
    );
    expect(resolved.address).toBe('10.0.0.10');
  });

  it('bounds downstream response bodies', async () => {
    const response = new Response('1234567890');
    await expect(readResponseBodyLimited(response, 5)).rejects.toThrow('DELIVERY_RESPONSE_BODY_TOO_LARGE');
  });
});
