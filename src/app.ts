import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { authenticate } from './middleware/authenticate.js';
import { authorize } from './middleware/authorize.js';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { aiRouter } from './modules/ai/ai.router.js';
import { authRouter } from './modules/auth/auth.router.js';
import { healthRouter } from './modules/health/health.router.js';
import { publicEventsRouter } from './modules/public-events/public-events.router.js';
import { ordersRouter } from './modules/orders/orders.router.js';
import { paymentsRouter, sslcommerzCallbacksRouter } from './modules/payments/payments.router.js';
import { eventsRouter } from './modules/events/events.router.js';
import { adminRouter, usersRouter } from './modules/users/users.router.js';
import { checkInRouter, ticketsRouter } from './modules/tickets/tickets.router.js';
import { adminRefundsRouter, attendeeRefundsRouter } from './modules/refunds/refunds.router.js';
import { adminReportsRouter, organizerReportsRouter } from './modules/reports/reports.router.js';
import { sendSuccess } from './shared/responses/api-response.js';
import { corsOptions } from './shared/security/cors.js';
import { apiRateLimiter } from './shared/security/rate-limit.js';
import { openapi } from './docs/openapi.js';
import { adminReadsRouter, overviewRouter } from './modules/reports/workspace-reads.router.js';
import {
  notificationsRouter,
  notificationAccountRouter,
} from './modules/notifications/notifications.router.js';

import { savedEventsRouter } from './modules/saved-events/saved-events.router.js';
import { recommendationsRouter } from './modules/recommendations/recommendations.router.js';
import { waitlistsRouter } from './modules/waitlists/waitlists.router.js';
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
// SSLCommerz sends browser redirects and server-to-server form posts from its own
// domains. Those callbacks are authenticated by transaction validation in the
// payment service, not by browser-origin trust, so they must not be blocked by
// the public API's allow-list.
app.use((request, response, next) => {
  if (request.path.startsWith('/api/v1/payments/sslcommerz/')) {
    next();
    return;
  }

  cors(corsOptions)(request, response, next);
});
app.use(
  '/api/v1/payments/sslcommerz',
  express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }),
);
app.use(express.json({ limit: '100kb' }));
// Platform probes must remain available when the public API budget is exhausted.
app.use('/api/v1/health', healthRouter);
app.use('/api/v1', apiRateLimiter);
app.use('/api/v1', (request, response, next) => {
  if (!request.path.startsWith('/events') && !request.path.startsWith('/health'))
    response.setHeader('Cache-Control', 'private, no-store');
  next();
});

app.get('/', (_request, response) => {
  sendSuccess(response, 200, 'EventGate API is running', {
    service: 'EventGate',
    version: 'v1',
  });
});
app.get('/openapi.json', (_request, response) => response.json(openapi));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));

app.use('/api/v1/ai', aiRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/saved-events', savedEventsRouter);
app.use('/api/v1', notificationAccountRouter);
app.use('/api/v1', recommendationsRouter);
app.use('/api/v1/events', publicEventsRouter);
app.use('/api/v1', waitlistsRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1', attendeeRefundsRouter);
app.use('/api/v1/tickets', ticketsRouter);
app.use('/api/v1/payments/sslcommerz', sslcommerzCallbacksRouter);
app.use('/api/v1/payments', paymentsRouter);
app.use('/api/v1', overviewRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/admin', authenticate, authorize('ADMIN'));
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/admin', adminReadsRouter);
app.use('/api/v1/admin', adminRefundsRouter);
app.use('/api/v1/admin/reports', adminReportsRouter);
app.use('/api/v1/organizer/events/:eventId/check-ins', checkInRouter);
app.use('/api/v1/organizer/events/:eventId/reports', organizerReportsRouter);
app.use('/api/v1/organizer/events', eventsRouter);
app.use(notFound);
app.use(errorHandler);

export { app };
