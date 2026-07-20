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
  if (parsed.hash) {
    throw new Error('destination URL must not contain a fragment');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateDestinationHostname(hostname) && !options.allowPrivateNetwork) {
    throw new Error('destination URL points to a private, local, reserved, or non-routable target without allowPrivateNetwork=true');
  }
}

export function isPrivateDestinationHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (blockedHostnames.has(normalized)) return true;
  if (normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (!normalized.includes('.') && net.isIP(normalized) === 0) return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isNonPublicIpv4(normalized);
  if (ipVersion === 6) return isNonPublicIpv6(normalized);
  return false;
}

function isNonPublicIpv4(ip: string): boolean {
  const n = ipv4ToNumber(ip);
  return inIpv4Range(n, '0.0.0.0', 8)
    || inIpv4Range(n, '10.0.0.0', 8)
    || inIpv4Range(n, '100.64.0.0', 10)
    || inIpv4Range(n, '127.0.0.0', 8)
    || inIpv4Range(n, '169.254.0.0', 16)
    || inIpv4Range(n, '172.16.0.0', 12)
    || inIpv4Range(n, '192.0.0.0', 24)
    || inIpv4Range(n, '192.0.2.0', 24)
    || inIpv4Range(n, '192.168.0.0', 16)
    || inIpv4Range(n, '198.18.0.0', 15)
    || inIpv4Range(n, '198.51.100.0', 24)
    || inIpv4Range(n, '203.0.113.0', 24)
    || inIpv4Range(n, '224.0.0.0', 4)
    || inIpv4Range(n, '240.0.0.0', 4);
}

function isNonPublicIpv6(ip: string): boolean {
  const value = ip.toLowerCase();
  return value === '::1'
    || value === '::'
    || value.startsWith('::ffff:')
    || value.startsWith('fc')
    || value.startsWith('fd')
    || value.startsWith('fe80:')
    || value.startsWith('fec0:')
    || value.startsWith('ff')
    || value.startsWith('2001:db8:')
    || value.startsWith('2001:0000:')
    || value.startsWith('2001:0:')
    || value.startsWith('2002:');
}

function inIpv4Range(value: number, rangeStart: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (ipv4ToNumber(rangeStart) & mask);
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}
