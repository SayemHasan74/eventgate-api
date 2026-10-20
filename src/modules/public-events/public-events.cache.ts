import { incrementCache, readVersionedCache, writeVersionedCache } from '../../lib/redis.js';

const prefix = 'eventgate:discovery:v6:';
const pending = new Map<string, Promise<unknown>>();
let generation = 0;

// Inventory changes do not invalidate category/city options. Facts changes do.
export async function invalidatePublicDiscoveryCache(facets = false, slug?: string): Promise<void> {
  generation++;
  await Promise.all([
    incrementCache(`${prefix}events:version`),
    ...(facets ? [incrementCache(`${prefix}facets:version`)] : []),
    ...(slug ? [incrementCache(`${prefix}event:${slug}:version`)] : []),
  ]);
}

export async function cachedDiscovery<T>(
  suffix: string,
  load: () => Promise<T>,
  namespace = 'events',
): Promise<T> {
  const versionKey = `${prefix}${namespace}:version`;
  const keyPrefix = `${prefix}${namespace}:`;
  const observedGeneration = generation;
  const observed = await readVersionedCache(versionKey, keyPrefix, suffix);
  if (observed?.raw) {
    try {
      return JSON.parse(observed.raw) as T;
    } catch {
      /* Replace malformed public data. */
    }
  }
  const key = `${keyPrefix}${observed?.version ?? 'unavailable'}:${observedGeneration}:${suffix}`;
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const work = load()
    .then((value) => {
      // Optional cache persistence must not delay an already completed database read.
      // Redis CAS checks the observed version even if another process invalidated it.
      if (observed && generation === observedGeneration)
        void writeVersionedCache(
          versionKey,
          `${keyPrefix}${observed.version}:${suffix}`,
          observed.version,
          JSON.stringify(value),
          30,
        );
      return value;
    })
    .finally(() => pending.delete(key));
  // Bound coalescing bookkeeping; unique search strings must not grow memory forever.
  if (pending.size < 256) pending.set(key, work);
  return work;
}
