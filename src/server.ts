import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'EventGate API is listening');
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'Closing EventGate API');
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
