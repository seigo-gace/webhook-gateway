# Webhook Gateway v2.0.1 Operations

## 1. Deployment preparation

```bash
cp .env.example .env
```

Replace every placeholder before production start. Required operational groups include:

- PostgreSQL database/user/password and `DATABASE_URL`
- Redis URL
- Admin token and allowed CIDRs
- inbound provider secrets
- outbound destination secrets and URLs
- TGServer log secret when enabled
- encrypted spool encryption and HMAC keys

Generate independent random values. Do not copy one secret into multiple roles.

Validate locally:

```bash
npm ci
npm run typecheck
npm run test:ci
npm run build
docker compose config --quiet
docker compose build
```

Start:

```bash
docker compose up -d
```

## 2. Service roles

```text
postgres  durable source of truth
redis     queue transport, rate-limit state, circuit-breaker state
api       public webhook ingress and private Admin/metrics/readiness endpoints
worker    outbox publisher, BullMQ consumer, delivery, spool import, recovery, retention
```

API depends on PostgreSQL health, not Redis health. Worker depends on both PostgreSQL and Redis.

## 3. Health and readiness

```bash
curl http://127.0.0.1:7373/healthz
curl http://127.0.0.1:7373/readyz
```

- `/healthz` indicates that the API process is alive.
- `/readyz` returns `503` for a required PostgreSQL or required clock failure.
- Redis failure is reported as degraded asynchronous delivery while ingress remains ready.
- Spool counts are included for operational visibility.

Keep `/readyz`, `/metrics`, and `/admin/*` behind Cloudflare Access, a private network, or equivalent operator-only control.

## 4. Normal ingress behavior

A successful provider request returns `202` after one of these durable paths:

1. PostgreSQL transaction committed Event, Delivery, and Delivery Outbox; or
2. emergency spool file committed after DB failure.

Redis enqueue is asynchronous. A temporary Redis failure can delay delivery but does not invalidate the provider acknowledgement.

## 5. Recovery loops

The worker performs:

- transactional outbox publication;
- expired delivery-lease recovery;
- emergency spool import and reconciliation;
- due delivery re-enqueue;
- expired raw-body purge;
- failed spool retention purge.

Important settings:

```env
OUTBOX_PUBLISH_INTERVAL_MS=500
OUTBOX_BATCH_SIZE=100
OUTBOX_LEASE_SECONDS=30
RECOVERY_INTERVAL_MS=30000
RECOVERY_DELIVERY_BATCH_SIZE=100
STALE_DELIVERING_SECONDS=120
SPOOL_IMPORT_BATCH_SIZE=50
```

Do not reduce leases below the associated HTTP or queue timeout. Startup validation enforces the delivery timeout/lease safety margin.

## 6. Spool operations

Recommended production mode:

```env
SPOOL_STORAGE_MODE=encrypted_file
SPOOL_ENCRYPTION_KEY=base64:<exactly-32-random-bytes>
SPOOL_HMAC_KEY=base64:<at-least-32-random-bytes>
```

Spool paths:

```text
/spool/*.spool          pending encrypted recovery records
/spool/*.spool.importing atomically claimed import records
/spool/failed/*         corrupted or invalid records requiring inspection
```

Never edit or delete pending spool files while API/worker containers are running. Never expose the volume over HTTP or a shared public file service.

When rotating spool keys, drain all pending spool records first or retain the old decryption material in a controlled migration procedure. The runtime currently accepts one active encryption/HMAC key pair.

## 7. Delivery investigation

Use Admin endpoints with token and allowed operator IP:

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  http://127.0.0.1:7373/admin/events?limit=50

curl -H "x-admin-token: $ADMIN_TOKEN" \
  http://127.0.0.1:7373/admin/events/<event-id>
```

Relevant delivery states:

- `queued`: durable and ready for transport
- `delivering`: owned by an active lease
- `retrying`: retryable failure with next attempt time
- `unknown`: receiver may have processed the request; retry policy applies
- `delivered`: proven success
- `dead`: terminal or exhausted failure
- `skipped`: disabled/missing destination or 410 Gone

## 8. Replay

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  http://127.0.0.1:7373/admin/deliveries/<delivery-id>/replay

curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  http://127.0.0.1:7373/admin/events/<event-id>/replay
```

Default safety controls:

- event cooldown: 300 seconds
- delivery cooldown: 60 seconds
- max deliveries per event replay: 100
- API rate limit: 10 replay requests/minute

Every accepted or rate-limited replay is audited. Verify the downstream idempotency contract before replaying an `unknown` delivery.

## 9. Monitoring

Minimum Prometheus alert ideas:

```promql
up{job="webhook-gateway"} == 0
absent(webhook_ingress_total)
webhook_spool_failed_file_count > 0
webhook_spool_file_count > 0
webhook_clock_skew_seconds > 24
increase(webhook_tgserver_log_dropped_total[5m]) > 0
```

Also monitor PostgreSQL connection/space, Redis persistence/latency, container restarts, dead/unknown delivery counts from PostgreSQL, and the encrypted spool volume capacity.

Prometheus itself must be monitored through an independent path.

## 10. Failure drills

Before production release and after significant infrastructure changes, run:

1. Redis unavailable while API accepts and DB commits ingress.
2. Redis restoration and Outbox delivery reconstruction.
3. PostgreSQL unavailable with successful encrypted spool acknowledgement.
4. PostgreSQL and spool unavailable, confirming provider receives `503`.
5. Worker termination after remote dispatch and before local result commit.
6. Duplicate BullMQ jobs racing for one delivery lease.
7. Downstream timeout and unknown-result policy.
8. Downstream 429 with `Retry-After`.
9. Downstream 410 and operator remediation.
10. DNS answer changing to private/reserved address.
11. Encrypted spool tampering and move to failed.
12. Existing Event with missing Delivery/Outbox reconciliation.
13. Full spool volume.
14. Clock skew beyond configured threshold.
15. TGServer unavailable with bounded log queue behavior.

## 11. Backup and restore

PostgreSQL is authoritative. Back up:

- events
- deliveries
- delivery_outbox
- audit_logs
- replay_locks

Back up the spool volume as encrypted recovery material, but do not treat it as a replacement for PostgreSQL backup.

After restore:

1. restore PostgreSQL;
2. restore pending spool files and their active keys;
3. start PostgreSQL and Redis;
4. start worker and observe recovery/outbox publication;
5. start API;
6. verify `/readyz`, spool counts, and due delivery state;
7. test one controlled signed webhook and one controlled replay.

## 12. Rollback

The v2.0.1 database migration is additive: Delivery lease columns and `delivery_outbox` are created without removing v1.2.2 data. Before rollback, stop API/worker and back up PostgreSQL. Do not run an older worker concurrently with the v2.0.1 worker because it does not understand lease/outbox semantics.

## 13. TGServer logging

When enabled, sanitized structured logs are batched to TGServer without blocking provider acknowledgements.

```env
LOG_TO_TGSERVER=true
TGSERVER_LOG_URL=http://tgserver:7374/internal/logs
TGSERVER_LOG_SECRET=<unique-secret>
TGSERVER_LOG_TIMEOUT_MS=1000
TGSERVER_LOG_FLUSH_INTERVAL_MS=2000
TGSERVER_LOG_BATCH_SIZE=50
TGSERVER_LOG_QUEUE_LIMIT=1000
```

If TGServer is unavailable, logs remain in a bounded memory queue and may be dropped after the configured limit. PostgreSQL records remain the operational source of truth.
