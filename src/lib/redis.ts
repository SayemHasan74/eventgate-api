import { createClient, type RedisClientType } from 'redis';

import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: RedisClientType | undefined;
let connectionAttempt: Promise<void> | undefined;
let unavailableLogged = false;

const logUnavailable = (error: unknown): void => {
  if (!unavailableLogged) {
    logger.warn({ err: error }, 'Redis is unavailable; continuing without cache');
    unavailableLogged = true;
  }
};

const getClient = async (): Promise<RedisClientType | undefined> => {
  if (!env.REDIS_URL) return undefined;
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
};
