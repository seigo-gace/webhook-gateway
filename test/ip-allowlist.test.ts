import { describe, expect, it } from 'vitest';
import { isIpAllowed, isValidAllowlistRule, normalizeIp, splitAllowlist } from '../src/part/ip-allowlist.js';

describe('IP allowlist helpers', () => {
  it('allows all when the allowlist is empty', () => {
    expect(isIpAllowed('203.0.113.10', [])).toBe(true);
    expect(isIpAllowed(undefined, [])).toBe(true);
  });

  it('normalizes IPv4-mapped localhost addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('127.0.0.1');
  });

  it('matches exact IPs and IPv4 CIDR ranges', () => {
    expect(isIpAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true);
    expect(isIpAllowed('203.0.113.5', ['203.0.113.0/24'])).toBe(true);
    expect(isIpAllowed('203.0.114.5', ['203.0.113.0/24'])).toBe(false);
  });

  it('validates allowlist rules before runtime use', () => {
    expect(isValidAllowlistRule('*')).toBe(true);
    expect(isValidAllowlistRule('127.0.0.1')).toBe(true);
    expect(isValidAllowlistRule('10.0.0.0/8')).toBe(true);
    expect(isValidAllowlistRule('10.0.0.0/99')).toBe(false);
    expect(isValidAllowlistRule('10.0.0.0/8/extra')).toBe(false);
    expect(isValidAllowlistRule('not-an-ip')).toBe(false);
  });

  it('splits comma-separated env allowlists safely', () => {
    expect(splitAllowlist(' 127.0.0.1, 10.0.0.0/8 ,,')).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });
});
