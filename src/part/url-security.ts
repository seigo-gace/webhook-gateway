import net from 'node:net';

const blockedHostnames = new Set(['localhost', 'localhost.localdomain']);

export function validateDestinationUrl(urlValue: string, options: { allowPrivateNetwork?: boolean }): void {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error('destination URL is invalid');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('destination URL protocol must be http or https');
  }

  if (parsed.username || parsed.password) {
    throw new Error('destination URL must not contain embedded credentials');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isPrivate = isPrivateDestinationHostname(hostname);
  if (isPrivate && !options.allowPrivateNetwork) {
    throw new Error('destination URL points to a private or local network target without allowPrivateNetwork=true');
  }
}

export function isPrivateDestinationHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (blockedHostnames.has(normalized)) return true;
  if (normalized.endsWith('.localhost')) return true;
  if (!normalized.includes('.') && net.isIP(normalized) === 0) return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToNumber(ip);
  return inIpv4Range(n, '10.0.0.0', 8)
    || inIpv4Range(n, '127.0.0.0', 8)
    || inIpv4Range(n, '169.254.0.0', 16)
    || inIpv4Range(n, '172.16.0.0', 12)
    || inIpv4Range(n, '192.168.0.0', 16)
    || inIpv4Range(n, '100.64.0.0', 10)
    || inIpv4Range(n, '0.0.0.0', 8)
    || inIpv4Range(n, '224.0.0.0', 4)
    || inIpv4Range(n, '240.0.0.0', 4);
}

function isPrivateIpv6(ip: string): boolean {
  return ip === '::1'
    || ip === '::'
    || ip.startsWith('fc')
    || ip.startsWith('fd')
    || ip.startsWith('fe80:')
    || ip.startsWith('ff');
}

function inIpv4Range(value: number, rangeStart: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (ipv4ToNumber(rangeStart) & mask);
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}
