# Server Core Alignment — Webhook Gateway v2.0.1

This repository follows the fixed five-stage modular architecture:

```text
Part -> Feature -> Component -> System -> Application
```

This hierarchy is the internal design of one complete Webhook Gateway. It is not a runtime application-linking mechanism and does not require one physical file or process per logical stage.

## 1. Part

Path: `src/part/`

Small primitives and policies with one responsibility. Part must not know the end-to-end webhook workflow.

Examples:

- `env.ts` — typed Zod environment contract
- `crypto.ts` — hashing, HMAC, constant-time comparison, IDs
- `types.ts` — shared data contracts
- `sanitize.ts` — redaction and bounded text
- `http.ts` — header/body parsing helpers
- `normalizer.ts` — provider event-ID normalization
- `url-security.ts` — destination URL/address policy
- `ip-allowlist.ts` — CIDR policy
- `rateLimit.ts` — local fixed-window primitive
- `metrics.ts` — Prometheus definitions
- `clock.ts` — clock-skew measurement

## 2. Feature

Path: `src/feature/`

Reusable capabilities built from Parts. Features may depend on external libraries/infrastructure but must not own complete process lifecycle.

Examples:

- `verifiers.ts` — provider signature verification
- `config.ts` — JSON/environment validation and cross-reference checks
- `db.ts` — Event/Delivery/Outbox/Audit persistence, transactions, leases
- `queue.ts` — BullMQ transport
- `spool.ts` — encrypted emergency recovery ledger
- `destination-http.ts` — DNS validation, IP pinning, bounded response reads
- `composite-rate-limit.ts` — Redis plus memory fallback limiter
- `circuit-breaker.ts` — destination circuit state
- `tgserver-log.ts` — bounded asynchronous log sink

## 3. Component

Path: `src/component/`

Components combine reusable policy/capability into bounded operational units without process lifecycle.

- `routing.ts` — deterministic route selection
- `delivery.ts` — payload composition, outcome classification, retry/backoff policy

## 4. System

Path: `src/system/`

Systems assemble Parts, Features, and Components into runnable boundaries.

- `api-system.ts` — ingress, Admin, health, readiness, metrics, durable ACK orchestration
- `worker-system.ts` — Outbox publication, leased delivery, spool recovery, retention, shutdown

System files may orchestrate, but reusable logic must move to the lowest appropriate Part, Feature, or Component.

## 5. Application

Path: `src/application/` plus root entrypoints.

- `src/application/api.ts`
- `src/application/worker.ts`
- `src/application/generate-secret.ts`
- `src/server.ts`
- `src/worker.ts`

Application launchers remain thin and contain no domain or infrastructure policy.

## Import direction

```text
Application -> System -> Component -> Feature -> Part
```

Allowed dependencies:

- Feature may import Part.
- Component may import Feature and Part.
- System may import Component, Feature, and Part.
- Application may import System/Feature entrypoints required to launch.
- Part must not import Feature, Component, System, or Application.

Static tests enforce the lower-layer restrictions and thin launcher requirement.

## Architecture rules

1. Preserve existing names, roles, state meanings, and P0 guarantees unless a reviewed requirement changes them.
2. PostgreSQL remains the source of truth; Redis/BullMQ remains transport/state acceleration.
3. Provider acknowledgement requires committed durable state or committed emergency spool.
4. No placeholder, no-op, mock, or interface-only implementation may be reported as complete.
5. Do not create future-empty folders or split files merely to increase file count.
6. Keep pure policy out of System when it can be reused/tested at Component, Feature, or Part.
7. Infrastructure adapters must preserve domain/runtime invariants rather than redefining them.
8. Tests follow the same structure: pure policy, infrastructure integration, system E2E, deployment validation.

## v2.0.1 responsibility mapping

```text
Ingress durability
  System: api-system
  Feature: db / spool / verifiers / composite-rate-limit
  Component: routing
  Part: crypto / http / normalizer / IP and URL policy

Asynchronous delivery
  System: worker-system
  Feature: db / queue / destination-http / circuit-breaker
  Component: delivery
  Part: crypto / sanitize / metrics / types

Recovery
  System: worker-system recovery sweep
  Feature: db outbox+leases / encrypted spool / queue
  Component: routing and delivery policy
```

## Required validation

```text
npm ci
npm run typecheck
npm run test:ci
npm run build
docker build --target runtime .
docker compose config --quiet
npm audit --audit-level=high
```

The test suite must include real PostgreSQL, real Redis/BullMQ, real HTTP ingress/destination behavior, concurrency races, recovery, security, abnormal boundaries, and deployment checks.

## TGServer log aggregation

TGServer logging is a Feature used by API and Worker Systems. It is asynchronous, sanitized, batched, bounded, and excluded from the provider acknowledgement dependency path. PostgreSQL and spool state remain authoritative when TGServer is unavailable.
