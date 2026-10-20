import { randomUUID } from 'node:crypto';

import { app } from './app.js';
import { env } from './config/env.js';
import { startMaintenanceRunner } from './jobs/maintenance-runner.js';
import { logger } from './lib/logger.js';
import { getPrisma } from './lib/prisma.js';
import { closeRedis } from './lib/redis.js';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'EventGate API is listening');
});

const maintenance =
  env.EMBEDDED_MAINTENANCE === 'true'
    ? startMaintenanceRunner(`web-maintenance-${randomUUID()}`)
    : undefined;

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Closing EventGate API');
  maintenance?.stop();
  // Wait for the bounded in-flight provider call, not another scheduler pass.
  const hardStop = setTimeout(() => process.exit(1), 55000);
  hardStop.unref();
  const httpClosed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  void Promise.all([httpClosed, maintenance?.settled()])
    .then(async () => {
      await closeRedis();
      await getPrisma().$disconnect();
      clearTimeout(hardStop);
      process.exitCode = 0;
    })
    .catch(() => {
      logger.error('Graceful shutdown did not complete');
      process.exitCode = 1;
    });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
