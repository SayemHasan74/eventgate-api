import { runMaintenance } from './maintenance.service.js';
import { logger } from '../lib/logger.js';
export function startMaintenanceRunner(workerId: string, keepAlive = false) {
  const controller = new AbortController();
  let pass: Promise<unknown> | undefined;
  const run = () => {
    if (pass || controller.signal.aborted) return;
    pass = runMaintenance(workerId, undefined, controller.signal)
      .catch((err: unknown) => logger.error({ err, workerId }, 'Scheduled maintenance failed'))
      .finally(() => {
        pass = undefined;
      });
  };
  run();
  const timer = setInterval(run, 60_000);
  if (!keepAlive) timer.unref();
  return {
    stop() {
      clearInterval(timer);
      controller.abort();
    },
    settled() {
      return pass;
    },
  };
}
