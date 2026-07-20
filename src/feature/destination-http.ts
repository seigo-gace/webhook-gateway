import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateDestinationHostname, validateDestinationUrl } from '../part/url-security.js';

export interface ResolvedDestination {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export type DestinationResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: DestinationResolver = async (hostname) => {
  if (net.isIP(hostname)) {
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  return dns.lookup(hostname, { all: true, verbatim: true });
};

export async function resolveDestination(
  urlValue: string,
  allowPrivateNetwork: boolean,
  resolver: DestinationResolver = defaultResolver
): Promise<ResolvedDestination> {
  validateDestinationUrl(urlValue, { allowPrivateNetwork });
  const url = new URL(urlValue);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const addresses = await resolver(hostname);
  if (addresses.length === 0) throw new Error('DESTINATION_DNS_EMPTY');

  const normalized = addresses.map((entry) => ({
    address: entry.address.replace(/^\[(.*)\]$/, '$1').toLowerCase(),
    family: entry.family === 6 ? 6 as const : 4 as const
  }));

  if (!allowPrivateNetwork && normalized.some((entry) => isPrivateDestinationHostname(entry.address))) {
    throw new Error('DESTINATION_DNS_PRIVATE_ADDRESS');
  }

  const selected = normalized.find((entry) => allowPrivateNetwork || !isPrivateDestinationHostname(entry.address));
  if (!selected) throw new Error('DESTINATION_DNS_NO_ALLOWED_ADDRESS');

  return { url, hostname, address: selected.address, family: selected.family };
}

export async function dispatchPinnedWebhook(input: {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  resolver?: DestinationResolver;
}): Promise<{ response: Response; close: () => Promise<void>; resolved: ResolvedDestination }> {
  const resolved = await resolveDestination(input.url, input.allowPrivateNetwork, input.resolver);
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, resolved.address, resolved.family);
      }
    }
  });

  try {
    const response = await undiciFetch(resolved.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs),
      dispatcher: agent
    });
    return {
      response: response as unknown as Response,
      resolved,
      close: async () => { await agent.close(); }
    };
  } catch (error) {
    await agent.close().catch(() => undefined);
    throw error;
  }
}

export async function readResponseBodyLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('response body too large');
        throw new Error('DELIVERY_RESPONSE_BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
