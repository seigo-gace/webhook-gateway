import { env } from '../part/env.js';
import type { DestinationConfig } from '../part/types.js';

export type DeliveryEvaluation = 'delivered' | 'unknown' | 'failed';

export function evaluateDeliverySuccess(
  destination: DestinationConfig,
  response: Response
): DeliveryEvaluation {
  if (response.status < 200 || response.status >= 300) return 'failed';
  if ((destination.successMode ?? 'status_only') === 'status_only') return 'delivered';

  const header = destination.acceptedHeader ?? 'x-gace-accepted';
  const expected = destination.acceptedHeaderValue ?? 'true';

  return response.headers.get(header)?.toLowerCase() === expected.toLowerCase()
    ? 'delivered'
    : 'unknown';
}

export function buildDeliveryPayload(
  destination: DestinationConfig,
  bodyText: string | null,
  normalizedPayload: unknown,
  cloudEvent: unknown
): string {
  if (destination.payloadMode === 'raw') {
    return String(bodyText ?? JSON.stringify(normalizedPayload ?? {}));
  }

  if (destination.payloadMode === 'json') {
    return JSON.stringify(normalizedPayload ?? {});
  }

  return JSON.stringify(cloudEvent ?? {});
}

export function nextDeliveryBackoff(attempts: number): Date {
  const delayMs = Math.min(
    21_600_000,
    env.UNKNOWN_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1)
  );

  return new Date(Date.now() + delayMs);
}

export function isFinalDeliveryAttempt(attempt: number, maxAttempts: number): boolean {
  return attempt >= maxAttempts;
}

export function isDeliveryTimeoutError(err: unknown): boolean {
  const value = err as { name?: string; message?: string };
  return value?.name === 'AbortError' || /timeout|aborted/i.test(String(value?.message ?? err));
}
