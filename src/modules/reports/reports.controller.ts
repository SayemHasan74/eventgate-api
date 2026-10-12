import type { RequestHandler } from 'express';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import {
  adminOperations,
  auditLogs,
  eventStatistics,
  platformStatistics,
} from './reports.service.js';
import {
  eventReportOrdersQuerySchema,
  eventReportQuerySchema,
  type AuditLogQuery,
} from './reports.schemas.js';
import {
  eventSales,
  eventInventory,
  eventAttendance,
  filteredEventOrders,
  eventOrderCsv,
} from './event-report.service.js';
export const readEventOrders: RequestHandler = async (r, s) => {
  const query = eventReportOrdersQuerySchema.parse(r.query);
  const result = await filteredEventOrders(r.auth, r.params.eventId as string, query);
  sendList(s, 'Event orders retrieved', result.orders, paginationMeta(query, result.total));
};
export const readEventStats: RequestHandler = async (r, s) =>
  sendSuccess(
    s,
    200,
    'Event statistics retrieved',
    await eventStatistics(
      r.auth,
      r.params.eventId as string,
      eventReportQuerySchema.parse(r.query),
    ),
  );
export const readEventSales: RequestHandler = async (r, s) =>
  sendSuccess(
    s,
    200,
    'Event sales retrieved',
    await eventSales(r.auth, r.params.eventId as string, eventReportQuerySchema.parse(r.query)),
  );
export const readEventInventory: RequestHandler = async (r, s) =>
  sendSuccess(
    s,
    200,
    'Event inventory retrieved',
    await eventInventory(r.auth, r.params.eventId as string, eventReportQuerySchema.parse(r.query)),
  );
export const readEventAttendance: RequestHandler = async (r, s) =>
  sendSuccess(
    s,
    200,
    'Event attendance retrieved',
    await eventAttendance(
      r.auth,
      r.params.eventId as string,
      eventReportQuerySchema.parse(r.query),
    ),
  );
export const exportEventOrders: RequestHandler = async (request, response) => {
  const abort = new AbortController();
  const stop = () => abort.abort();
  response.on('close', stop);
  const rows = eventOrderCsv(
    request.auth,
    request.params.eventId as string,
    eventReportOrdersQuerySchema.parse(request.query),
    abort.signal,
  );
  try {
    // Authorize and prepare before committing attachment headers.
    const first = await rows.next();
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="event-${request.params.eventId}-orders.csv"`,
    );
    await pipeline(
      Readable.from(
        (async function* () {
          if (!first.done) yield first.value;
          yield* rows;
        })(),
      ),
      response,
      { signal: abort.signal },
    );
  } catch (error) {
    if (!abort.signal.aborted) {
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
      else throw error;
    }
  } finally {
    response.off('close', stop);
    await rows.return();
  }
};
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
