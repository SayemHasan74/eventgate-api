import { randomUUID } from 'node:crypto';

import { app } from './app.js';
import { env } from './config/env.js';
import { runMaintenance } from './jobs/maintenance.service.js';
import { logger } from './lib/logger.js';
import { getPrisma } from './lib/prisma.js';
import { closeRedis } from './lib/redis.js';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'EventGate API is listening');
});

// Keep the assignment self-contained on a single Render web service. Job
// claiming is database-safe, so a separate worker can still be added later
// without duplicate refund/payment reconciliation.
const maintenanceWorkerId = `web-maintenance-${randomUUID()}`;
const maintenanceStop = new AbortController();
let maintenancePass: Promise<unknown> | undefined;
const runScheduledMaintenance = () => {
  if (maintenancePass || maintenanceStop.signal.aborted) return;
  maintenancePass = runMaintenance(maintenanceWorkerId, undefined, maintenanceStop.signal)
    .catch(() => {
      logger.error('Scheduled maintenance run failed; inspect admin maintenance status');
    })
    .finally(() => {
      maintenancePass = undefined;
    });
};
runScheduledMaintenance();
const maintenanceInterval = setInterval(runScheduledMaintenance, 60_000);
maintenanceInterval.unref();

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Closing EventGate API');
  clearInterval(maintenanceInterval);
  maintenanceStop.abort();
  // Wait for the bounded in-flight provider call, not another scheduler pass.
  const hardStop = setTimeout(() => process.exit(1), 55000);
  hardStop.unref();
  const httpClosed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  void Promise.all([httpClosed, maintenancePass])
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
