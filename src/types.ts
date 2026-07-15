export type Provider =
  | 'standard'
  | 'github'
  | 'stripe'
  | 'slack'
  | 'telegram'
  | 'generic-hmac-sha256'
  | 'none';

export type PayloadMode = 'raw' | 'json' | 'cloudevents';
export type DataMode = 'json_object' | 'base64_raw';
export type SuccessMode = 'status_only' | 'status_and_header';
export type UnknownPolicy = 'retry_then_dead' | 'dead_immediately' | 'treat_2xx_as_delivered';
export type DeliveryStatus = 'queued' | 'delivering' | 'delivered' | 'retrying' | 'unknown' | 'dead' | 'skipped';

export interface SourceConfig {
  id: string;
  appId: string;
  name: string;
  slug: string;
  provider: Provider;
  secretEnv?: string;
  secondarySecretEnv?: string;
  toleranceSeconds?: number;
  enabled: boolean;
  allowedCidrs?: string[];
  generic?: GenericHmacConfig;
}

export interface GenericHmacConfig {
  signatureHeader: string;
  timestampHeader?: string;
  idHeader?: string;
  eventTypeHeader?: string;
  signatureEncoding: 'hex' | 'base64';
  signaturePrefix?: string;
  signedContent: 'body' | 'timestamp.body';
}

export interface DestinationConfig {
  id: string;
  appId: string;
  name: string;
  urlEnv: string;
  method: 'POST' | 'PUT' | 'PATCH';
  payloadMode: PayloadMode;
  dataMode?: DataMode;
  successMode?: SuccessMode;
  acceptedHeader?: string;
  acceptedHeaderValue?: string;
  unknownPolicy?: UnknownPolicy;
  signingSecretEnv?: string;
  timeoutMs?: number;
  maxAttempts: number;
  enabled: boolean;
  headers?: Record<string, string>;
}

export interface RouteConfig {
  id: string;
  sourceId: string;
  destinationId: string;
  eventTypePattern: string;
  enabled: boolean;
}

export interface GatewayConfig {
  sources: SourceConfig[];
  destinations: DestinationConfig[];
  routes: RouteConfig[];
}

export type VerificationResult =
  | {
      ok: true;
      providerEventId: string;
      eventType: string;
      timestamp?: number;
      parsedJson?: unknown;
    }
  | {
      ok: false;
      reason: string;
      statusCode: number;
    };
