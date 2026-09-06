import express from 'express';
import { pinoHttp } from 'pino-http';

import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { healthRouter } from './modules/health/health.router.js';
import { sendSuccess } from './shared/responses/api-response.js';

const app = express();

app.disable('x-powered-by');
app.use(requestId);
app.use(
  pinoHttp({
    logger,
    customProps: (_request, response) => ({ requestId: response.getHeader('x-request-id') }),
  }),
);
app.use(express.json());

app.get('/', (_request, response) => {
  sendSuccess(response, 200, 'EventGate API is running', {
    service: 'EventGate',
    version: 'v1',
  });
});

app.use('/api/v1/health', healthRouter);
app.use(notFound);
app.use(errorHandler);

export { app };
