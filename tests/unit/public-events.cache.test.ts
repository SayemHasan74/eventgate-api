import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheState = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock('../../src/lib/redis.js', () => ({
  readCache: async (key: string) => cacheState.values.get(key) ?? null,
  writeCache: async (key: string, value: string) => {
    cacheState.values.set(key, value);
  },
  incrementCache: async (key: string) => {
    const nextValue = Number(cacheState.values.get(key) ?? '0') + 1;
    cacheState.values.set(key, String(nextValue));
  },
}));

const { invalidatePublicDiscoveryCache, readDiscoveryCache, writeDiscoveryCache } =
  await import('../../src/modules/public-events/public-events.cache.js');

describe('public discovery cache', () => {
  beforeEach(() => {
    cacheState.values.clear();
  });

  it('uses a cache version to invalidate all prior discovery keys', async () => {
    await writeDiscoveryCache('list:dhaka', { eventIds: ['one'] });
    await expect(readDiscoveryCache('list:dhaka')).resolves.toEqual({ eventIds: ['one'] });

    await invalidatePublicDiscoveryCache();

    await expect(readDiscoveryCache('list:dhaka')).resolves.toBeUndefined();
    await writeDiscoveryCache('list:dhaka', { eventIds: ['two'] });
    await expect(readDiscoveryCache('list:dhaka')).resolves.toEqual({ eventIds: ['two'] });
  });
});
