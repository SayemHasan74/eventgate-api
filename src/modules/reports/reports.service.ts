import { getPrisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import type { AuditLogQuery } from './reports.schemas.js';
export { combinedEventStatistics as eventStatistics } from './event-report.service.js';

export const platformStatistics = async () => {
  const database = getPrisma();
  const [users, events, orders, payments, refunds] = await Promise.all([
    database.user.groupBy({ by: ['role'], _count: { _all: true } }),
    database.event.groupBy({ by: ['status'], _count: { _all: true } }),
    database.order.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { totalAmountPaisaSnapshot: true },
    }),
    database.paymentAttempt.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { amountPaisa: true },
    }),
    database.refund.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { amountPaisa: true },
    }),
  ]);
  return { users, events, orders, payments, refunds };
};

export const adminOperations = async () => {
  const database = getPrisma();
  const [events, payments, refunds] = await Promise.all([
    database.event.findMany({
      select: {
        id: true,
        title: true,
        status: true,
        startAt: true,
        organizer: { select: { displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    database.paymentAttempt.findMany({
      select: {
        id: true,
        orderId: true,
        amountPaisa: true,
        currency: true,
        status: true,
        initiatedAt: true,
        completedAt: true,
        failureCode: true,
        failureMessage: true,
      },
      orderBy: { initiatedAt: 'desc' },
      take: 100,
    }),
    database.refund.findMany({
      select: {
        id: true,
        orderId: true,
        amountPaisa: true,
        currency: true,
        reason: true,
        status: true,
        requestedAt: true,
        completedAt: true,
        needsInvestigation: true,
        failureCode: true,
        failureMessage: true,
      },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    }),
  ]);
  return {
    events,
    payments,
    refunds,
    configuration: {
      payments: {
        configured: Boolean(env.SSLCOMMERZ_STORE_ID && env.SSLCOMMERZ_STORE_PASSWORD),
        mode: env.SSLCOMMERZ_IS_LIVE === 'true' ? 'LIVE' : 'SANDBOX',
        callbacksConfigured: Boolean(
          env.SSLCOMMERZ_SUCCESS_URL &&
          env.SSLCOMMERZ_FAIL_URL &&
          env.SSLCOMMERZ_CANCEL_URL &&
          env.SSLCOMMERZ_IPN_URL,
        ),
      },
      email: { configured: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM) },
      quickAccess: { enabled: env.PUBLIC_DEMO_ENABLED === 'true' },
    },
  };
};

export const auditLogs = async (query: AuditLogQuery) => {
  const where = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.startAfter || query.startBefore
      ? {
          createdAt: {
            ...(query.startAfter ? { gte: query.startAfter } : {}),
            ...(query.startBefore ? { lt: query.startBefore } : {}),
          },
        }
      : {}),
  };
  const database = getPrisma();
  const [logs, total] = await Promise.all([
    database.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        actor: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.auditLog.count({ where }),
  ]);
  return { logs, total, page: query.page, limit: query.limit };
};
