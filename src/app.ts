import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { healthRouter } from './modules/health/health.router.js';
import { sendSuccess } from './shared/responses/api-response.js';
import { corsOptions } from './shared/security/cors.js';
import { apiRateLimiter } from './shared/security/rate-limit.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(requestId);
app.use(
  pinoHttp({
    logger,
    customProps: (_request, response) => ({ requestId: response.getHeader('x-request-id') }),
  }),
);
app.use(helmet());
app.use(cors(corsOptions));
app.use(
  '/api/v1/payments/sslcommerz',
  express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }),
);
app.use(express.json({ limit: '100kb' }));
app.use('/api/v1', apiRateLimiter);

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
