export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface GatewayLogEvent {
  level: LogLevel;
  event: string;
  component: string;
  message: string;
  details?: unknown;
  eventId?: string;
  deliveryId?: string;
  sourceId?: string;
  destinationId?: string;
  createdAt?: string;
}

export function logLevelRank(level: LogLevel): number {
  switch (level) {
    case 'debug': return 10;
    case 'info': return 20;
    case 'warn': return 30;
    case 'error': return 40;
  }
}
