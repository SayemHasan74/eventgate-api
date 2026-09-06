import { toString } from 'qrcode';

import { EventStatus, Prisma, TicketStatus, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import type { CheckInHistoryQuery, CheckInInput } from './tickets.schemas.js';

const checkInOpenLeadMilliseconds = 2 * 60 * 60 * 1000;

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
    select: { title: true, slug: true, venue: true, city: true, startAt: true, endAt: true },
  },
  ticketTier: { select: { name: true } },
} satisfies Prisma.TicketSelect;

export const listMyTickets = (attendeeId: string) =>
  getPrisma().ticket.findMany({
    where: { attendeeId },
    select: ticketSelect,
    orderBy: { createdAt: 'desc' },
  });

export const getMyTicket = async (attendeeId: string, ticketId: string) => {
  const ticket = await getPrisma().ticket.findFirst({
    where: { id: ticketId, attendeeId },
    select: ticketSelect,
  });
  if (!ticket) throw notFound();
  return ticket;
};

export const getMyTicketQrSvg = async (attendeeId: string, ticketId: string): Promise<string> => {
  const ticket = await getPrisma().ticket.findFirst({
    where: { id: ticketId, attendeeId, status: TicketStatus.ACTIVE },
    select: { qrToken: true },
  });
  if (!ticket) throw notFound();
  // The opaque 256-bit credential is the only QR content: no attendee data is exposed.
  return toString(ticket.qrToken, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
};

const assertEventCheckInAccess = async (actor: { id: string; role: UserRole }, eventId: string) => {
  const event = await getPrisma().event.findUnique({ where: { id: eventId } });
  if (!event) throw notFound();
  if (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id) {
    throw new AppError({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'You cannot check attendees in for this event',
      errors: [
        { code: 'FORBIDDEN', message: 'Only the event organizer or an admin may check in.' },
      ],
    });
  }
  return event;
};

const assertCheckInWindow = (event: { status: EventStatus; startAt: Date; endAt: Date }) => {
  const now = new Date();
  if (
    event.status !== EventStatus.PUBLISHED ||
    now < new Date(event.startAt.getTime() - checkInOpenLeadMilliseconds) ||
    now > event.endAt
  ) {
    throw conflict(
      'CHECK_IN_NOT_OPEN',
      'Check-in is not open',
      'Check-in opens two hours before a published event and closes when it ends.',
    );
  }
};

export const checkInTicket = async (
  actor: { id: string; role: UserRole },
  eventId: string,
  input: CheckInInput,
) => {
  const event = await assertEventCheckInAccess(actor, eventId);
  assertCheckInWindow(event);
  const checkedInAt = new Date();
  return getPrisma().$transaction(
    async (tx) => {
      const updated = await tx.ticket.updateMany({
        where: {
          eventId,
          qrToken: input.qrToken,
          status: TicketStatus.ACTIVE,
          event: { status: EventStatus.PUBLISHED },
        },
        data: { status: TicketStatus.CHECKED_IN, checkedInAt, checkedInById: actor.id },
      });
      if (updated.count !== 1) {
        const ticket = await tx.ticket.findFirst({
          where: { eventId, qrToken: input.qrToken },
          select: { status: true },
        });
        if (!ticket) throw notFound();
        throw conflict(
          'TICKET_NOT_CHECK_IN_ELIGIBLE',
          'Ticket cannot be checked in',
          `Ticket status is ${ticket.status}.`,
        );
      }
      const ticket = await tx.ticket.findFirst({
        where: { eventId, qrToken: input.qrToken, status: TicketStatus.CHECKED_IN },
        select: ticketSelect,
      });
      if (!ticket) throw new Error('Checked-in ticket could not be read.');
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'TICKET_CHECKED_IN',
          entityType: 'TICKET',
          entityId: ticket.id,
          metadata: { eventId },
        },
      });
      return ticket;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export const listCheckInHistory = async (
  actor: { id: string; role: UserRole },
  eventId: string,
  query: CheckInHistoryQuery,
) => {
  await assertEventCheckInAccess(actor, eventId);
  const where = { eventId, status: TicketStatus.CHECKED_IN };
  const database = getPrisma();
  const [tickets, total] = await database.$transaction([
    database.ticket.findMany({
      where,
      select: {
        id: true,
        sequence: true,
        checkedInAt: true,
        attendee: { select: { displayName: true, email: true } },
        ticketTier: { select: { name: true } },
        checkedInBy: { select: { displayName: true } },
      },
      orderBy: { checkedInAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.ticket.count({ where }),
  ]);
  return { tickets, page: query.page, limit: query.limit, total };
};
