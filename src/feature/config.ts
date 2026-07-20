import fs from 'node:fs';
import path from 'node:path';
import { env, optionalEnv } from '../part/env.js';
import { decodeSecret } from '../part/crypto.js';
import { isValidAllowlistRule, splitAllowlist } from '../part/ip-allowlist.js';
import { validateDestinationUrl } from '../part/url-security.js';
import type { GatewayConfig, Provider } from '../part/types.js';

const providers = new Set<Provider>([
  'standard',
  'github',
  'stripe',
  'slack',
  'telegram',
  'generic-hmac-sha256',
  'none'
]);
const methods = new Set(['POST', 'PUT', 'PATCH']);
const payloadModes = new Set(['raw', 'json', 'cloudevents']);
const successModes = new Set(['status_only', 'status_and_header']);
const unknownPolicies = new Set(['retry_then_dead', 'dead_immediately', 'treat_2xx_as_delivered']);
const httpTokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reservedDestinationHeaders = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'content-type',
  'x-gace-event-id',
  'x-gace-delivery-id',
  'x-gace-provider',
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature'
]);

export function loadGatewayConfig(): GatewayConfig {
  const file = path.resolve(process.cwd(), 'config/webhooks.json');
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as GatewayConfig;
}

export function validateGatewayConfig(config: GatewayConfig): void {
  if (!Array.isArray(config.sources)) throw new Error('config.sources must be an array');
  if (!Array.isArray(config.destinations)) throw new Error('config.destinations must be an array');
  if (!Array.isArray(config.routes)) throw new Error('config.routes must be an array');

  const sourceIds = new Set<string>();
  const sourceSlugs = new Set<string>();
  const destinationIds = new Set<string>();
  const routeIds = new Set<string>();

  validateAllowlist('ADMIN_ALLOWED_CIDRS', splitAllowlist(env.ADMIN_ALLOWED_CIDRS));
  validateProductionValue('ADMIN_TOKEN', env.ADMIN_TOKEN, { minLength: 32 });
  if (env.LOG_TO_TGSERVER && env.TGSERVER_LOG_URL) {
    validateProductionValue('TGSERVER_LOG_SECRET', env.TGSERVER_LOG_SECRET, { minLength: 16 });
  }

  if (env.NODE_ENV === 'production' && env.SPOOL_STORAGE_MODE === 'plain_dev') {
    throw new Error('SPOOL_STORAGE_MODE=plain_dev is forbidden in production');
  }
  if (env.SPOOL_STORAGE_MODE === 'encrypted_file') {
    validateProductionValue('SPOOL_ENCRYPTION_KEY', env.SPOOL_ENCRYPTION_KEY, { minLength: 32 });
    validateProductionValue('SPOOL_HMAC_KEY', env.SPOOL_HMAC_KEY, { minLength: 32 });
    if (decodeSecret(env.SPOOL_ENCRYPTION_KEY).length !== 32) {
      throw new Error('SPOOL_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
    if (decodeSecret(env.SPOOL_HMAC_KEY).length < 32) {
      throw new Error('SPOOL_HMAC_KEY must decode to at least 32 bytes');
    }
  }

  for (const source of config.sources) {
    if (!source.id || !source.slug || !source.provider) throw new Error(`Invalid source config: ${source.id}`);
    if (!providers.has(source.provider)) throw new Error(`source ${source.id} has unsupported provider ${String(source.provider)}`);
    if (typeof source.enabled !== 'boolean') throw new Error(`source ${source.id} enabled must be boolean`);
    addUnique(sourceIds, source.id, 'source id');
    addUnique(sourceSlugs, source.slug, 'source slug');
    if (source.allowedCidrs !== undefined && !Array.isArray(source.allowedCidrs)) {
      throw new Error(`source ${source.id} allowedCidrs must be an array`);
    }
    validateAllowlist(`source ${source.id} allowedCidrs`, source.allowedCidrs ?? []);
    if (source.provider === 'none' && env.NODE_ENV === 'production') {
      throw new Error('provider=none is forbidden in production');
    }
    if (source.provider !== 'none') {
      if (!source.secretEnv) throw new Error(`source ${source.id} missing secretEnv`);
      const secret = optionalEnv(source.secretEnv);
      if (!secret) throw new Error(`source ${source.id} secretEnv ${source.secretEnv} is missing or empty`);
      validateProductionValue(source.secretEnv, secret, { minLength: 8 });
    }
    if (source.secondarySecretEnv) {
      const secondary = optionalEnv(source.secondarySecretEnv);
      if (!secondary) throw new Error(`source ${source.id} secondarySecretEnv ${source.secondarySecretEnv} is missing or empty`);
      validateProductionValue(source.secondarySecretEnv, secondary, { minLength: 8 });
    }
  }

  for (const destination of config.destinations) {
    if (!destination.id || !destination.urlEnv) throw new Error(`Invalid destination config: ${destination.id}`);
    if (!methods.has(destination.method)) throw new Error(`destination ${destination.id} has unsupported method ${String(destination.method)}`);
    if (!payloadModes.has(destination.payloadMode)) throw new Error(`destination ${destination.id} has unsupported payloadMode ${String(destination.payloadMode)}`);
    if (destination.successMode && !successModes.has(destination.successMode)) {
      throw new Error(`destination ${destination.id} has unsupported successMode ${String(destination.successMode)}`);
    }
    if (destination.unknownPolicy && !unknownPolicies.has(destination.unknownPolicy)) {
      throw new Error(`destination ${destination.id} has unsupported unknownPolicy ${String(destination.unknownPolicy)}`);
    }
    if (typeof destination.enabled !== 'boolean') throw new Error(`destination ${destination.id} enabled must be boolean`);
    addUnique(destinationIds, destination.id, 'destination id');
    const url = optionalEnv(destination.urlEnv);
    if (!url) throw new Error(`destination ${destination.id} urlEnv ${destination.urlEnv} is missing or empty`);
    validateProductionValue(destination.urlEnv, url, { minLength: 8 });
    validateDestinationUrl(url, { allowPrivateNetwork: destination.allowPrivateNetwork === true });
    if (destination.signingSecretEnv) {
      const signingSecret = optionalEnv(destination.signingSecretEnv);
      if (!signingSecret) throw new Error(`destination ${destination.id} signingSecretEnv ${destination.signingSecretEnv} is missing or empty`);
      validateProductionValue(destination.signingSecretEnv, signingSecret, { minLength: 16 });
    }
    if (!Number.isInteger(destination.maxAttempts) || destination.maxAttempts < 1) {
      throw new Error(`destination ${destination.id} maxAttempts must be an integer >= 1`);
    }
    if (destination.timeoutMs !== undefined && (!Number.isInteger(destination.timeoutMs) || destination.timeoutMs < 1)) {
      throw new Error(`destination ${destination.id} timeoutMs must be an integer >= 1`);
    }
    const timeoutMs = destination.timeoutMs ?? env.DELIVERY_TIMEOUT_MS;
    if (timeoutMs + 5_000 >= env.DELIVERY_LEASE_SECONDS * 1000) {
      throw new Error(`destination ${destination.id} timeoutMs must remain at least 5000ms below DELIVERY_LEASE_SECONDS`);
    }
    if (destination.circuitBreaker !== undefined) {
      const threshold = destination.circuitBreaker.failureThreshold;
      const openSeconds = destination.circuitBreaker.openSeconds;
      if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1)) {
        throw new Error(`destination ${destination.id} circuitBreaker.failureThreshold must be an integer >= 1`);
      }
      if (openSeconds !== undefined && (!Number.isInteger(openSeconds) || openSeconds < 1)) {
        throw new Error(`destination ${destination.id} circuitBreaker.openSeconds must be an integer >= 1`);
      }
    }
    validateDestinationHeaders(destination.id, destination.headers);
    if (destination.successMode === 'status_and_header') {
      if (!destination.acceptedHeader || !destination.acceptedHeaderValue) {
        throw new Error(`destination ${destination.id} status_and_header requires acceptedHeader and acceptedHeaderValue`);
      }
      validateHeaderName(`destination ${destination.id} acceptedHeader`, destination.acceptedHeader);
      validateHeaderValue(`destination ${destination.id} acceptedHeaderValue`, destination.acceptedHeaderValue);
    }
  }

  for (const route of config.routes) {
    if (!route.id) throw new Error('route missing id');
    if (typeof route.enabled !== 'boolean') throw new Error(`route ${route.id} enabled must be boolean`);
    addUnique(routeIds, route.id, 'route id');
    if (!sourceIds.has(route.sourceId)) throw new Error(`route ${route.id} references missing source ${route.sourceId}`);
    if (!destinationIds.has(route.destinationId)) throw new Error(`route ${route.id} references missing destination ${route.destinationId}`);
    if (!route.eventTypePattern) throw new Error(`route ${route.id} missing eventTypePattern`);
  }
}

function addUnique(seen: Set<string>, value: string, label: string): void {
  if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
  seen.add(value);
}

function validateAllowlist(label: string, rules: string[]): void {
  for (const rule of rules) {
    if (!isValidAllowlistRule(rule)) throw new Error(`Invalid ${label} rule: ${rule}`);
  }
}

function validateDestinationHeaders(destinationId: string, headers: unknown): void {
  if (headers === undefined) return;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error(`destination ${destinationId} headers must be an object`);
  }
  for (const [name, value] of Object.entries(headers)) {
    validateHeaderName(`destination ${destinationId} header`, name);
    if (reservedDestinationHeaders.has(name.toLowerCase())) {
      throw new Error(`destination ${destinationId} header ${name} is reserved`);
    }
    if (typeof value !== 'string') {
      throw new Error(`destination ${destinationId} header ${name} value must be a string`);
    }
    validateHeaderValue(`destination ${destinationId} header ${name}`, value);
  }
}

function validateHeaderName(label: string, value: string): void {
  if (!httpTokenPattern.test(value)) throw new Error(`${label} is not a valid HTTP header name`);
}

function validateHeaderValue(label: string, value: string): void {
  const containsCarriageReturn = value.includes(String.fromCharCode(13));
  const containsLineFeed = value.includes(String.fromCharCode(10));
  if (containsCarriageReturn || containsLineFeed) {
    throw new Error(`${label} must not contain CR or LF`);
  }
}

function validateProductionValue(label: string, value: string, options: { minLength: number }): void {
  if (env.NODE_ENV !== 'production') return;
  if (value.length < options.minLength) throw new Error(`${label} is too short for production`);
  if (/replace_with|example\.com|example-app|webhook_password/i.test(value)) {
    throw new Error(`${label} contains a placeholder value`);
  }
}
