import { randomUUID } from 'node:crypto';
import { startMaintenanceRunner } from './maintenance-runner.js';
import { getPrisma } from '../lib/prisma.js';
import { closeRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
const worker = startMaintenanceRunner(`worker-${randomUUID()}`, true);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  worker.stop();
  const hardStop = setTimeout(() => process.exit(1), 55_000);
  hardStop.unref();
  try {
    await worker.settled();
    await closeRedis();
    await getPrisma().$disconnect();
  } catch (err) {
    logger.error({ err }, 'Worker shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
  }
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
