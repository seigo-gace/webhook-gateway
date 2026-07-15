import fs from 'node:fs';
import path from 'node:path';
import type { GatewayConfig } from './types.js';

export function loadGatewayConfig(): GatewayConfig {
  const file = path.resolve(process.cwd(), 'config/webhooks.json');
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as GatewayConfig;
}
