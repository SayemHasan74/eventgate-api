import { createClient, type RedisClientType } from 'redis';

import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: RedisClientType | undefined;
let connectionAttempt: Promise<void> | undefined;
let unavailableLogged = false;
let retryAfter = 0;
const retryDelayMs = 30_000;

const logUnavailable = (error: unknown): void => {
  retryAfter = Date.now() + retryDelayMs;
  if (!unavailableLogged) {
    logger.warn({ err: error }, 'Redis is unavailable; continuing without cache');
    unavailableLogged = true;
  }
};

const getClient = async (): Promise<RedisClientType | undefined> => {
  if (!env.REDIS_URL || Date.now() < retryAfter) return undefined;
  if (!client) {
    client = createClient({
      url: env.REDIS_URL,
      disableOfflineQueue: true,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
    client.on('error', logUnavailable);
  }
  if (!client.isReady) {
    connectionAttempt ??= client
      .connect()
      .then(() => undefined)
      .catch((error: unknown) => {
        logUnavailable(error);
      })
      .finally(() => {
        connectionAttempt = undefined;
      });
    await connectionAttempt;
  }
  if (client.isReady) unavailableLogged = false;
  return client.isReady ? client : undefined;
};

const bounded = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Optional cache command timed out')), 500);
      }),
    ]);
  } catch (error) {
    logUnavailable(error);
    if (client?.isOpen) client.destroy();
    client = undefined;
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const readCache = async (key: string): Promise<string | null> => {
  try {
    const ready = await getClient();
    return ready ? await bounded(ready.get(key)) : null;
  } catch (error) {
    logUnavailable(error);
    return null;
  }
};

export const writeCache = async (key: string, value: string, ttlSeconds: number): Promise<void> => {
  try {
    const ready = await getClient();
    if (ready) await bounded(ready.set(key, value, { EX: ttlSeconds }));
  } catch (error) {
    logUnavailable(error);
  }
};

export const incrementCache = async (key: string): Promise<void> => {
  try {
    const ready = await getClient();
    if (ready) await bounded(ready.incr(key));
  } catch (error) {
    logUnavailable(error);
  }
};

// Fetch the namespace version and value in one Redis round trip. A cache fill
// keeps this observed version; a concurrent invalidation cannot resurrect it.
export async function readVersionedCache(
  versionKey: string,
  prefix: string,
  suffix: string,
): Promise<{ version: string; raw: string | null } | undefined> {
  try {
    const ready = await getClient();
    if (!ready) return undefined;
    const result = (await bounded(
      ready.eval(
        `
      local version = redis.call('GET', KEYS[1]) or '0'
      return {version, redis.call('GET', ARGV[1] .. version .. ':' .. ARGV[2]) or ''}
    `,
        { keys: [versionKey], arguments: [prefix, suffix] },
      ),
    )) as string[];
    return { version: result[0]!, raw: result[1] || null };
  } catch (error) {
    logUnavailable(error);
    return undefined;
  }
}

export async function writeVersionedCache(
  versionKey: string,
  key: string,
  version: string,
  value: string,
  ttl: number,
): Promise<void> {
  try {
    const ready = await getClient();
    if (ready)
      await bounded(
        ready.eval(
          `
      if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
      return 1
    `,
          { keys: [versionKey, key], arguments: [version, value, String(ttl)] },
        ),
      );
  } catch (error) {
    logUnavailable(error);
  }
}

export const closeRedis = async (): Promise<void> => {
  await connectionAttempt;
  if (client?.isOpen) client.destroy();
  client = undefined;
  retryAfter = 0;
  unavailableLogged = false;
};

// A shared, atomic budget prevents parallel visitors or process restarts from consuming unlimited free inference.
export const reserveAiQuota = async (dailyLimit: number): Promise<boolean> => {
  try {
    const ready = await getClient();
    if (!ready) return false;
    const now = Date.now();
    const script = `
      if tonumber(redis.call('GET',KEYS[1]) or '0') >= 4 or tonumber(redis.call('GET',KEYS[2]) or '0') >= tonumber(ARGV[1]) then return 0 end
      redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],120)
      redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],172800)
      return 1`;
    return (
      Number(
        await bounded(
          ready.eval(script, {
            keys: [
              `ai:v1:minute:${Math.floor(now / 60000)}`,
              `ai:v1:day:${Math.floor(now / 86400000)}`,
            ],
            arguments: [String(dailyLimit)],
          }),
        ),
      ) === 1
    );
  } catch {
    return false;
  }
};
