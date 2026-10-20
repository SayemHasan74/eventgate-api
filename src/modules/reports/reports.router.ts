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
  readEventSales,
  readEventInventory,
  readEventAttendance,
  exportEventOrders,
} from './reports.controller.js';
import {
  auditLogQuerySchema,
  eventReportQuerySchema,
  eventReportOrdersQuerySchema,
} from './reports.schemas.js';
import { maintenanceStatus } from '../../jobs/maintenance.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import { z } from 'zod';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  adminReasonSchema,
  adminSummary,
  jobQuerySchema,
  listRecoveryJobs,
  safeAuditMetadata,
  retryRecoveryJob,
} from './admin-operations.service.js';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { sendList } from '../../shared/responses/api-response.js';
const organizerReportsRouter = Router({ mergeParams: true });
organizerReportsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
organizerReportsRouter.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store');
  next();
});
organizerReportsRouter.get(
  '/orders',
  validate({ params: eventIdParamsSchema, query: eventReportOrdersQuerySchema }),
  readEventOrders,
);
organizerReportsRouter.get(
  '/statistics',
  validate({ params: eventIdParamsSchema, query: eventReportQuerySchema }),
  readEventStats,
);
organizerReportsRouter.get(
  '/sales',
  validate({ params: eventIdParamsSchema, query: eventReportQuerySchema }),
  readEventSales,
);
organizerReportsRouter.get(
  '/inventory',
  validate({ params: eventIdParamsSchema, query: eventReportQuerySchema }),
  readEventInventory,
);
organizerReportsRouter.get(
  '/attendance',
  validate({ params: eventIdParamsSchema, query: eventReportQuerySchema }),
  readEventAttendance,
);
organizerReportsRouter.get(
  '/orders/export',
  validate({ params: eventIdParamsSchema, query: eventReportOrdersQuerySchema }),
  exportEventOrders,
);
const adminReportsRouter = Router();
adminReportsRouter.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store');
  next();
});
adminReportsRouter.get(
  '/summary/:panel',
  validate({
    params: z
      .object({ panel: z.enum(['users', 'events', 'sales', 'refunds', 'incidents']) })
      .strict(),
    query: z.object({}).strict(),
  }),
  async (request, response) =>
    sendSuccess(
      response,
      200,
      'Admin summary retrieved',
      await adminSummary(request.params.panel as string),
    ),
);
adminReportsRouter.get('/jobs', validate({ query: jobQuerySchema }), async (request, response) => {
  const query = jobQuerySchema.parse(request.query);
  const result = await listRecoveryJobs(query);
  sendList(response, 'Recovery jobs retrieved', result.jobs, paginationMeta(query, result.total));
});
adminReportsRouter.post(
  '/jobs/:jobId/retry',
  validate({
    params: z.object({ jobId: z.string().uuid() }).strict(),
    query: z.object({}).strict(),
    body: adminReasonSchema,
  }),
  async (request, response) =>
    sendSuccess(
      response,
      202,
      'Job requeued, not completed',
      await retryRecoveryJob(request.auth.id, request.params.jobId as string, request.body.reason),
    ),
);
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
        metadata: true,
        actor: { select: { id: true, displayName: true } },
      },
    });
    if (!log)
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Audit entry not found.' });
    const { metadata, ...safeLog } = log;
    const safeMetadata = safeAuditMetadata(metadata);
    sendSuccess(response, 200, 'Audit entry retrieved', { ...safeLog, metadata: safeMetadata });
  },
);
export { adminReportsRouter, organizerReportsRouter };
