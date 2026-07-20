import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spoolDir = path.join(os.tmpdir(), `webhook-gateway-test-${process.pid}`);
fs.mkdirSync(spoolDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.LOG_TO_TGSERVER = 'false';
process.env.ADMIN_TOKEN ??= 'test_admin_token_012345678901234567890123456789';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/webhook_test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/0';
process.env.ENABLE_CLOCK_SKEW_CHECK = 'false';
process.env.SPOOL_DIR ??= spoolDir;
process.env.SPOOL_STORAGE_MODE ??= 'encrypted_file';
process.env.SPOOL_ENCRYPTION_KEY ??= `base64:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.SPOOL_HMAC_KEY ??= `base64:${Buffer.alloc(32, 9).toString('base64')}`;
process.env.INBOUND_STANDARD_SECRET ??= `base64:${Buffer.alloc(32, 1).toString('base64')}`;
process.env.INBOUND_GITHUB_SECRET ??= 'github-test-secret';
process.env.INBOUND_STRIPE_SECRET ??= 'stripe-test-secret';
process.env.INBOUND_SLACK_SECRET ??= 'slack-test-secret';
process.env.INBOUND_TELEGRAM_SECRET ??= 'telegram-test-secret';
process.env.INBOUND_GENERIC_SECRET ??= 'generic-test-secret';
process.env.OUTBOUND_APP_SECRET ??= `base64:${Buffer.alloc(32, 2).toString('base64')}`;
process.env.OUTBOUND_TGSERVER_SECRET ??= `base64:${Buffer.alloc(32, 3).toString('base64')}`;
process.env.DEST_APP_URL ??= 'http://127.0.0.1:18080/internal/webhooks';
process.env.DEST_TGSERVER_URL ??= 'http://127.0.0.1:18081/internal/webhooks';
