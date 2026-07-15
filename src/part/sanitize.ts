const SENSITIVE_KEY_PATTERN = /(secret|token|key|authorization|cookie|set-cookie|x-api-key|x-admin-token|password|passwd|credential)/i;
const SENSITIVE_VALUE_PATTERN = /(Bearer\s+[A-Za-z0-9._~+\/-]+=*|whsec_[A-Za-z0-9_]+|ghp_[A-Za-z0-9_]+|base64:[A-Za-z0-9+/=]{16,})/g;
const SENSITIVE_ASSIGNMENT_PATTERN = /(secret|token|key|authorization|password|passwd|credential)\s*[:=]\s*[^\s,;]+/gi;

export function sanitizeText(input: unknown, maxLength = 2000): string {
  const text = String(input ?? '')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1=[REDACTED]')
    .replace(SENSITIVE_VALUE_PATTERN, '[REDACTED]');
  return text.slice(0, maxLength);
}

export function sanitizeObject<T = unknown>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeText(value, 4000) as T;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeObject(item)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeObject(item);
  }
  return out as T;
}

export function safeMetricLabel(value: unknown, fallback = 'unknown'): string {
  const raw = sanitizeText(value ?? fallback, 128).toLowerCase();
  return raw.replace(/[^a-z0-9_.:-]/g, '_').slice(0, 80) || fallback;
}
