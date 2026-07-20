import { env } from '../part/env.js';
import type { DestinationConfig, RetryClass } from '../part/types.js';

export type DeliveryEvaluation = 'delivered' | 'unknown' | 'failed';

export interface DeliveryFailurePolicy {
  status: 'retrying' | 'dead' | 'unknown' | 'skipped';
  retryClass: RetryClass;
  nextAttemptAt: Date | null;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Payload(value: unknown): string | null {
  if (!isRecord(value) || typeof value.base64 !== 'string') return null;
  try {
    return Buffer.from(value.base64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function evaluateDeliverySuccess(
  destination: DestinationConfig,
  response: Response
): DeliveryEvaluation {
  if (response.status < 200 || response.status >= 300) return 'failed';
  if ((destination.successMode ?? 'status_only') === 'status_only') return 'delivered';
  if (destination.unknownPolicy === 'treat_2xx_as_delivered') return 'delivered';

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
    if (bodyText !== null) return bodyText;
    const decoded = decodeBase64Payload(normalizedPayload);
    if (decoded !== null) return decoded;
    return JSON.stringify(normalizedPayload ?? {});
  }
  if (destination.payloadMode === 'json') return JSON.stringify(normalizedPayload ?? {});
  return JSON.stringify(cloudEvent ?? {});
}

export function classifyHttpFailure(statusCode: number): RetryClass {
  if (statusCode === 410) return 'gone';
  if (statusCode === 429) return 'throttle';
  if ([500, 502, 503, 504].includes(statusCode)) return 'infrastructure';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  return 'normal';
}

export function deliveryFailurePolicy(input: {
  response: Response;
  destination: DestinationConfig;
  attempt: number;
  responseBody: string;
}): DeliveryFailurePolicy {
  const retryClass = classifyHttpFailure(input.response.status);
  const reason = `Downstream returned ${input.response.status}: ${input.responseBody}`;
  const finalAttempt = isFinalDeliveryAttempt(input.attempt, input.destination.maxAttempts);

  if (retryClass === 'gone') {
    return {
      status: 'skipped',
      retryClass,
      nextAttemptAt: null,
      reason: 'Downstream returned 410 Gone; destination should be disabled or reconfigured'
    };
  }
  if (retryClass === 'client_error' && !env.CLIENT_ERROR_RETRY_ENABLED) {
    return { status: 'dead', retryClass, nextAttemptAt: null, reason };
  }
  if (finalAttempt) {
    return { status: 'dead', retryClass, nextAttemptAt: null, reason };
  }
  return {
    status: 'retrying',
    retryClass,
    nextAttemptAt: nextDeliveryBackoff(input.attempt, {
      retryClass,
      retryAfterHeader: input.response.headers.get('retry-after')
    }),
    reason
  };
}

export function nextDeliveryBackoff(
  attempts: number,
  options: { retryClass?: RetryClass; retryAfterHeader?: string | null } = {}
): Date {
  const retryAfter = parseRetryAfter(options.retryAfterHeader ?? null);
  if (retryAfter !== null) return retryAfter;

  const retryClass = options.retryClass ?? 'normal';
  const base = retryClass === 'throttle'
    ? env.THROTTLE_RETRY_BACKOFF_BASE_MS
    : retryClass === 'infrastructure'
      ? env.INFRA_RETRY_BACKOFF_BASE_MS
      : env.UNKNOWN_RETRY_BACKOFF_BASE_MS;
  const delayMs = Math.min(
    env.RETRY_AFTER_MAX_SECONDS * 1000,
    base * 2 ** Math.max(0, attempts - 1)
  );
  return new Date(Date.now() + delayMs);
}

export function parseRetryAfter(value: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    const bounded = Math.min(asSeconds, env.RETRY_AFTER_MAX_SECONDS);
    return new Date(Date.now() + bounded * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const now = Date.now();
    const max = now + env.RETRY_AFTER_MAX_SECONDS * 1000;
    return new Date(Math.min(Math.max(asDate, now), max));
  }
  return null;
}

export function isFinalDeliveryAttempt(attempt: number, maxAttempts: number): boolean {
  return attempt >= maxAttempts;
}

export function isDeliveryTimeoutError(err: unknown): boolean {
  const value = err as { name?: string; message?: string };
  return value?.name === 'AbortError' || /timeout|aborted/i.test(String(value?.message ?? err));
}
