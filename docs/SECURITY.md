# Security v1.2.2

## Spool payloads

Spool files can contain sensitive verified payloads. Production requires encrypted local storage for `/spool`. Do not use NFS/SMB for spool locking.

## Logs and persistence

`last_error`, `audit_logs.details`, metrics labels, admin responses, and spool metadata must pass sanitization before persistence or exposure.

## Admin API

Admin API is read-only plus replay only. Replay is rate limited and always audited. Config/secret mutation is intentionally excluded.

## Clock skew

`/readyz` must include clock skew status. If required clock skew checks fail, readiness fails.

## Dependency safety

Use exact dependency versions, commit `package-lock.json`, use `npm ci`, and run `npm audit --audit-level=high` in CI.

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

