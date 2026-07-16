import net from 'node:net';

export function splitAllowlist(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function isIpAllowed(ip: string | undefined, allowlist: string[] | undefined): boolean {
  const rules = (allowlist ?? []).map((item) => item.trim()).filter(Boolean);
  if (rules.length === 0) return true;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  return rules.some((rule) => matchesRule(normalized, rule));
}

export function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const cleaned = ip.trim().replace(/^::ffff:/, '');
  if (cleaned === '::1') return '127.0.0.1';
  return net.isIP(cleaned) ? cleaned : null;
}

export function isValidAllowlistRule(rule: string): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  if (normalizeIp(trimmed)) return true;
  const parts = trimmed.split('/');
  if (parts.length !== 2) return false;
  const [range, prefixRaw] = parts;
  if (!range || !prefixRaw) return false;
  const normalizedRange = normalizeIp(range);
  if (!normalizedRange || net.isIP(normalizedRange) !== 4) return false;
  const prefix = Number(prefixRaw);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function matchesRule(ip: string, rule: string): boolean {
  if (rule === '*') return true;
  const normalizedRule = normalizeIp(rule);
  if (normalizedRule) return normalizedRule === ip;
  const parts = rule.split('/');
  if (parts.length !== 2) return false;
  const [range, prefixRaw] = parts;
  if (!range || !prefixRaw) return false;
  const normalizedRange = normalizeIp(range);
  if (!normalizedRange || net.isIP(normalizedRange) !== 4 || net.isIP(ip) !== 4) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(normalizedRange) & mask);
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}
