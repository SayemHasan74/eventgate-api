import { describe, expect, it } from 'vitest';
import { assertSeedTarget } from '../../prisma/seed-data.js';

describe('seed target safety', () => {
  it('rejects production and unspecified modes before opening a connection', () => {
    for (const mode of ['production', undefined])
      expect(() => assertSeedTarget(mode, 'postgresql://localhost/eventgate')).toThrow(
        'production is forbidden',
      );
  });
  it('rejects a remote database even with development mode', () => {
    expect(() => assertSeedTarget('development', 'postgresql://db.example.test/eventgate')).toThrow(
      'remote databases are forbidden',
    );
  });
  it('permits explicit disposable local development and test targets', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]'])
      expect(() => assertSeedTarget('test', `postgresql://${host}/eventgate_test`)).not.toThrow();
  });
});
