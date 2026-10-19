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
