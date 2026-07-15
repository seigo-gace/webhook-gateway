# G-ACE Universal Webhook Gateway

Independent inbound webhook gateway for safely receiving third-party webhooks, verifying provider signatures, storing events durably, queueing downstream delivery, retrying failures, replaying dead deliveries, and auditing operations.

Current hardened design line: **v1.2.2**.

## Purpose

Applications should not receive external webhooks directly. This gateway becomes the shared safety layer in front of internal systems such as G-ACE Core, TGServer, V8 support services, billing handlers, Telegram bots, and future applications.

```text
External Provider -> /ingress/:slug -> Gateway API -> PostgreSQL -> Redis/BullMQ -> Worker -> Internal App
```

## Guarantees

- Provider-specific signature verification before payload trust.
- Raw body is preserved in memory for signature verification.
- PostgreSQL is the source of truth; Redis is only the delivery transport.
- Provider response is fast: Gateway returns `202` after verification and durable event/delivery registration, not after downstream completion.
- Redis enqueue is best-effort with timeout; recovery rebuilds due jobs from PostgreSQL.
- Delivery is at-least-once; downstream idempotency is mandatory.
- Admin API is read-only plus replay only. No config or secret mutation API exists in v1.2.2.
- Spool import classifies `success`, `duplicate`, `corrupted`, and `db_error`.
- Replay API has cooldowns and audit logging.
- Clock skew is reflected in `/readyz`.
- `STORE_RAW_BODY=false` by default; replay relies on normalized payload and CloudEvent, not raw body text.

## Runtime hardening

Containers run as `appuser` with UID/GID `10001:10001`, `no-new-privileges:true`, and `cap_drop: ALL`.

## Spool security

Spool files may contain verified webhook payloads. Production must place `/spool` on an encrypted local volume. `plain_dev` is for development only and is rejected when `NODE_ENV=production`.

`/spool/failed` files are purged after `SPOOL_FAILED_RETENTION_DAYS` and exposed through metrics.

## Performance targets

- Ingress P95: <= 300ms
- Ingress P99: <= 1000ms
- Redis enqueue timeout: 1500ms
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
docker compose up -d --build
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

## CI

CI currently runs:

```text
npm install --no-audit --no-fund
npm run build
npm test
npm audit --audit-level=high
```

`package-lock.json` was generated and validated in the local v1.2.2 ZIP artifact. Add it in the server-side validation pass before switching CI to `npm ci`.

## Production checklist

- Use encrypted volume for `/spool`.
- Keep `/admin/*`, `/metrics`, and `/readyz` private.
- Configure Prometheus absent alerts and monitor Prometheus itself.
- Confirm downstream idempotency using `x-gace-event-id` or CloudEvent `extensions.gatewayEventId`.
- Confirm replay cooldowns before enabling real operators.
- Run failure tests: Redis down, Postgres down, Worker crash, downstream timeout, corrupted spool.

## License

MIT
