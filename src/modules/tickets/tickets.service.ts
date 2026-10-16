import { toDataURL } from 'qrcode';

import { EventStatus, Prisma, TicketStatus, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { lockOrderGraph } from '../../lib/financial-locks.js';
import { AppError } from '../../shared/errors/app-error.js';

import type { CheckInHistoryQuery, CheckInInput, TicketListQuery } from './tickets.schemas.js';
import { checkInWindow, refundEligibility } from '../../shared/domain/capabilities.js';
import { effectiveAdmissionState } from './ticket-admission.js';

const notFound = (): AppError =>
  new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Ticket not found',
    errors: [{ code: 'NOT_FOUND', message: 'Ticket not found.' }],
  });

const conflict = (code: string, message: string, detail: string): AppError =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message: detail }] });

const ticketSelect = {
  id: true,
  orderId: true,
  eventId: true,
  ticketTierId: true,
  sequence: true,
  status: true,
  checkedInAt: true,
  createdAt: true,
  event: {
    select: {
      title: true,
      slug: true,
      venue: true,
      city: true,
      startAt: true,
      endAt: true,
      status: true,
      deletedAt: true,
      imageUrl: true,
    },
  },
  ticketTier: { select: { name: true } },
  order: {
    select: {
      status: true,
      financialReviewRequired: true,
      fulfilledPaymentAttemptId: true,
      event: { select: { status: true, startAt: true } },
      tickets: { select: { status: true } },
      fulfilledPaymentAttempt: {
        select: { status: true, providerTransactionId: true, replayOfAttemptId: true },
      },
      refunds: {
        select: {
          paymentAttemptId: true,
          status: true,
          reason: true,
          requestCount: true,
          needsInvestigation: true,
        },
      },
    },
  },
} satisfies Prisma.TicketSelect;

const ticketRead = (ticket: Prisma.TicketGetPayload<{ select: typeof ticketSelect }>) => {
  const { order, ...safeTicket } = ticket;
  const serverTime = new Date();
  return {
    ...safeTicket,
    effectiveAdmissionState: effectiveAdmissionState(ticket, serverTime),
    canShowQr:
      effectiveAdmissionState(ticket, serverTime) === 'ACTIVE' &&
      checkInWindow(ticket.event, serverTime).isOpen,
    checkInWindow: checkInWindow(ticket.event, serverTime),
    refundEligibility: refundEligibility(order, serverTime),
    serverTime,
  };
};

export const listMyTickets = async (attendeeId: string, query: TicketListQuery) => {
  const database = getPrisma();
  const where: Prisma.TicketWhereInput = {
    attendeeId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.orderId ? { orderId: query.orderId } : {}),
    ...(query.period !== 'all' || query.search
      ? {
          event: {
            ...(query.period === 'past'
              ? { endAt: { lt: new Date() } }
              : query.period === 'upcoming'
                ? { endAt: { gte: new Date() } }
                : {}),
            ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
          },
        }
      : {}),
  };
  const [tickets, total] = await database.$transaction([
    database.ticket.findMany({
      where,
      select: ticketSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.ticket.count({ where }),
  ]);
  return { tickets: tickets.map(ticketRead), total };
};

export const getMyTicket = async (attendeeId: string, ticketId: string) => {
  const ticket = await getPrisma().ticket.findFirst({
    where: { id: ticketId, attendeeId },
    select: ticketSelect,
  });
  if (!ticket) throw notFound();
  return ticketRead(ticket);
};
export const listMyBookings = async (attendeeId: string, query: TicketListQuery) => {
  const now = new Date();
  const where: Prisma.OrderWhereInput = {
    attendeeId,
    // The wallet contains purchases; refund records remain in refund/order history.
    status: 'PAID',
    financialReviewRequired: false,
    fulfilledPaymentAttempt: {
      is: {
        status: 'SUCCEEDED',
        providerTransactionId: { not: null },
        replayOfAttemptId: null,
        refunds: {
          none: {
            OR: [
              {
                status: {
                  in: ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'FAILED', 'SUCCEEDED'],
                },
              },
              { needsInvestigation: true },
            ],
          },
        },
      },
    },
    ...(query.orderId ? { id: query.orderId } : {}),
    tickets: { some: { status: query.status ?? { in: ['ACTIVE', 'CHECKED_IN'] } } },
    ...(query.period === 'past'
      ? { event: { endAt: { lt: now } } }
      : query.period === 'upcoming'
        ? { event: { endAt: { gte: now } } }
        : {}),
    ...(query.search
      ? {
          OR: [
            { eventNameSnapshot: { contains: query.search, mode: 'insensitive' } },
            { ticketTierNameSnapshot: { contains: query.search, mode: 'insensitive' } },
            { event: { city: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const database = getPrisma();
  const [orders, total] = await database.$transaction([
    database.order.findMany({
      where,
      select: {
        ...ticketSelect.order.select,
        id: true,
        eventId: true,
        ticketTierId: true,
        eventNameSnapshot: true,
        ticketTierNameSnapshot: true,
        quantity: true,
        event: ticketSelect.event,
        tickets: {
          where: { attendeeId },
          select: { id: true, sequence: true, status: true },
          orderBy: { sequence: 'asc' },
        },
      },
      orderBy: [{ event: { startAt: query.period === 'past' ? 'desc' : 'asc' } }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.order.count({ where }),
  ]);
  return {
    bookings: orders.map((order) => {
      const tickets = order.tickets.map((ticket) => ({
        ...ticket,
        effectiveAdmissionState: effectiveAdmissionState(
          { ...ticket, event: order.event, order },
          now,
        ),
      }));
      return {
        orderId: order.id,
        eventId: order.eventId,
        ticketTierId: order.ticketTierId,
        canBuyMore:
          order.event.status === 'PUBLISHED' && !order.event.deletedAt && order.event.startAt > now,
        event: order.event,
        eventNameSnapshot: order.eventNameSnapshot,
        tierName: order.ticketTierNameSnapshot,
        quantity: order.quantity,
        passCount: tickets.length,
        statusCounts: tickets.reduce<Record<string, number>>((counts, ticket) => {
          counts[ticket.effectiveAdmissionState] =
            (counts[ticket.effectiveAdmissionState] ?? 0) + 1;
          return counts;
        }, {}),
        tickets,
      };
    }),
    total,
  };
};

export const getMyTicketQr = async (attendeeId: string, ticketId: string) => {
  const qrToken = await serializableTransaction(async (tx) => {
    const identity = await tx.ticket.findFirst({
      where: { id: ticketId, attendeeId },
      select: { orderId: true },
    });
    if (!identity) throw notFound();
    await lockOrderGraph(tx, identity.orderId);
    const ticket = await tx.ticket.findFirst({
      where: { id: ticketId, attendeeId },
      select: { ...ticketSelect, qrToken: true },
    });
    if (!ticket) throw notFound();
    if (!ticketRead(ticket).canShowQr)
      throw conflict(
        'TICKET_ADMISSION_BLOCKED',
        'This pass is not eligible to display an admission QR.',
        'Review the ticket status and check-in window.',
      );
    return ticket.qrToken;
  });
  // The opaque 256-bit credential is the only QR content: no attendee data is exposed.
  return {
    ticketId,
    mimeType: 'image/png' as const,
    dataUrl: await toDataURL(qrToken, {
      type: 'image/png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 320,
    }),
  };
};

const assertEventCheckInAccess = async (actor: { id: string; role: UserRole }, eventId: string) => {
  const event = await getPrisma().event.findUnique({ where: { id: eventId } });
  if (!event) throw notFound();
  if (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id) {
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found',
      errors: [{ code: 'NOT_FOUND', message: 'Event not found.' }],
    });
  }
  return event;
};

export const checkInTicket = async (
  actor: { id: string; role: UserRole },
  eventId: string,
  input: CheckInInput,
) =>
  serializableTransaction(async (tx) => {
    // Lock only the requested event before inspecting a token. A foreign token
    // never causes us to read or return its attendee/order details.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event || (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id))
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Event not found' });
    const identity = await tx.ticket.findUnique({
      where: { qrToken: input.qrToken },
      select: { eventId: true, orderId: true },
    });
    if (!identity) return { resultCode: 'INVALID_TICKET' as const };
    if (identity.eventId !== eventId) return { resultCode: 'WRONG_EVENT' as const };
    await lockOrderGraph(tx, identity.orderId);
    const ticket = await tx.ticket.findFirst({
      where: { eventId, qrToken: input.qrToken },
      select: { ...ticketSelect, attendee: { select: { displayName: true } } },
    });
    if (!ticket) return { resultCode: 'INVALID_TICKET' as const };
    const now = new Date();
    const staffTicket = {
      id: ticket.id,
      sequence: ticket.sequence,
      checkedInAt: ticket.checkedInAt,
      ticketTier: { name: ticket.ticketTier.name },
      attendee: { displayName: ticket.attendee.displayName },
    };
    if (ticket.status === TicketStatus.CHECKED_IN)
      return { resultCode: 'ALREADY_CHECKED_IN' as const, ticket: staffTicket };
    if (!checkInWindow({ ...event }, now).isOpen) return { resultCode: 'WINDOW_CLOSED' as const };
    const admissionState = effectiveAdmissionState(ticket, now);
    if (admissionState !== 'ACTIVE')
      return { resultCode: 'ADMISSION_BLOCKED' as const, admissionState };
    const updated = await tx.ticket.updateMany({
      where: {
        id: ticket.id,
        eventId,
        status: TicketStatus.ACTIVE,
        event: { status: EventStatus.PUBLISHED, deletedAt: null },
      },
      data: { status: TicketStatus.CHECKED_IN, checkedInAt: now, checkedInById: actor.id },
    });
    if (updated.count !== 1)
      return { resultCode: 'ADMISSION_BLOCKED' as const, admissionState: 'VOIDED' };
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'TICKET_CHECKED_IN',
        entityType: 'TICKET',
        entityId: ticket.id,
        metadata: { eventId },
      },
    });
    return {
      resultCode: 'ACCEPTED' as const,
      id: ticket.id,
      status: 'CHECKED_IN' as const,
      ticket: { ...staffTicket, checkedInAt: now },
    };
  });

export const listCheckInHistory = async (
  actor: { id: string; role: UserRole },
  eventId: string,
  query: CheckInHistoryQuery,
) => {
  await assertEventCheckInAccess(actor, eventId);
  const where: Prisma.TicketWhereInput = {
    eventId,
    checkedInAt: { not: null },
    ...(query.search
      ? {
          OR: [
            { attendee: { displayName: { contains: query.search, mode: 'insensitive' } } },
            { ticketTier: { name: { contains: query.search, mode: 'insensitive' } } },
            ...(/^\d+$/.test(query.search) && Number(query.search) <= 2147483647
              ? [{ sequence: Number(query.search) }]
              : []),
          ],
        }
      : {}),
  };
  const database = getPrisma();
  const [tickets, total, checkedInCount] = await database.$transaction([
    database.ticket.findMany({
      where,
      select: {
        id: true,
        sequence: true,
        checkedInAt: true,
        attendee: { select: { displayName: true } },
        ticketTier: { select: { name: true } },
        checkedInBy: { select: { displayName: true } },
      },
      orderBy: [{ checkedInAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.ticket.count({ where }),
    database.ticket.count({ where: { eventId, checkedInAt: { not: null } } }),
  ]);
  return { tickets, page: query.page, limit: query.limit, total, checkedInCount };
};
