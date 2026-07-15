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
