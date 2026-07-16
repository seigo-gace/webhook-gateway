import { describe, expect, it } from 'vitest';
import { isPrivateDestinationHostname, validateDestinationUrl } from '../src/part/url-security.js';

describe('destination URL security', () => {
  it('detects private and local destination hosts', () => {
    expect(isPrivateDestinationHostname('localhost')).toBe(true);
    expect(isPrivateDestinationHostname('127.0.0.1')).toBe(true);
    expect(isPrivateDestinationHostname('10.0.0.10')).toBe(true);
    expect(isPrivateDestinationHostname('192.168.1.10')).toBe(true);
    expect(isPrivateDestinationHostname('169.254.169.254')).toBe(true);
    expect(isPrivateDestinationHostname('internal-api')).toBe(true);
    expect(isPrivateDestinationHostname('api.example.com')).toBe(false);
  });

  it('rejects unsafe private destinations unless explicitly allowed', () => {
    expect(() => validateDestinationUrl('http://127.0.0.1:3000/hook', {})).toThrow(/private or local/);
    expect(() => validateDestinationUrl('http://internal-api:3000/hook', {})).toThrow(/private or local/);
    expect(() => validateDestinationUrl('http://internal-api:3000/hook', { allowPrivateNetwork: true })).not.toThrow();
  });

  it('rejects unsafe protocols and embedded credentials', () => {
    expect(() => validateDestinationUrl('file:///etc/passwd', {})).toThrow(/protocol/);
    expect(() => validateDestinationUrl('https://user:pass@example.com/hook', {})).toThrow(/credentials/);
  });
});
