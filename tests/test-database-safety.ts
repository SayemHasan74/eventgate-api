const normalizedTarget = (value: string) => {
  const url = new URL(value);
  return `${url.protocol}//${url.username}:${url.password}@${url.hostname}:${url.port}${url.pathname}`;
};

export function assertSafeTestDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required for database integration tests.');
  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.pathname !== '/eventgate_test'
  )
    throw new Error(
      'Refusing database test: TEST_DATABASE_URL must target the explicitly named eventgate_test database.',
    );

  const ordinaryUrl = process.env.EVENTGATE_ORDINARY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (ordinaryUrl) {
    let sameTarget = false;
    try {
      sameTarget = normalizedTarget(testUrl) === normalizedTarget(ordinaryUrl);
    } catch {
      /* The main database URL is validated by the application. */
    }
    if (sameTarget)
      throw new Error('Refusing database test: TEST_DATABASE_URL resolves to DATABASE_URL.');
  }
  return testUrl;
}

process.env.EVENTGATE_ORDINARY_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.API_RATE_LIMIT_MAX ??= '100';
process.env.AUTH_RATE_LIMIT_MAX ??= '100';
if (process.env.TEST_DATABASE_URL) assertSafeTestDatabaseUrl();
