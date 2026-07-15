# Architecture v1.2.2


## Server Core layer mapping

```text
src/part        = Part primitives
src/feature     = Feature capabilities
src/component   = Component orchestration units
src/system      = Runtime systems
src/application = Application launchers
```

Import direction is one-way:

```text
Application -> System -> Component -> Feature -> Part
```

The root `src/server.ts` and `src/worker.ts` files are only entrypoints and must not contain business logic.

## Core flow

```text
Provider -> API -> signature verification -> PostgreSQL ledger -> Redis/BullMQ -> Worker -> Internal app
```

## Non-negotiable rules

1. Do not parse JSON before provider signature verification.
2. Do not treat Redis as source of truth.
3. Do not wait for downstream delivery before returning 202 to provider.
4. Do not expose Admin API publicly.
5. Do not add Admin config mutation in v1.2.2.
6. Do not store raw body by default.

## Delivery success

`successMode=status_only`: any 2xx response is delivered.

`successMode=status_and_header`: 2xx plus configured accepted header is required. Missing header creates `unknown`; `unknown` is retried with max attempts and then becomes `dead`.

## Replay

Replay works from `cloud_event` and `normalized_payload`, not from `body_text`. `STORE_RAW_BODY=false` must not break replay.

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

