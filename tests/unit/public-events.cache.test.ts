import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  versions: new Map<string, number>(),
  values: new Map<string, string>(),
  writes: vi.fn(),
}));
vi.mock('../../src/lib/redis.js', () => ({
  readVersionedCache: async (key: string, prefix: string, suffix: string) => {
    const version = String(state.versions.get(key) ?? 0);
    return { version, raw: state.values.get(`${prefix}${version}:${suffix}`) ?? null };
  },
  writeVersionedCache: async (key: string, dataKey: string, version: string, raw: string) => {
    state.writes();
    if (String(state.versions.get(key) ?? 0) === version) state.values.set(dataKey, raw);
  },
  incrementCache: async (key: string) => {
    state.versions.set(key, (state.versions.get(key) ?? 0) + 1);
  },
}));
const { cachedDiscovery, invalidatePublicDiscoveryCache } =
  await import('../../src/modules/public-events/public-events.cache.js');
beforeEach(() => {
  state.values.clear();
  state.versions.clear();
  state.writes.mockClear();
});
describe('public cache fills', () => {
  it('coalesces identical concurrent database reads', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const one = cachedDiscovery('same', load);
    const two = cachedDiscovery('same', load);
    await Promise.resolve();
    resolve('result');
    expect(await Promise.all([one, two])).toEqual(['result', 'result']);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('never persists an old in-flight result after invalidation', async () => {
    let resolve!: (value: string) => void;
    const old = cachedDiscovery(
      'race',
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    await Promise.resolve();
    await invalidatePublicDiscoveryCache();
    resolve('old');
    await old;
    expect(state.writes).not.toHaveBeenCalled();
    expect(await cachedDiscovery('race', async () => 'new')).toBe('new');
    expect([...state.values.values()]).not.toContain(JSON.stringify('old'));
  });
  it('leaves facets cached on inventory changes but expires them on event edits', async () => {
    const load = vi.fn(async () => ['Dhaka']);
    await cachedDiscovery('facets', load, 'facets');
    await invalidatePublicDiscoveryCache();
    await cachedDiscovery('facets', load, 'facets');
    expect(load).toHaveBeenCalledTimes(1);
    await invalidatePublicDiscoveryCache(true);
    await cachedDiscovery('facets', load, 'facets');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('invalidates only the affected event detail', async () => {
    const one = vi.fn(async () => 'one'),
      two = vi.fn(async () => 'two');
    await cachedDiscovery('detail', one, 'event:one');
    await cachedDiscovery('detail', two, 'event:two');
    await invalidatePublicDiscoveryCache(false, 'one');
    await cachedDiscovery('detail', one, 'event:one');
    await cachedDiscovery('detail', two, 'event:two');
    expect(one).toHaveBeenCalledTimes(2);
    expect(two).toHaveBeenCalledTimes(1);
  });
  it('does not wait for an optional Redis write', async () => {
    // The versioned writer is separate from the returned database promise.
    expect(await cachedDiscovery('immediate', async () => 42)).toBe(42);
    expect(state.writes).toHaveBeenCalledOnce();
  });
});
