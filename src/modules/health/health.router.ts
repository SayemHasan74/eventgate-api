import { Router } from 'express';

import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendSuccess } from '../../shared/responses/api-response.js';

const healthRouter = Router();

healthRouter.get('/live', (_request, response) => {
  sendSuccess(response, 200, 'Service is live', { status: 'live' });
});

healthRouter.get('/ready', async (_request, response) => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
  } catch (cause) {
    throw new AppError({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service is not ready',
      errors: [{ code: 'DATABASE_UNAVAILABLE', message: 'Database connectivity check failed.' }],
      cause,
    });
  }

  sendSuccess(response, 200, 'Service is ready', { status: 'ready', database: 'connected' });
});

export { healthRouter };
