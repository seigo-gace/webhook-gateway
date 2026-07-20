# G-ACE Universal Webhook Gateway v2.0.1

Production-grade inbound webhook gateway for receiving third-party webhooks, verifying provider signatures against the exact raw body, persisting events and delivery intent durably, dispatching asynchronously, recovering from infrastructure failures, and auditing operator replay.

## Purpose

Applications do not receive public provider webhooks directly. The gateway is the shared inbound safety boundary for G-ACE services, TGServer, billing handlers, bots, and other internal applications.

```text
Provider
  -> /ingress/:slug
  -> source/IP/rate/signature validation
  -> PostgreSQL transaction: Event + Delivery + Delivery Outbox
  -> 202 Accepted
  -> Redis/BullMQ transport
  -> leased Delivery Worker
  -> DNS-pinned internal destination
```

## P0 guarantees retained and integrated

- Provider-specific signature verification occurs before payload trust or JSON use.
- Stable provider event IDs are required for deduplication; unusable signed events are rejected.
- PostgreSQL is the source of truth. Redis/BullMQ is delivery transport only.
- `202` is returned only after Event, Delivery, and transactional Outbox rows commit atomically.
- Immediate Redis enqueue is best effort and never required for provider acknowledgement.
- Redis failure keeps ingress available; `/readyz` reports delivery transport as degraded.
- If PostgreSQL fails but emergency spool succeeds, the provider still receives `202`.
- If PostgreSQL and emergency spool both fail, the provider receives `503` and can retry.
- Recovery reconciles incomplete spool imports, including an existing Event with missing Delivery/Outbox rows.
- Delivery workers use PostgreSQL lease tokens so duplicate jobs cannot dispatch the same active delivery concurrently.
- Delivery remains at-least-once across process crashes; downstream idempotency remains mandatory.
- Replay cooldown acquisition is atomic and every replay decision is audited.
- Admin API is read-only plus replay; runtime config and secrets cannot be mutated through Admin endpoints.
- Raw bodies are not stored by default and are removed by retention when enabled.

## Runtime capabilities

### Ingress security

- GitHub, Stripe, Slack, Telegram, Standard Webhooks, and configurable HMAC-SHA256 verification.
- Exact raw-body verification with primary and secondary secrets for rotation.
- Source IP allowlists and Admin IP allowlists.
- Redis-backed provider/IP rate limiting with a bounded in-memory fallback.
- Deterministic CloudEvents normalization and provider-event deduplication.

### Durable persistence and recovery

- Atomic Event + Delivery + Delivery Outbox transaction.
- Outbox claims use PostgreSQL `FOR UPDATE SKIP LOCKED` and leases.
- Emergency spool supports `encrypted_file` using AES-256-GCM plus HMAC-SHA256.
- Spool writes use temporary files and atomic rename.
- Recovery classifies `success`, `duplicate`, `corrupted`, `db_error`, and locked/skipped work.
- Corrupted spool files move to `/spool/failed`; retention removes expired failed files.

### Delivery safety

- Atomic delivery lease and attempt accounting.
- DNS resolution validation and IP pinning to prevent DNS rebinding between validation and connection.
- Private, local, reserved, and non-routable addresses are blocked unless the destination explicitly allows a private network.
- Redirect following is disabled.
- Redis circuit breaker with a single half-open probe.
- `Retry-After` support, bounded exponential backoff, 410 stop policy, configurable client-error retry, and explicit unknown outcomes.
- Downstream response bodies are bounded and truncated without converting a successful 2xx into a false retry.
- Optional outbound Standard Webhooks signature headers.

## Five-stage modular structure

The existing Server Core structure is preserved:

```text
Part -> Feature -> Component -> System -> Application
```

```text
src/part        primitives and pure policies
src/feature     infrastructure-facing capabilities
src/component   reusable orchestration logic
src/system      API and worker runtime systems
src/application thin application launchers
```

`src/server.ts` and `src/worker.ts` remain thin entrypoints. Detailed mapping is in `docs/SERVER_CORE_ALIGNMENT.md`.

## HTTP endpoints

```text
POST /ingress/:slug
GET  /healthz
GET  /readyz
GET  /metrics
GET  /admin/events
GET  /admin/events/:id
POST /admin/events/:id/replay
POST /admin/deliveries/:id/replay
GET  /admin/audit-logs
```

Keep `/admin/*`, `/metrics`, and `/readyz` private.

## Quick start

```bash
cp .env.example .env
# Replace every placeholder and configure destinations before production use.
npm ci
npm run typecheck
npm run test:ci
npm run build
docker compose config --quiet
docker compose up -d --build
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

Production startup rejects placeholder secrets/URLs, weak Admin tokens, malformed runtime config, unsafe destination settings, invalid encrypted-spool keys, and `SPOOL_STORAGE_MODE=plain_dev`.

## Validation

GitHub Actions validates the same deployable branch with:

```text
npm ci
TypeScript strict typecheck
unit and static architecture/security tests
real PostgreSQL integration and concurrency tests
real Redis/BullMQ integration tests
real HTTP ingress and downstream delivery E2E tests
production JavaScript build
production Docker image build
Docker Compose model validation
npm audit --audit-level=high
```

The suite includes signature rejection, durable ACK order, deduplication, transaction rollback, concurrent lease races, outbox `SKIP LOCKED`, atomic replay cooldown, Redis degradation, encrypted-spool tamper detection, partial spool reconciliation, retry classification, 410 stop handling, and oversized response truncation.

No throughput or latency result is claimed until a repeatable benchmark is executed in the target deployment environment.

## Production checklist

- Generate unique high-entropy secrets; do not reuse inbound, outbound, Admin, DB, TGServer, or spool keys.
- Use `SPOOL_STORAGE_MODE=encrypted_file` or an encrypted host volume.
- Keep `/spool` private to API/worker containers and back it up according to recovery requirements.
- Set `ADMIN_ALLOWED_CIDRS` and source `allowedCidrs` where stable provider ranges exist.
- Confirm destination `allowPrivateNetwork` is enabled only for intended internal targets.
- Ensure each destination timeout remains safely below `DELIVERY_LEASE_SECONDS`.
- Confirm downstream idempotency using `x-gace-event-id`, `x-gace-delivery-id`, or CloudEvent extensions.
- Monitor PostgreSQL, Redis degradation, dead/unknown deliveries, spool growth, clock skew, and TGServer log drops.
- Exercise Redis down, PostgreSQL down, worker termination, downstream timeout, corrupted spool, and unavailable spool volume before production release.

## Documentation

- `docs/ARCHITECTURE.md`
- `docs/OPERATIONS.md`
- `docs/SECURITY.md`
- `docs/SERVER_CORE_ALIGNMENT.md`

## License

MIT
