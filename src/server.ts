import { randomUUID } from 'node:crypto';

import { app } from './app.js';
import { env } from './config/env.js';
import { runMaintenance } from './jobs/maintenance.service.js';
import { logger } from './lib/logger.js';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'EventGate API is listening');
});

// Keep the assignment self-contained on a single Render web service. Job
// claiming is database-safe, so a separate worker can still be added later
// without duplicate refund/payment reconciliation.
const maintenanceWorkerId = `web-maintenance-${randomUUID()}`;
const runScheduledMaintenance = () => {
  void runMaintenance(maintenanceWorkerId).catch((error: unknown) => {
    logger.error({ err: error }, 'Scheduled maintenance run failed');
  });
};
runScheduledMaintenance();
const maintenanceInterval = setInterval(runScheduledMaintenance, 60_000);
maintenanceInterval.unref();

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'Closing EventGate API');
  clearInterval(maintenanceInterval);
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'Failed to close EventGate API cleanly');
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
