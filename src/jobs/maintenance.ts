import { randomUUID } from 'node:crypto';

import { getPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

import { runMaintenance } from './maintenance.service.js';

const workerId = `maintenance-${randomUUID()}`;

try {
  const result = await runMaintenance(workerId);
  logger.info({ workerId, ...result }, 'Maintenance run completed');
} catch (error) {
  logger.error({ err: error, workerId }, 'Maintenance run failed');
  process.exitCode = 1;
} finally {
  await getPrisma().$disconnect();
}
