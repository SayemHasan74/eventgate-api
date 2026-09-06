import { incrementCache, readCache, writeCache } from '../../lib/redis.js';

const discoveryVersionKey = 'eventgate:public-events:version';
const cacheTtlSeconds = 60;

export const invalidatePublicDiscoveryCache = async (): Promise<void> => {
  await incrementCache(discoveryVersionKey);
};

export const readDiscoveryCache = async <T>(suffix: string): Promise<T | undefined> => {
  const version = (await readCache(discoveryVersionKey)) ?? '0';
  const raw = await readCache(`eventgate:public-events:${version}:${suffix}`);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export const writeDiscoveryCache = async <T>(suffix: string, value: T): Promise<void> => {
  const version = (await readCache(discoveryVersionKey)) ?? '0';
  await writeCache(
    `eventgate:public-events:${version}:${suffix}`,
    JSON.stringify(value),
    cacheTtlSeconds,
  );
};
