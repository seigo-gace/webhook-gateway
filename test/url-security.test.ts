import { describe, expect, it } from 'vitest';
import { isPrivateDestinationHostname, validateDestinationUrl } from '../src/part/url-security.js';

describe('destination URL security', () => {
  it('detects private, local, reserved, and non-routable destination hosts', () => {
    expect(isPrivateDestinationHostname('localhost')).toBe(true);
    expect(isPrivateDestinationHostname('127.0.0.1')).toBe(true);
    expect(isPrivateDestinationHostname('10.0.0.10')).toBe(true);
    expect(isPrivateDestinationHostname('192.168.1.10')).toBe(true);
    expect(isPrivateDestinationHostname('169.254.169.254')).toBe(true);
    expect(isPrivateDestinationHostname('192.0.2.10')).toBe(true);
    expect(isPrivateDestinationHostname('203.0.113.10')).toBe(true);
    expect(isPrivateDestinationHostname('internal-api')).toBe(true);
    expect(isPrivateDestinationHostname('api.example.com')).toBe(false);
  });

  it('rejects unsafe private destinations unless explicitly allowed', () => {
    expect(() => validateDestinationUrl('http://127.0.0.1:3000/hook', {})).toThrow(/private/);
    expect(() => validateDestinationUrl('http://internal-api:3000/hook', {})).toThrow(/private/);
    expect(() => validateDestinationUrl('http://internal-api:3000/hook', { allowPrivateNetwork: true })).not.toThrow();
  });

  it('rejects unsafe protocols, embedded credentials, and fragments', () => {
    expect(() => validateDestinationUrl('file:///etc/passwd', {})).toThrow(/protocol/);
    expect(() => validateDestinationUrl('https://user:pass@example.com/hook', {})).toThrow(/credentials/);
    expect(() => validateDestinationUrl('https://example.com/hook#internal', {})).toThrow(/fragment/);
  });
});
