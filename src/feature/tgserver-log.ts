import { env } from '../part/env.js';
import { sanitizeObject, sanitizeText } from '../part/sanitize.js';
import { logLevelRank, type GatewayLogEvent, type LogLevel } from '../part/logging-types.js';
import { tgserverLogDroppedCounter, tgserverLogFlushFailedCounter, tgserverLogQueueGauge, tgserverLogSentCounter } from '../part/metrics.js';

interface BufferedLog extends GatewayLogEvent {
  createdAt: string;
}

export class TgServerLogSink {
  private readonly queue: BufferedLog[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  start(): void {
    if (!env.LOG_TO_TGSERVER || !env.TGSERVER_LOG_URL) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, env.TGSERVER_LOG_FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  log(input: GatewayLogEvent): void {
    writeConsoleLog(input);
    if (!env.LOG_TO_TGSERVER || !env.TGSERVER_LOG_URL) return;
    if (!shouldForward(input.level)) return;
    if (this.queue.length >= env.TGSERVER_LOG_QUEUE_LIMIT) {
      this.queue.shift();
      tgserverLogDroppedCounter.inc({ reason: 'queue_full' });
    }
    this.queue.push({
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
      message: sanitizeText(input.message, 1000),
      details: sanitizeObject(input.details ?? null)
    });
    tgserverLogQueueGauge.set(this.queue.length);
    if (this.queue.length >= env.TGSERVER_LOG_BATCH_SIZE) {
      void this.flush().catch(() => undefined);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    if (!env.LOG_TO_TGSERVER || !env.TGSERVER_LOG_URL) return;
    const batch = this.queue.splice(0, env.TGSERVER_LOG_BATCH_SIZE);
    tgserverLogQueueGauge.set(this.queue.length);
    if (batch.length === 0) return;
    this.flushing = true;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-gace-log-source': 'webhook-gateway'
      };
      if (env.TGSERVER_LOG_SECRET) headers['x-gace-log-secret'] = env.TGSERVER_LOG_SECRET;
      const response = await fetch(env.TGSERVER_LOG_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source: 'webhook-gateway', events: batch }),
        signal: AbortSignal.timeout(env.TGSERVER_LOG_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`TGServer log sink returned ${response.status}`);
      tgserverLogSentCounter.inc(batch.length);
    } catch (err) {
      tgserverLogFlushFailedCounter.inc();
      // Preserve recent logs without blocking runtime. Put failed batch back at the front within queue limit.
      this.queue.unshift(...batch);
      while (this.queue.length > env.TGSERVER_LOG_QUEUE_LIMIT) {
        this.queue.pop();
        tgserverLogDroppedCounter.inc({ reason: 'queue_limit_after_failure' });
      }
      tgserverLogQueueGauge.set(this.queue.length);
      writeConsoleLog({
        level: 'warn',
        event: 'tgserver_log_flush_failed',
        component: 'tgserver-log',
        message: 'TGServer log flush failed; logs retained within queue limit',
        details: { error: sanitizeText(err, 300) }
      });
    } finally {
      this.flushing = false;
    }
  }
}

export const tgServerLogSink = new TgServerLogSink();

export function logGatewayEvent(input: GatewayLogEvent): void {
  tgServerLogSink.log(input);
}

function shouldForward(level: LogLevel): boolean {
  const min = normalizeLevel(env.TGSERVER_LOG_MIN_LEVEL);
  return logLevelRank(level) >= logLevelRank(min);
}

function normalizeLevel(value: string): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function writeConsoleLog(input: GatewayLogEvent): void {
  const payload = sanitizeObject({
    ts: input.createdAt ?? new Date().toISOString(),
    level: input.level,
    event: input.event,
    component: input.component,
    message: input.message,
    eventId: input.eventId,
    deliveryId: input.deliveryId,
    sourceId: input.sourceId,
    destinationId: input.destinationId,
    details: input.details ?? null
  });
  const line = JSON.stringify(payload);
  if (input.level === 'error') console.error(line);
  else if (input.level === 'warn') console.warn(line);
  else console.log(line);
}
