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
import { auditLogQuerySchema } from './reports.schemas.js';
import { paginationQuerySchema } from '../../shared/responses/pagination.js';
import { maintenanceStatus } from '../../jobs/maintenance.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import { z } from 'zod';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
const organizerReportsRouter = Router({ mergeParams: true });
organizerReportsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
organizerReportsRouter.get(
  '/orders',
  validate({ params: eventIdParamsSchema, query: paginationQuerySchema }),
  readEventOrders,
);
organizerReportsRouter.get(
  '/statistics',
  validate({ params: eventIdParamsSchema }),
  readEventStats,
);
const adminReportsRouter = Router();
adminReportsRouter.use(authenticate, authorize(UserRole.ADMIN));
adminReportsRouter.get('/statistics', readPlatformStats);
adminReportsRouter.get('/operations', readOperations);
adminReportsRouter.get('/maintenance', async (_request, response) => {
  response.setHeader('Cache-Control', 'private, no-store');
  sendSuccess(response, 200, 'Maintenance status retrieved', await maintenanceStatus());
});
adminReportsRouter.get('/audit-logs', validate({ query: auditLogQuerySchema }), readAuditLogs);
adminReportsRouter.get(
  '/audit-logs/:logId',
  validate({
    params: z.object({ logId: z.string().uuid() }).strict(),
    query: z.object({}).strict(),
  }),
  async (request, response) => {
    const log = await getPrisma().auditLog.findUnique({
      where: { id: request.params.logId as string },
      select: {
        id: true,
        actorId: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        actor: { select: { id: true, displayName: true } },
      },
    });
    if (!log)
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Audit entry not found.' });
    sendSuccess(response, 200, 'Audit entry retrieved', log);
  },
);
export { adminReportsRouter, organizerReportsRouter };
