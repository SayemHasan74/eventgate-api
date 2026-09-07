import type { RequestHandler } from 'express';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import {
  adminOperations,
  auditLogs,
  eventOrders,
  eventStatistics,
  platformStatistics,
} from './reports.service.js';
import type { AuditLogQuery } from './reports.schemas.js';
export const readEventOrders: RequestHandler = async (r, s) =>
  sendList(s, 'Event orders retrieved', await eventOrders(r.auth, r.params.eventId as string), {
    page: 1,
    limit: 100,
    total: 0,
    totalPages: 0,
  });
export const readEventStats: RequestHandler = async (r, s) =>
  sendSuccess(
    s,
    200,
    'Event statistics retrieved',
    await eventStatistics(r.auth, r.params.eventId as string),
  );
export const readPlatformStats: RequestHandler = async (_r, s) =>
  sendSuccess(s, 200, 'Platform statistics retrieved', await platformStatistics());
export const readOperations: RequestHandler = async (_r, s) =>
  sendSuccess(s, 200, 'Operations retrieved', await adminOperations());
export const readAuditLogs: RequestHandler = async (r, s) => {
  const result = await auditLogs(r.query as unknown as AuditLogQuery);
  sendList(s, 'Audit logs retrieved', result.logs, {
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.ceil(result.total / result.limit),
  });
};
