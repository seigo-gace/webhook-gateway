# Implementation Notes v1.2.2

## Recovery location

Recovery sweeper runs only inside Worker. API remains ingress/admin/metrics focused.

## Recovery sequence

1. Import spool files.
2. Re-enqueue due queued/retrying/unknown deliveries.
3. Reset stale delivering deliveries.
4. Cleanup raw body retention.
5. Purge failed spool files.

## Spool import classification

- success: imported and removed
- duplicate: already in DB and removed
- corrupted: moved to `/spool/failed` and not retried
- db_error: left for later retry

## Filesystem requirement

Spool locking depends on atomic local rename. Use local ext4/xfs, Docker named volume, encrypted local volume, Kubernetes emptyDir, or hostPath. Avoid network filesystems.
