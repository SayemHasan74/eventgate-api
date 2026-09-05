import { app } from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.PORT, () => {
  console.info(`EventGate API listening on http://localhost:${env.PORT}`);
});

const shutdown = (signal: string): void => {
  console.info(`${signal} received. Closing EventGate API.`);
  server.close((error) => {
    if (error) {
      console.error('Failed to close EventGate API cleanly.', error);
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
