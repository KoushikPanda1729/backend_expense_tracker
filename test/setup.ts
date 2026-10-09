// Minimal environment so modules that read config can be imported in tests.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/kharcha_test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.LOG_LEVEL = 'silent';
