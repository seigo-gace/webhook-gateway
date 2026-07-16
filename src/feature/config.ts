import fs from 'node:fs';
import path from 'node:path';
import { env, optionalEnv } from '../part/env.js';
import { isValidAllowlistRule, splitAllowlist } from '../part/ip-allowlist.js';
import type { GatewayConfig } from '../part/types.js';

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

  for (const source of config.sources) {
    if (!source.id || !source.slug || !source.provider) throw new Error(`Invalid source config: ${source.id}`);
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
    addUnique(destinationIds, destination.id, 'destination id');
    const url = optionalEnv(destination.urlEnv);
    if (!url) throw new Error(`destination ${destination.id} urlEnv ${destination.urlEnv} is missing or empty`);
    validateProductionValue(destination.urlEnv, url, { minLength: 8 });
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
    if (destination.headers !== undefined && (typeof destination.headers !== 'object' || destination.headers === null || Array.isArray(destination.headers))) {
      throw new Error(`destination ${destination.id} headers must be an object`);
    }
    if (destination.successMode === 'status_and_header') {
      if (!destination.acceptedHeader || !destination.acceptedHeaderValue) {
        throw new Error(`destination ${destination.id} status_and_header requires acceptedHeader and acceptedHeaderValue`);
      }
    }
  }

  for (const route of config.routes) {
    if (!route.id) throw new Error('route missing id');
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

function validateProductionValue(label: string, value: string, options: { minLength: number }): void {
  if (env.NODE_ENV !== 'production') return;
  if (value.length < options.minLength) throw new Error(`${label} is too short for production`);
  if (/replace_with|example\.com|example-app|webhook_password/i.test(value)) {
    throw new Error(`${label} contains a placeholder value`);
  }
}
