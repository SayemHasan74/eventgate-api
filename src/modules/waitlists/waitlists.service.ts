import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { waitlistEligibility, activeWaitlistStatuses } from './waitlist-policy.js';
import { scheduleWaitlistClosure } from './availability.service.js';
export const waitlistQuery = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['WAITING', 'NOTIFIED', 'LEFT', 'FULFILLED', 'CLOSED']).optional(),
  })
  .strict();
export const entrySelect = {
  id: true,
  ticketTierId: true,
  status: true,
  joinedAt: true,
  lastNotifiedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WaitlistEntrySelect;
export const entitlementWhere = (
  userId: string,
  tierId: string,
  now = new Date(),
): Prisma.OrderWhereInput => ({
  attendeeId: userId,
  ticketTierId: tierId,
  OR: [
    { status: 'PAID', tickets: { some: { status: { in: ['ACTIVE', 'CHECKED_IN'] } } } },
    { status: 'PENDING_PAYMENT', reservationReleasedAt: null, reservationExpiresAt: { gt: now } },
  ],
});
export async function waitlistMembership(
  userId: string,
  eventId: string,
  tierId: string,
  db: Prisma.TransactionClient = getPrisma(),
) {
  const tier = await db.ticketTier.findFirst({
    where: { id: tierId, eventId },
    include: { event: true },
  });
  if (!tier)
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Ticket tier not found.' });
  const [entry, count] = await Promise.all([
    db.waitlistEntry.findUnique({
      where: { userId_ticketTierId: { userId, ticketTierId: tierId } },
      select: entrySelect,
    }),
    db.order.count({ where: entitlementWhere(userId, tierId) }),
  ]);
  return {
    eventId,
    tierId,
    entry,
    ...waitlistEligibility(tier.event, tier, entry, count > 0),
    serverTime: new Date(),
  };
}
async function lockMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  eventId: string,
  tierId: string,
) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Event" WHERE "id"=${eventId}::uuid FOR UPDATE`);
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "TicketTier" WHERE "id"=${tierId}::uuid AND "eventId"=${eventId}::uuid FOR UPDATE`,
  );
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, deletedAt: true },
  });
  if (!user || user.role !== 'ATTENDEE' || user.status !== 'ACTIVE' || user.deletedAt)
    throw new AppError({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'An active attendee account is required.',
    });
}
export async function joinWaitlist(userId: string, eventId: string, tierId: string) {
  return serializableTransaction(async (tx) => {
    await lockMembership(tx, userId, eventId, tierId);
    const membership = await waitlistMembership(userId, eventId, tierId, tx);
    if (membership.entry?.status === 'WAITING') return membership;
    if (!membership.canJoin)
      throw new AppError({
        statusCode: 409,
        code: 'WAITLIST_NOT_ELIGIBLE',
        message: membership.reason ?? 'This waitlist cannot be joined.',
      });
    await tx.waitlistEntry.upsert({
      where: { userId_ticketTierId: { userId, ticketTierId: tierId } },
      update: { status: 'WAITING', joinedAt: new Date(), generation: { increment: 1 } },
      create: { userId, ticketTierId: tierId },
    });
    await scheduleWaitlistClosure(tx, tierId);
    return waitlistMembership(userId, eventId, tierId, tx);
  });
}
export async function leaveWaitlist(userId: string, eventId: string, tierId: string) {
  return serializableTransaction(async (tx) => {
    await lockMembership(tx, userId, eventId, tierId);
    await tx.waitlistEntry.updateMany({
      where: {
        userId,
        ticketTierId: tierId,
        ticketTier: { eventId },
        status: { in: [...activeWaitlistStatuses] },
      },
      data: { status: 'LEFT', generation: { increment: 1 } },
    });
    return { left: true };
  });
}
export async function fulfillWaitlist(
  tx: Prisma.TransactionClient,
  userId: string,
  tierId: string,
) {
  await tx.waitlistEntry.updateMany({
    where: { userId, ticketTierId: tierId, status: { in: [...activeWaitlistStatuses] } },
    data: { status: 'FULFILLED', generation: { increment: 1 } },
  });
}
export async function closeEventWaitlists(tx: Prisma.TransactionClient, eventId: string) {
  await tx.waitlistEntry.updateMany({
    where: { ticketTier: { eventId }, status: { in: [...activeWaitlistStatuses] } },
    data: { status: 'CLOSED', generation: { increment: 1 } },
  });
}
export async function listWaitlists(userId: string, query: z.infer<typeof waitlistQuery>) {
  const db = getPrisma(),
    where = { userId, ...(query.status ? { status: query.status } : {}) };
  const [rows, total] = await db.$transaction([
    db.waitlistEntry.findMany({
      where,
      select: { ...entrySelect, ticketTier: { include: { event: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.waitlistEntry.count({ where }),
  ]);
  const now = new Date();
  const entries = await Promise.all(
    rows.map(async (row) => {
      const tier = row.ticketTier,
        event = tier.event,
        count = await db.order.count({ where: entitlementWhere(userId, tier.id, now) });
      const { ticketTier, ...entry } = row;
      void ticketTier;
      return {
        ...entry,
        ...waitlistEligibility(event, tier, row, count > 0, now),
        event: {
          id: event.id,
          title: event.title,
          slug: event.slug,
          startAt: event.startAt,
          venue: event.venue,
          city: event.city,
          canView: event.status === 'PUBLISHED' && !event.deletedAt,
        },
        tier: { id: tier.id, name: tier.name, pricePaisa: tier.pricePaisa },
        serverTime: now,
      };
    }),
  );
  return { entries, total };
}
