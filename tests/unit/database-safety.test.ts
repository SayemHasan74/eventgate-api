import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeTestDatabaseUrl } from '../test-database-safety.js';

const original = {
  test: process.env.TEST_DATABASE_URL,
  database: process.env.DATABASE_URL,
  ordinary: process.env.EVENTGATE_ORDINARY_DATABASE_URL,
};

afterEach(() => {
  if (original.test === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = original.test;
  if (original.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original.database;
  if (original.ordinary === undefined) delete process.env.EVENTGATE_ORDINARY_DATABASE_URL;
  else process.env.EVENTGATE_ORDINARY_DATABASE_URL = original.ordinary;
});

describe('destructive integration database guard', () => {
  it('requires the exact dedicated test database name', () => {
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/eventgate?schema=public';
    process.env.EVENTGATE_ORDINARY_DATABASE_URL = process.env.DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      'postgresql://user:pw@localhost:5432/eventgate_test?schema=public';
    expect(assertSafeTestDatabaseUrl()).toContain('/eventgate_test');
    process.env.TEST_DATABASE_URL = 'postgresql://user:pw@localhost:5432/eventgate?schema=public';
    expect(() => assertSafeTestDatabaseUrl()).toThrow(/eventgate_test/);
  });

  it('rejects a test URL pointing to the ordinary database, even when query strings differ', () => {
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/eventgate_test?schema=public';
    process.env.EVENTGATE_ORDINARY_DATABASE_URL = process.env.DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      'postgresql://user:pw@localhost:5432/eventgate_test?sslmode=require';
    expect(() => assertSafeTestDatabaseUrl()).toThrow(/resolves to DATABASE_URL/);
  });
});
