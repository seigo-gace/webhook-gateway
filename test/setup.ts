process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN ??= 'test_admin_token_012345678901234567890123456789';
process.env.DATABASE_URL ??= 'postgres://webhook:webhook_password@127.0.0.1:5432/webhook_gateway';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/0';
process.env.ENABLE_CLOCK_SKEW_CHECK = 'false';
