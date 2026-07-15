# Operations v1.2.2

## Start

```bash
cp .env.example .env
npm install
npm run build
npm test
docker compose up -d --build
```

## Health

```bash
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

## Alerts

Use hysteresis. Do not alert on single-sample spikes.

Required alert ideas:

```promql
up{job="webhook-gateway"} == 0
absent(webhook_ingress_total)
webhook_spool_failed_file_count > 0 for 5m
webhook_clock_skew_seconds > MAX_CLOCK_SKEW_SECONDS * 0.8 for 5m
```

Prometheus itself must be monitored through a separate path. Gateway cannot detect a failed monitoring system by itself.

## Replay safety

Replay cooldown defaults:

- event replay: 300 seconds
- delivery replay: 60 seconds
- max delivery requeue per event replay: 100

Every replay attempt, including rejected attempts, must appear in audit logs.

## TGServer Log Aggregation

Gateway operational logs are aggregated to TGServer through a non-blocking sanitized log sink. The runtime always writes structured console logs and, when `LOG_TO_TGSERVER=true` and `TGSERVER_LOG_URL` is configured, batches sanitized events to TGServer. The log sink never blocks provider `202` responses; if TGServer is unavailable, logs stay in a bounded in-memory queue and are dropped only after `TGSERVER_LOG_QUEUE_LIMIT` is exceeded.

Configuration:

```env
LOG_TO_TGSERVER=true
TGSERVER_LOG_URL=http://tgserver:7374/internal/logs
TGSERVER_LOG_SECRET=replace_with_tgserver_log_secret
TGSERVER_LOG_MIN_LEVEL=info
TGSERVER_LOG_TIMEOUT_MS=1000
TGSERVER_LOG_FLUSH_INTERVAL_MS=2000
TGSERVER_LOG_BATCH_SIZE=50
TGSERVER_LOG_QUEUE_LIMIT=1000
```

Metrics:

```text
webhook_tgserver_log_sent_total
webhook_tgserver_log_flush_failed_total
webhook_tgserver_log_dropped_total
webhook_tgserver_log_queue_size
```

