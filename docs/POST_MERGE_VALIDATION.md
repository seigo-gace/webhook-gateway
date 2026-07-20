# Post-merge main validation

This validation branch was created from main commit `5670a9d6840054dae18dd84f1921c77224e895a3`, which contains the merged Webhook Gateway v2.0.1 P0 integration commit `5cb7a78cf7e0ce333b62f3db31ae3d84ff3b8863`.

The pull request for this file exists only to trigger the repository's complete read-only CI gate against the integrated main tree because GitHub App-authored main commits do not recursively trigger push workflows.

Required successful gates:

- locked dependency installation with `npm ci`
- TypeScript strict typecheck
- unit, static architecture, and security tests
- PostgreSQL integration, transaction, migration, and concurrency tests
- Redis/BullMQ integration and replay tests
- real HTTP ingress/delivery E2E and failure-injection tests
- production JavaScript build
- production Docker runtime image build
- Docker Compose model validation
- high-severity npm dependency audit
