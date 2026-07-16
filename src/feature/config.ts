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
  const sourceIds = new Set<string>();
  const sourceSlugs = new Set<string>();
  const destinationIds = new Set<string>();
  const routeIds = new Set<string>();

  validateAllowlist('ADMIN_ALLOWED_CIDRS', splitAllowlist(env.ADMIN_ALLOWED_CIDRS));

  if (env.NODE_ENV === 'production' && env.SPOOL_STORAGE_MODE === 'plain_dev') {
    throw new Error('SPOOL_STORAGE_MODE=plain_dev is forbidden in production');
  }

  for (const source of config.sources) {
    if (!source.id || !source.slug || !source.provider) throw new Error(`Invalid source config: ${source.id}`);
    addUnique(sourceIds, source.id, 'source id');
    addUnique(sourceSlugs, source.slug, 'source slug');
    validateAllowlist(`source ${source.id} allowedCidrs`, source.allowedCidrs ?? []);
    if (source.provider === 'none' && env.NODE_ENV === 'production') {
      throw new Error('provider=none is forbidden in production');
    }
    if (source.provider !== 'none') {
      if (!source.secretEnv) throw new Error(`source ${source.id} missing secretEnv`);
      if (!optionalEnv(source.secretEnv)) throw new Error(`source ${source.id} secretEnv ${source.secretEnv} is missing or empty`);
    }
    if (source.secondarySecretEnv && !optionalEnv(source.secondarySecretEnv)) {
      throw new Error(`source ${source.id} secondarySecretEnv ${source.secondarySecretEnv} is missing or empty`);
    }
  }

  for (const destination of config.destinations) {
    if (!destination.id || !destination.urlEnv) throw new Error(`Invalid destination config: ${destination.id}`);
    addUnique(destinationIds, destination.id, 'destination id');
    if (!optionalEnv(destination.urlEnv)) throw new Error(`destination ${destination.id} urlEnv ${destination.urlEnv} is missing or empty`);
    if (destination.signingSecretEnv && !optionalEnv(destination.signingSecretEnv)) {
      throw new Error(`destination ${destination.id} signingSecretEnv ${destination.signingSecretEnv} is missing or empty`);
    }
    if (destination.maxAttempts < 1) throw new Error(`destination ${destination.id} maxAttempts must be >= 1`);
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
