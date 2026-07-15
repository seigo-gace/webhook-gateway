import { randomId } from './crypto.js';
import type { Provider } from './types.js';

export function normalizeProviderEventId(provider: Provider, value: string | undefined): string {
  if (provider === 'none') return `dev-${randomId()}`;
  const v = value && value.length > 0 ? value : randomId();
  if (provider === 'generic-hmac-sha256') return v.trim().toLowerCase();
  return v;
}
