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
});
