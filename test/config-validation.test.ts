import { describe, expect, it } from 'vitest';
import { loadGatewayConfig, validateGatewayConfig } from '../src/feature/config.js';
import type { GatewayConfig } from '../src/part/types.js';

function configCopy(): GatewayConfig {
  return structuredClone(loadGatewayConfig());
}

describe('runtime gateway config validation', () => {
  it('accepts the checked-in production configuration shape under test secrets', () => {
    expect(() => validateGatewayConfig(configCopy())).not.toThrow();
  });

  it('rejects unsupported provider values from untyped JSON', () => {
    const config = configCopy() as any;
    config.sources[0].provider = 'invented-provider';
    expect(() => validateGatewayConfig(config)).toThrow(/unsupported provider/);
  });

  it('rejects unsupported outbound methods from untyped JSON', () => {
    const config = configCopy() as any;
    config.destinations[0].method = 'DELETE';
    expect(() => validateGatewayConfig(config)).toThrow(/unsupported method/);
  });

  it('rejects a delivery timeout that can outlive its delivery lease', () => {
    const config = configCopy();
    config.destinations[0].timeoutMs = 86_000;
    expect(() => validateGatewayConfig(config)).toThrow(/DELIVERY_LEASE_SECONDS/);
  });

  it('rejects non-boolean enabled values from JSON', () => {
    const config = configCopy() as any;
    config.routes[0].enabled = 'yes';
    expect(() => validateGatewayConfig(config)).toThrow(/enabled must be boolean/);
  });

  it('rejects custom headers that can override gateway integrity metadata', () => {
    const config = configCopy();
    config.destinations[0].headers = { 'x-gace-event-id': 'attacker-controlled' };
    expect(() => validateGatewayConfig(config)).toThrow(/reserved/);
  });

  it('rejects hop-by-hop and transport-owned headers', () => {
    const config = configCopy();
    config.destinations[0].headers = { Host: 'internal.example' };
    expect(() => validateGatewayConfig(config)).toThrow(/reserved/);
  });

  it('rejects header injection and non-string values from untyped JSON', () => {
    const injected = configCopy();
    injected.destinations[0].headers = { 'x-safe': 'ok\r\nx-injected: true' };
    expect(() => validateGatewayConfig(injected)).toThrow(/CR or LF/);

    const nonString = configCopy() as any;
    nonString.destinations[0].headers = { 'x-count': 10 };
    expect(() => validateGatewayConfig(nonString)).toThrow(/value must be a string/);
  });

  it('rejects invalid acceptance proof header names and values', () => {
    const invalidName = configCopy();
    invalidName.destinations[0].successMode = 'status_and_header';
    invalidName.destinations[0].acceptedHeader = 'bad header';
    invalidName.destinations[0].acceptedHeaderValue = 'true';
    expect(() => validateGatewayConfig(invalidName)).toThrow(/valid HTTP header name/);

    const invalidValue = configCopy();
    invalidValue.destinations[0].successMode = 'status_and_header';
    invalidValue.destinations[0].acceptedHeader = 'x-accepted';
    invalidValue.destinations[0].acceptedHeaderValue = 'true\nfalse';
    expect(() => validateGatewayConfig(invalidValue)).toThrow(/CR or LF/);
  });
});
