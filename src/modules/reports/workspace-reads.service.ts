import { activeAdmissionSql } from '../tickets/ticket-admission.js';
import { z } from 'zod';
import { PaymentStatus, Prisma } from '../../generated/prisma/client.js';
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
      ...(!attendeeId
        ? {
            providerTransactionId: true,
            events: {
              select: {
                id: true,
                eventType: true,
                receivedAt: true,
                processedAt: true,
                processingError: true,
              },
              orderBy: [{ receivedAt: 'asc' as const }, { id: 'asc' as const }],
              take: 100,
            },
          }
        : {}),
      order: {
        select: {
          id: true,
          eventId: true,
          attendeeId: true,
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
  const [payments, total] = await Promise.all([
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
  const [
    ordersByStatus,
    activeTickets,
    refundRequests,
    upcomingTickets,
    recentOrders,
    activeHoldsCount,
    activeHolds,
    refundAttention,
  ] = await Promise.all([
    database.order.groupBy({ by: ['status'], where: { attendeeId }, _count: true }),
    database.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count FROM "Ticket" t JOIN "Order" o ON o."id"=t."orderId"
      JOIN "Event" e ON e."id"=t."eventId" LEFT JOIN "PaymentAttempt" p ON p."id"=o."fulfilledPaymentAttemptId"
      WHERE t."attendeeId"=${attendeeId}::uuid AND ${activeAdmissionSql(now)}`),
    database.refund.count({
      where: {
        order: { attendeeId },
        OR: [
          { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'FAILED'] } },
          { needsInvestigation: true },
        ],
      },
    }),
    database.$queryRaw<Array<{ id: string; orderId: string; event: unknown }>>(Prisma.sql`
      SELECT t."id",t."orderId", json_build_object('id',e."id",'title',e."title",'slug',e."slug",
        'status',e."status",'venue',e."venue",'city',e."city",'startAt',e."startAt",'endAt',e."endAt",'deletedAt',e."deletedAt") AS event
      FROM "Ticket" t JOIN "Order" o ON o."id"=t."orderId" JOIN "Event" e ON e."id"=t."eventId"
      LEFT JOIN "PaymentAttempt" p ON p."id"=o."fulfilledPaymentAttemptId"
      WHERE t."attendeeId"=${attendeeId}::uuid AND e."startAt">${now} AND ${activeAdmissionSql(now)}
      ORDER BY e."startAt", t."id" LIMIT 5`),
    database.order.findMany({
      where: { attendeeId },
      select: {
        id: true,
        status: true,
        eventNameSnapshot: true,
        ticketTierNameSnapshot: true,
        quantity: true,
        totalAmountPaisaSnapshot: true,
        currency: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
    }),
    database.order.count({
      where: {
        attendeeId,
        status: 'PENDING_PAYMENT',
        reservationReleasedAt: null,
        reservationExpiresAt: { gt: now },
      },
    }),
    database.order.findMany({
      where: {
        attendeeId,
        status: 'PENDING_PAYMENT',
        reservationReleasedAt: null,
        reservationExpiresAt: { gt: now },
      },
      select: {
        id: true,
        eventNameSnapshot: true,
        ticketTierNameSnapshot: true,
        quantity: true,
        totalAmountPaisaSnapshot: true,
        reservationExpiresAt: true,
      },
      orderBy: [{ reservationExpiresAt: 'asc' }, { id: 'asc' }],
      take: 5,
    }),
    database.refund.findMany({
      where: {
        order: { attendeeId },
        OR: [
          { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'FAILED'] } },
          { needsInvestigation: true },
        ],
      },
      select: {
        id: true,
        orderId: true,
        status: true,
        amountPaisa: true,
        requestedAt: true,
        order: { select: { eventNameSnapshot: true } },
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 5,
    }),
  ]);
  return {
    ordersByStatus: Object.fromEntries(ordersByStatus.map((group) => [group.status, group._count])),
    activeTickets: activeTickets[0]?.count ?? 0,
    refundRequests,
    upcomingTickets,
    recentOrders,
    activeHoldsCount,
    activeHolds,
    refundAttention,
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
      database.$queryRaw<{ count: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS count FROM "Ticket" t
        JOIN "Order" o ON o."id" = t."orderId"
        JOIN "Event" e ON e."id" = t."eventId"
        JOIN "PaymentAttempt" p ON p."id" = o."fulfilledPaymentAttemptId"
        WHERE ${role === 'ADMIN' ? Prisma.sql`TRUE` : Prisma.sql`e."organizerId" = ${organizerId}::uuid`}
          AND ${activeAdmissionSql(now)}`),
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
    activeTickets: activeTickets[0]?.count ?? 0,
    recentEvents,
    upcomingEvents,
    draftEvents,
    serverTime: now,
  };
};
