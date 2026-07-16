# G-ACE Universal Webhook Gateway

Independent inbound webhook gateway for safely receiving third-party webhooks, verifying provider signatures, storing events durably, queueing downstream delivery, retrying failures, replaying dead deliveries, and auditing operations.

Current hardened design line: **v1.2.2 + Server Core five-stage structure**.

## Purpose

Applications should not receive external webhooks directly. This gateway becomes the shared safety layer in front of internal systems such as G-ACE Core, TGServer, V8 support services, billing handlers, Telegram bots, and future applications.

```text
External Provider -> /ingress/:slug -> Gateway API -> PostgreSQL -> Redis/BullMQ -> Worker -> Internal App
```

## Guarantees

- Provider-specific signature verification before payload trust.
- Stable provider event IDs are required for duplicate suppression; signed events without a usable provider ID are rejected.
- Raw body is preserved in memory for signature verification.
- PostgreSQL is the source of truth; Redis/BullMQ is only the delivery transport.
- Provider response is fast: Gateway returns `202` after verification, durable event storage, and durable delivery-row creation; Redis enqueue is deferred and never required for provider ACK.
- If PostgreSQL is unavailable but emergency spool succeeds, Gateway returns `202` without exposing internal spool paths.
- If both PostgreSQL and emergency spool are unavailable, Gateway returns `503` so the provider can retry.
- Redis enqueue is best-effort; recovery rebuilds due jobs from PostgreSQL.
- Delivery is at-least-once; downstream idempotency is mandatory.
- Worker dispatch claims deliveries atomically so stale duplicate jobs cannot re-deliver `dead`, `skipped`, or already-claimed rows.
- Admin API is read-only plus replay only. No config or secret mutation API exists in v1.2.2.
- Admin and source IP allowlists are enforced when configured.
- Spool import classifies `success`, `duplicate`, `corrupted`, and `db_error`.
- Replay API has cooldowns and audit logging.
- Clock skew is reflected in `/readyz`.
- `STORE_RAW_BODY=false` by default; replay relies on normalized payload and CloudEvent. Raw delivery can rebuild from normalized `base64` payload when available.
- If raw bodies are stored, expired `body_text` is purged according to `BODY_RETENTION_DAYS` during worker recovery sweeps.

## Server Core five-stage structure

The code is organized by the Server Core five-stage modular architecture:

```text
Part -> Feature -> Component -> System -> Application
```

Layer mapping is documented in `docs/SERVER_CORE_ALIGNMENT.md`. Runtime entrypoints remain `src/server.ts` and `src/worker.ts`, but they are thin Application launchers only.

## Runtime hardening

Containers run as `appuser` with UID/GID `10001:10001`, `no-new-privileges:true`, and `cap_drop: ALL`.

## Spool security

Spool files may contain verified webhook payloads. Production must place `/spool` on an encrypted local volume. `plain_dev` is for development only and is rejected when `NODE_ENV=production`.

Spool is a recovery ledger, not an operational log. Headers are sanitized before storage, but body and CloudEvent data are preserved so replay/import remains exact. Do not expose `/spool` outside the runtime host.

`/spool/failed` files are purged after `SPOOL_FAILED_RETENTION_DAYS` and exposed through metrics.

## Performance targets

- Ingress P95: <= 300ms
- Ingress P99: <= 1000ms
- Redis enqueue is deferred from provider ACK path
- Worker concurrency: configurable by `WORKER_CONCURRENCY`
- Spool import batch: configurable by `SPOOL_IMPORT_BATCH_SIZE`
- Recovery batch: configurable by `RECOVERY_DELIVERY_BATCH_SIZE`

## Quick start

```bash
cp .env.example .env
npm install
npm run secret
npm run build
npm test
# Before starting with NODE_ENV=production, replace all replace_with_* and example values in .env.
docker compose up -d --build
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

Production startup rejects placeholder secrets, placeholder URLs, short admin tokens, and `SPOOL_STORAGE_MODE=plain_dev`.

## CI

CI runs:

```text
npm install --no-audit --no-fund
npm run build
npm test
npm audit --audit-level=high
```

## Production checklist

- Use encrypted volume for `/spool`.
- Keep `/admin/*`, `/metrics`, and `/readyz` private.
- Replace every `replace_with_*`, `example.com`, `example-app`, and default `webhook_password` value before production startup.
- Set `ADMIN_ALLOWED_CIDRS` when admin endpoints are reachable through a shared network path.
- Set per-source `allowedCidrs` in `config/webhooks.json` when providers publish stable webhook source ranges.
- Configure Prometheus absent alerts and monitor Prometheus itself.
- Confirm downstream idempotency using `x-gace-event-id` or CloudEvent `extensions.gatewayEventId`.
- Confirm replay cooldowns before enabling real operators.
- Confirm providers retry correctly when Gateway returns `503` because both DB and spool are unavailable.
- Run failure tests: Redis down, Postgres down, Worker crash, downstream timeout, corrupted spool, spool volume unavailable.

## License

MIT

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
