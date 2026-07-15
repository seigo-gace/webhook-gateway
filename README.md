# G-ACE Universal Webhook Gateway

Independent inbound webhook gateway for safely receiving third-party webhooks, verifying provider signatures, storing events durably, queueing downstream delivery, retrying failures, replaying dead deliveries, and auditing operations.

This repository is the source implementation for the hardened **v1.1.1** line.

## Purpose

Applications should not receive external webhooks directly. This gateway becomes the shared safety layer in front of internal systems such as G-ACE Core, TGServer, V8 support services, billing handlers, Telegram bots, and any future application.

```text
External Provider
  -> POST /ingress/:slug
  -> Webhook Gateway API
  -> Postgres durable ledger
  -> Redis / BullMQ delivery queue
  -> Webhook Gateway Worker
  -> Internal Applications
```

## Core guarantees

- Provider-specific signature verification before payload trust.
- Raw body preservation for signature-sensitive providers.
- Timestamp tolerance for replay protection where supported.
- Durable event and delivery records in PostgreSQL.
- Redis/BullMQ used as a transport queue, not as the source of truth.
- Automatic retry with dead-state handling and replay APIs.
- Internal downstream delivery signed separately using Standard Webhooks-style headers.
- Emergency spool fallback for verified events when the database write path is unavailable.
- Recovery sweeper for queued/retrying rows and stale `delivering` rows.
- At-least-once delivery with explicit downstream idempotency requirements.

## Supported inbound providers

| Provider | Ingress example | Verification |
|---|---|---|
| Standard Webhooks | `/ingress/standard-demo` | `webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 |
| GitHub | `/ingress/github-main` | `X-Hub-Signature-256`; HMAC-SHA256 over raw body |
| Stripe | `/ingress/stripe-payments` | `Stripe-Signature`; timestamp + raw body HMAC |
| Slack | `/ingress/slack-events` | `X-Slack-Signature`, `X-Slack-Request-Timestamp`; `v0:timestamp:body` |
| Telegram | `/ingress/telegram-bot` | `X-Telegram-Bot-Api-Secret-Token` equality check |
| Generic HMAC | `/ingress/generic-hmac` | Configurable HMAC-SHA256 headers and signed content |
| none | development only | No production use |

## Repository layout

```text
config/webhooks.json                 Provider, destination, and route definitions
docs/ARCHITECTURE.md                 System architecture and failure model
docs/OPERATIONS.md                   Deployment and runbook commands
docs/SECURITY.md                     Security rules and runtime hardening
docs/IMPLEMENTATION_NOTES.md         Design decisions and extension notes
docs/APP_RECEIVER_EXAMPLE.md         Downstream receiver contract example
scripts/nginx-webhook-gateway.conf   Example reverse proxy config
scripts/smoke-test.sh                Basic smoke-test helper
src/server.ts                        Ingress API, admin API, metrics
src/worker.ts                        Delivery worker and retry handling
src/recovery.ts                      Redis recovery, spool import, stale reset
src/spool.ts                         Emergency file spool
src/verifiers.ts                     Provider-specific signature verification
src/db.ts                            PostgreSQL schema bootstrap
test/verifiers.test.ts               Signature verification test suite
```

## Quick start

```bash
cp .env.example .env
npm install
npm run secret
# Put generated secrets into .env.

docker compose up -d --build
```

Health checks:

```bash
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

Admin API example:

```bash
curl -H "x-admin-token: <ADMIN_TOKEN>" \
  "http://127.0.0.1:7373/admin/events?limit=20"
```

## Configuration

Routes are defined in `config/webhooks.json`.

- `apps`: logical application owners
- `sources`: public inbound webhook definitions
- `destinations`: internal downstream endpoints
- `routes`: source-to-destination routing rules

Secrets are **not** stored in `config/webhooks.json`. The config stores environment variable names such as `INBOUND_GITHUB_MAIN_SECRET`; the actual values belong in `.env` or a production secret manager.

## Main endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/ingress/:slug` | Public webhook ingress |
| `GET` | `/healthz` | Process health check |
| `GET` | `/readyz` | Database readiness check |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/admin/events` | List stored events |
| `GET` | `/admin/events/:id` | Event detail and deliveries |
| `POST` | `/admin/events/:id/replay` | Replay all deliveries for an event |
| `POST` | `/admin/deliveries/:id/replay` | Replay one delivery |
| `GET` | `/admin/audit-logs` | Administrative operation audit log |
| `GET` | `/admin/queues` | Optional Bull Board UI |

Admin endpoints require `x-admin-token`. In production, keep `/admin/*` private behind IP allowlisting, VPN, Cloudflare Access, or equivalent controls.

## Runtime hardening in v1.1.1

The API and worker containers run as a dedicated non-privileged user.

```text
user: appuser
uid: 10001
gid: 10001
```

`docker-compose.yml` also applies:

```yaml
user: "10001:10001"
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

`/spool` remains writable by `appuser` because verified events are written there when the database path is unavailable after signature verification.

## Failure handling

### Downstream application is down

Delivery moves to `retrying` with exponential backoff. After the configured maximum attempts, it becomes `dead`. The event or delivery can be replayed through the Admin API.

### Redis enqueue fails

The delivery row has already been created in Postgres. The recovery sweeper later re-enqueues due `queued` or `retrying` deliveries.

### Worker crashes mid-delivery

A `delivering` row older than `STALE_DELIVERING_SECONDS` is reset to `retrying`.

### Database write fails after signature verification

When `ENABLE_EMERGENCY_SPOOL=true`, the verified webhook is written atomically to `/spool/*.json`. The worker imports spool files after database recovery.

### VPS, DNS, or network is unreachable

If the provider cannot reach the gateway at all, the gateway cannot store that request. Use provider retry, provider delivery history, reverse-proxy logs, and HA deployment for critical systems.

## At-least-once delivery contract

The gateway prioritizes not losing events. Downstream applications may receive duplicates and must dedupe by one of the following:

- `x-gace-event-id`
- `x-gace-delivery-id`
- CloudEvent `extensions.gatewayEventId`
- Provider event ID, when available

See `docs/APP_RECEIVER_EXAMPLE.md` for a receiver sketch.

## Development commands

```bash
npm ci
npm run build
npm test
npm run dev:api
npm run dev:worker
```

## Verified checks

Current v1.1.1 local validation:

```text
npm ci        -> success, 0 vulnerabilities
npm test      -> 9 tests passed
npm run build -> TypeScript compile passed
```

Covered verifier tests:

- GitHub valid HMAC-SHA256
- GitHub invalid HMAC-SHA256
- Standard Webhooks valid HMAC-SHA256
- Standard Webhooks expired timestamp / replay protection
- Stripe valid signature
- Stripe expired timestamp / replay protection
- Slack valid signature
- Telegram secret token
- Generic HMAC timestamp.body signature

## Remaining production-hardening tests

- Docker Compose E2E
- Postgres stop -> emergency spool -> database recovery -> import
- Redis stop -> queued delivery retention -> recovery re-enqueue
- Worker crash -> stale `delivering` recovery
- Downstream idempotency receiver E2E
- Real provider webhook delivery tests

## Production checklist

- Replace every example secret in `.env`.
- Keep API binding as `127.0.0.1:7373` and terminate HTTPS with Nginx, Caddy, Cloudflare Tunnel, or equivalent.
- Keep Admin API private.
- Configure Postgres backup and restore checks.
- Monitor `dead` delivery count.
- Monitor `/spool` file count and volume capacity.
- Confirm each downstream app verifies gateway signatures.
- Confirm each downstream app implements idempotency.

## License

MIT
