import type { UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import type { AuditLogQuery, EventReportQuery } from './reports.schemas.js';
import { eventSales, eventInventory, eventAttendance } from './event-report.service.js';

export const eventStatistics = async (
  actor: { id: string; role: UserRole },
  eventId: string,
  query: EventReportQuery = {},
) => {
  const [sales, inventory, attendance] = await Promise.all([
    eventSales(actor, eventId, query),
    eventInventory(actor, eventId, query),
    eventAttendance(actor, eventId, query),
  ]);
  return { ...sales, ...attendance, tiers: inventory.tiers, serverTime: new Date() };
};

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
  return { events, payments, refunds };
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
  const [logs, total] = await database.$transaction([
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
