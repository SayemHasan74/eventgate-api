import { z } from 'zod';
import { PaymentStatus, type Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  listFields,
  dateFields,
  dateRange,
  validDateRange,
  eventSummarySelect,
  paymentSummarySelect,
} from '../../shared/responses/read-contracts.js';
import { userSummarySelect } from '../users/users.service.js';

export const paymentListQuerySchema = z
  .object({ ...listFields, ...dateFields, status: z.nativeEnum(PaymentStatus).optional() })
  .strict()
  .refine(validDateRange);
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
const missing = (resource: string) =>
  new AppError({ statusCode: 404, code: 'NOT_FOUND', message: `${resource} not found.` });

export const getPayment = async (attemptId: string, attendeeId?: string) => {
  const payment = await getPrisma().paymentAttempt.findFirst({
    where: { id: attemptId, ...(attendeeId ? { order: { attendeeId } } : {}) },
    select: {
      ...paymentSummarySelect,
      checkoutExpiresAt: true,
      replayOfAttemptId: true,
      order: {
        select: {
          id: true,
          status: true,
          eventNameSnapshot: true,
          ticketTierNameSnapshot: true,
          fulfilledPaymentAttemptId: true,
          financialReviewRequired: true,
        },
      },
      refunds: {
        select: {
          id: true,
          reason: true,
          status: true,
          amountPaisa: true,
          needsInvestigation: true,
        },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      },
    },
  });
  if (!payment) throw missing('Payment');
  return { ...payment, serverTime: new Date() };
};

export const listPayments = async (
  query: PaymentListQuery,
  attendeeId?: string,
  orderId?: string,
) => {
  if (
    orderId &&
    attendeeId &&
    !(await getPrisma().order.findFirst({
      where: { id: orderId, attendeeId },
      select: { id: true },
    }))
  )
    throw missing('Order');
  const where: Prisma.PaymentAttemptWhereInput = {
    ...(attendeeId ? { order: { attendeeId } } : {}),
    ...(orderId ? { orderId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.startAfter || query.startBefore ? { initiatedAt: dateRange(query) } : {}),
    ...(query.search
      ? {
          order: {
            ...(attendeeId ? { attendeeId } : {}),
            eventNameSnapshot: { contains: query.search, mode: 'insensitive' },
          },
        }
      : {}),
  };
  const [payments, total] = await getPrisma().$transaction([
    getPrisma().paymentAttempt.findMany({
      where,
      select: paymentSummarySelect,
      orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    getPrisma().paymentAttempt.count({ where }),
  ]);
  return { payments, total };
};

export const getAdminUser = async (userId: string) => {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: {
      ...userSummarySelect,
      deletedAt: true,
      _count: { select: { organizedEvents: true, orders: true, tickets: true } },
    },
  });
  if (!user) throw missing('User');
  return { ...user, serverTime: new Date() };
};

export const attendeeOverview = async (attendeeId: string) => {
  const database = getPrisma();
  const now = new Date();
  const [ordersByStatus, activeTickets, refundRequests, upcomingTickets, recentOrders] =
    await Promise.all([
      database.order.groupBy({ by: ['status'], where: { attendeeId }, _count: true }),
      database.ticket.count({
        where: {
          attendeeId,
          status: 'ACTIVE',
          event: { status: 'PUBLISHED', endAt: { gte: now }, deletedAt: null },
        },
      }),
      database.refund.count({
        where: {
          order: { attendeeId },
          status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN'] },
        },
      }),
      database.ticket.findMany({
        where: {
          attendeeId,
          status: 'ACTIVE',
          event: { status: 'PUBLISHED', endAt: { gte: now }, deletedAt: null },
        },
        select: { id: true, orderId: true, event: { select: eventSummarySelect } },
        orderBy: [{ event: { startAt: 'asc' } }, { id: 'asc' }],
        take: 5,
      }),
      database.order.findMany({
        where: { attendeeId },
        select: {
          id: true,
          status: true,
          eventNameSnapshot: true,
          quantity: true,
          totalAmountPaisaSnapshot: true,
          currency: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
    ]);
  return {
    ordersByStatus: Object.fromEntries(ordersByStatus.map((group) => [group.status, group._count])),
    activeTickets,
    refundRequests,
    upcomingTickets,
    recentOrders,
    serverTime: now,
  };
};

export const organizerOverview = async (organizerId: string, role = 'ORGANIZER') => {
  const database = getPrisma();
  const where = { ...(role === 'ADMIN' ? {} : { organizerId }), deletedAt: null };
  const now = new Date();
  const [eventsByStatus, paidOrders, activeTickets, recentEvents, upcomingEvents, draftEvents] =
    await Promise.all([
      database.event.groupBy({ by: ['status'], where, _count: true }),
      database.order.count({ where: { event: where, status: 'PAID' } }),
      database.ticket.count({ where: { event: where, status: 'ACTIVE' } }),
      database.event.findMany({
        where,
        select: eventSummarySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
      database.event.findMany({
        where: { ...where, status: 'PUBLISHED', startAt: { gt: now } },
        select: eventSummarySelect,
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        take: 5,
      }),
      database.event.findMany({
        where: { ...where, status: 'DRAFT' },
        select: eventSummarySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
    ]);
  return {
    eventsByStatus: Object.fromEntries(eventsByStatus.map((group) => [group.status, group._count])),
    paidOrders,
    activeTickets,
    recentEvents,
    upcomingEvents,
    draftEvents,
    serverTime: now,
  };
};
