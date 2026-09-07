import { Router } from 'express';
import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { eventIdParamsSchema } from '../events/events.schemas.js';
import {
  readAuditLogs,
  readEventOrders,
  readEventStats,
  readOperations,
  readPlatformStats,
} from './reports.controller.js';
const organizerReportsRouter = Router({ mergeParams: true });
organizerReportsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
organizerReportsRouter.get('/orders', validate({ params: eventIdParamsSchema }), readEventOrders);
organizerReportsRouter.get(
  '/statistics',
  validate({ params: eventIdParamsSchema }),
  readEventStats,
);
const adminReportsRouter = Router();
adminReportsRouter.use(authenticate, authorize(UserRole.ADMIN));
adminReportsRouter.get('/statistics', readPlatformStats);
adminReportsRouter.get('/operations', readOperations);
adminReportsRouter.get('/audit-logs', readAuditLogs);
export { adminReportsRouter, organizerReportsRouter };
