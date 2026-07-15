# Architecture v1.2.2

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
