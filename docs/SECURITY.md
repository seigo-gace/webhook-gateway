# Security v1.2.2

## Spool payloads

Spool files can contain sensitive verified payloads. Production requires encrypted local storage for `/spool`. Do not use NFS/SMB for spool locking.

## Logs and persistence

`last_error`, `audit_logs.details`, metrics labels, admin responses, and spool metadata must pass sanitization before persistence or exposure.

## Admin API

Admin API is read-only plus replay only. Replay is rate limited and always audited. Config/secret mutation is intentionally excluded.

## Clock skew

`/readyz` must include clock skew status. If required clock skew checks fail, readiness fails.

## Dependency safety

Use exact dependency versions and run `npm audit --audit-level=high` in CI. The validated ZIP artifact includes `package-lock.json`; after server-side clone validation, commit the lockfile and switch CI from `npm install` to `npm ci`.
