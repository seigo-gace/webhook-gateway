# Webhook Gateway v2.0.1 Security

## 1. Trust boundaries

```text
Untrusted: provider network, request headers, request body, DNS, destination response
Trusted only after validation: source config, verified provider identity, normalized event
Authoritative: PostgreSQL Event/Delivery/Outbox/Audit state
Transport only: Redis/BullMQ
Recovery ledger: encrypted emergency spool
```

No request field is trusted merely because it arrived through HTTPS or a known path.

## 2. Provider verification

- The exact raw request bytes are retained in memory for verification.
- JSON parsing and business normalization occur only after signature success.
- Provider-specific timestamp tolerance is enforced where the protocol supplies timestamps.
- GitHub, Stripe, Slack, Telegram, Standard Webhooks, and generic HMAC formats are verified independently.
- Stable provider event IDs are mandatory for signed providers.
- Primary and secondary secrets allow controlled rotation.
- Signature comparisons use constant-time comparison after safe decoding.

TLS termination must preserve the raw body without rewriting or re-serializing JSON.

## 3. Acknowledgement integrity

A provider receives `202` only after:

- Event, Delivery, and Delivery Outbox commit atomically in PostgreSQL; or
- a complete emergency spool file is atomically committed.

Redis enqueue, downstream delivery, TGServer logging, and metrics are outside the acknowledgement durability requirement.

## 4. Deduplication and concurrency

- Event uniqueness: `(source_id, provider_event_id)`.
- Delivery uniqueness: `(event_id, destination_id, route_id)`.
- Outbox uniqueness: one row per Delivery.
- Delivery work requires a random PostgreSQL lease token.
- State completion requires the same active token.
- Outbox publishers use `FOR UPDATE SKIP LOCKED` plus token/expiry.
- Replay cooldown acquisition is atomic in PostgreSQL.

These controls prevent concurrent duplicate dispatch inside the gateway. They do not provide exactly-once semantics after an external receiver has processed a request but the gateway loses the response. Receivers must be idempotent.

## 5. SSRF and DNS rebinding

Destination dispatch performs:

- HTTP/HTTPS protocol allowlist;
- embedded credential rejection;
- URL fragment rejection;
- all-answer DNS validation;
- private/local/reserved/non-routable range rejection unless explicitly allowed;
- IP pinning between validation and connection;
- redirect disabling.

`allowPrivateNetwork=true` is a privileged destination setting. Use it only for a known internal service and combine it with network-level egress controls. Application-level SSRF protection does not replace firewall, namespace, or Cloudflare/network policy.

## 6. Emergency spool

`encrypted_file` mode uses:

- AES-256-GCM confidentiality and authenticated encryption;
- independent HMAC-SHA256 over the canonical envelope;
- random 96-bit IV per record;
- temporary-file write with restrictive permissions;
- atomic rename;
- sanitized headers;
- exact body/verification/CloudEvent recovery data.

Keys must be independent:

```env
SPOOL_ENCRYPTION_KEY=base64:<32 random bytes>
SPOOL_HMAC_KEY=base64:<at least 32 random bytes>
```

Do not expose or synchronize `/spool` through public file sharing. Do not use network filesystems whose rename/locking semantics are not guaranteed. Tampered or invalid files move to `/spool/failed`.

## 7. Secrets

Secret values live in environment/secret management, not JSON config or source control.

Separate secrets for:

- each inbound provider;
- each outbound destination;
- Admin API;
- PostgreSQL;
- TGServer logs;
- spool encryption;
- spool HMAC.

Production validation rejects known placeholders, short Admin tokens, malformed encrypted-spool keys, and missing referenced environment variables.

## 8. Admin API

Admin API exposes event inspection, delivery inspection, audit inspection, and replay only.

Controls:

- operator token;
- optional CIDR allowlist;
- request rate limit;
- replay-specific rate limit;
- atomic resource cooldown;
- audit entry for accepted and rejected replay attempts.

No API mutates source, destination, route, or secret configuration.

## 9. Rate limiting and availability

Ingress rate limiting uses Redis Lua for atomic provider/IP counters. If Redis is unavailable, a bounded local memory limiter applies.

Redis failure is a degraded delivery-transport condition, not an ingress durability failure. PostgreSQL and emergency spool remain the acceptance controls.

Memory fallback is per API process. Network-edge rate limiting should still be configured at Cloudflare or the reverse proxy for distributed abuse resistance.

## 10. Circuit breaker

Circuit breaker state is stored in Redis and protects unstable downstream destinations. A Redis outage fails open because Redis is not authoritative; PostgreSQL retry state and delivery leases still protect correctness.

Circuit breaking controls load, not authorization. It must not be treated as a security decision.

## 11. Response handling

- Redirects are not followed.
- Response bodies are bounded and truncated.
- Truncation does not convert a successful status into a retry.
- Stored response/error fields are sanitized and length bounded.
- Unknown delivery results remain explicit when the receiver may have processed the request.

## 12. Logging and data minimization

- Raw bodies are not stored by default.
- Header sanitization removes authorization/cookie/API-token material.
- Metrics labels are bounded and sanitized.
- TGServer logging is asynchronous and bounded.
- Audit data and delivery errors are sanitized before persistence.
- `BODY_RETENTION_DAYS` purges optional stored body text.

Do not log provider secrets, outbound signing secrets, Admin tokens, DB credentials, spool keys, or unbounded payloads.

## 13. Container hardening

API and worker containers run:

- as UID/GID `10001`;
- with `no-new-privileges`;
- with Linux capabilities dropped;
- with a read-only root filesystem;
- with bounded tmpfs, memory, and PID limits.

The API port binds to localhost by default. PostgreSQL and Redis are not published by Compose.

## 14. Dependency and supply-chain controls

- exact top-level dependency versions;
- committed `package-lock.json`;
- `npm ci` in CI and Docker;
- production-only runtime dependencies in the final image;
- high-severity npm audit gate;
- reproducible Node 22 build.

Review and pin third-party GitHub Actions by commit SHA when the repository’s supply-chain policy requires it.

## 15. Clock skew

Signed protocols depend on time. `/readyz` reports clock status. When clock checking is configured as required, excessive skew or an unavailable check makes readiness fail.

## 16. Residual risks

- At-least-once delivery can duplicate remote effects after ambiguous timeouts or process loss; receivers must deduplicate.
- An explicitly allowed private destination can reach internal networks; restrict config and egress.
- A compromised runtime host can access active environment secrets and plaintext payloads in memory.
- Single active spool keys require planned drain/migration for rotation.
- In-memory rate-limit fallback is local to one API replica.
- Dynamic runtime config mutation is intentionally unsupported; configuration changes require controlled deployment.
