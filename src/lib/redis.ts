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

export const readCache = async (key: string): Promise<string | null> => {
  try {
    return (await getClient())?.get(key) ?? null;
  } catch (error) {
    logUnavailable(error);
    return null;
  }
};

export const writeCache = async (key: string, value: string, ttlSeconds: number): Promise<void> => {
  try {
    await (await getClient())?.set(key, value, { EX: ttlSeconds });
  } catch (error) {
    logUnavailable(error);
  }
};

export const incrementCache = async (key: string): Promise<void> => {
  try {
    await (await getClient())?.incr(key);
  } catch (error) {
    logUnavailable(error);
  }
};
