import { OrderStatus, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { AuditLogQuery } from './reports.schemas.js';

const eventAccess = async (actor: { id: string; role: UserRole }, eventId: string) => {
  const event = await getPrisma().event.findUnique({ where: { id: eventId } });
  if (!event)
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found',
      errors: [{ code: 'NOT_FOUND', message: 'Event not found.' }],
    });
  if (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id)
    throw new AppError({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Event access denied',
      errors: [{ code: 'FORBIDDEN', message: 'You do not own this event.' }],
    });
  return event;
};

export const eventOrders = async (actor: { id: string; role: UserRole }, eventId: string) => {
  await eventAccess(actor, eventId);
  return getPrisma().order.findMany({
    where: { eventId },
    select: {
      id: true,
      quantity: true,
      totalAmountPaisaSnapshot: true,
      currency: true,
      status: true,
      createdAt: true,
      attendee: { select: { displayName: true, email: true } },
      ticketTier: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const eventStatistics = async (actor: { id: string; role: UserRole }, eventId: string) => {
  await eventAccess(actor, eventId);
  const [orders, tiers, checkedIn] = await Promise.all([
    getPrisma().order.groupBy({
      by: ['status'],
      where: { eventId },
      _count: { _all: true },
      _sum: { totalAmountPaisaSnapshot: true },
    }),
    getPrisma().ticketTier.findMany({
      where: { eventId },
      select: { id: true, name: true, capacity: true, soldQuantity: true, reservedQuantity: true },
    }),
    getPrisma().ticket.count({ where: { eventId, status: 'CHECKED_IN' } }),
  ]);
  const paid = orders.find((row) => row.status === OrderStatus.PAID);
  return {
    orders,
    tiers,
    paidRevenuePaisa: paid?._sum.totalAmountPaisaSnapshot ?? 0,
    paidOrderCount: paid?._count._all ?? 0,
    checkedIn,
  };
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
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.auditLog.count({ where }),
  ]);
  return { logs, total, page: query.page, limit: query.limit };
};
