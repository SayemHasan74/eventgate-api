import { randomUUID } from 'node:crypto';

import { getPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { closeRedis } from '../lib/redis.js';

import { runMaintenance } from './maintenance.service.js';

const workerId = `maintenance-${randomUUID()}`;
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

try {
  const result = await runMaintenance(workerId, undefined, stop.signal);
  logger.info({ workerId, ...result }, 'Maintenance run completed');
} catch (error) {
  logger.error({ err: error, workerId }, 'Maintenance run failed');
  process.exitCode = 1;
} finally {
  await getPrisma().$disconnect();
  await closeRedis();
}
