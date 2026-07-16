# Server Core Alignment — Five-Stage Modular Architecture

This repository follows the Server Core five-stage modular architecture.

```text
Part -> Feature -> Component -> System -> Application
```

## Layer mapping

### 1. Part

Path: `src/part/`

Small reusable primitives with one responsibility. Parts do not know about webhook business flow.

Examples:

- `env.ts` — environment parsing
- `crypto.ts` — cryptographic primitives
- `sanitize.ts` — redaction primitives
- `rateLimit.ts` — fixed-window limiter primitive
- `clock.ts` — clock-skew measurement primitive
- `metrics.ts` — metrics primitives
- `types.ts` — shared type contracts

### 2. Feature

Path: `src/feature/`

A feature is a reusable capability built from Parts.

Examples:

- `verifiers.ts` — provider signature verification feature
- `db.ts` — event/delivery/audit ledger feature
- `queue.ts` — BullMQ queue feature
- `spool.ts` — emergency spool feature
- `config.ts` — config loading and validation feature

### 3. Component

Path: `src/component/`

A component combines features into a bounded operational unit without owning process lifecycle.

Examples:

- `routing.ts` — route selection component
- `delivery.ts` — delivery evaluation/backoff/payload component

### 4. System

Path: `src/system/`

A system assembles components and features into a runnable runtime boundary.

Examples:

- `api-system.ts` — ingress/admin/metrics HTTP system
- `worker-system.ts` — delivery/recovery worker system

### 5. Application

Path: `src/application/` and root entrypoints.

Application files are thin launchers. They do not contain domain logic.

Examples:

- `src/application/api.ts`
- `src/application/worker.ts`
- `src/server.ts`
- `src/worker.ts`

## Rules

1. Lower layers must not import higher layers.
2. Application files must stay thin.
3. System files may orchestrate but must not become a dumping ground for primitives.
4. Reusable logic must move down to Component, Feature, or Part.
5. Do not create future-empty folders or placeholder files.
6. Do not split a one-responsibility file merely to increase file count.
7. Keep Postgres as the source of truth and Redis/BullMQ as delivery transport only.
8. Do not weaken v1.2.2 hardening while restructuring.

## Import direction

```text
Application -> System -> Component -> Feature -> Part
```

Feature may import Part.
Component may import Feature and Part.
System may import Component, Feature, and Part.
Part must not import Feature, Component, System, or Application.

## Validation status

After this restructuring, the following checks must pass:

```text
npm install --no-audit --no-fund
npm run build
npm test
npm audit --audit-level=high
```

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
