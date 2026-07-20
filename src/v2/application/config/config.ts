export interface GatewayConfig {
  nodeEnv: string;
  rateLimitEnabled: boolean;
}

export function loadConfig(): GatewayConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== "false"
  };
}
