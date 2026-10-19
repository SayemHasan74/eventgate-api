import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { tierCapabilities } from '../../shared/domain/capabilities.js';
import { cancelSavedReminders, scheduleSavedReminders } from './reminders.service.js';
import { upcomingEvent } from './reminder-plan.js';
export const savedQuery = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    period: z.enum(['all', 'upcoming', 'past']).default('all'),
  })
  .strict();
export const saveInput = z
  .object({
    saleReminderEnabled: z.boolean().optional(),
    eventReminderEnabled: z.boolean().optional(),
  })
  .strict();
const savedSelect = {
  id: true,
  eventId: true,
  createdAt: true,
  saleReminderEnabled: true,
  eventReminderEnabled: true,
} satisfies Prisma.SavedEventSelect;
async function lockSave(tx: Prisma.TransactionClient, userId: string, eventId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id"=${userId}::uuid FOR SHARE`);
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
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Event" WHERE "id"=${eventId}::uuid FOR UPDATE`);
}
export const membershipBatchQuery = z
  .object({
    eventIds: z.preprocess(
      (value) => (typeof value === 'string' ? value.split(',') : value),
      z.array(z.string().uuid()).min(1).max(100),
    ),
  })
  .strict();
export async function savedMemberships(userId: string, eventIds: string[]) {
  const db = getPrisma();
  const ids = [...new Set(eventIds)];
  const [saved, events] = await Promise.all([
    db.savedEvent.findMany({ where: { userId, eventId: { in: ids } }, select: savedSelect }),
    db.event.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, deletedAt: true, startAt: true },
    }),
  ]);
  const savedByEvent = new Map(saved.map((row) => [row.eventId, row]));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const serverTime = new Date();
  return ids.map((eventId) => {
    const event = eventsById.get(eventId);
    return {
      eventId,
      saved: savedByEvent.get(eventId) ?? null,
      canSave: !!event && upcomingEvent(event),
      serverTime,
    };
  });
}
export async function savedMembership(userId: string, eventId: string) {
  const db = getPrisma();
  const [saved, event] = await Promise.all([
    db.savedEvent.findUnique({
      where: { userId_eventId: { userId, eventId } },
      select: savedSelect,
    }),
    db.event.findUnique({
      where: { id: eventId },
      select: { status: true, deletedAt: true, startAt: true },
    }),
  ]);
  return { eventId, saved, canSave: !!event && upcomingEvent(event), serverTime: new Date() };
}
export async function saveEvent(userId: string, eventId: string, input: z.infer<typeof saveInput>) {
  await serializableTransaction(async (tx) => {
    await lockSave(tx, userId, eventId);
    const event = await tx.event.findUnique({ where: { id: eventId } });
    const existing = await tx.savedEvent.findUnique({
      where: { userId_eventId: { userId, eventId } },
    });
    if (!event || (!existing && !upcomingEvent(event)))
      throw new AppError({
        statusCode: 409,
        code: 'EVENT_NOT_SAVEABLE',
        message: 'Only published, upcoming events can be newly saved.',
      });
    const data = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as { saleReminderEnabled?: boolean; eventReminderEnabled?: boolean };
    const changed =
      existing &&
      Object.entries(data).some(([key, value]) => existing[key as keyof typeof data] !== value);
    if (changed) await cancelSavedReminders(tx, existing.id);
    const saved = await tx.savedEvent.upsert({
      where: { userId_eventId: { userId, eventId } },
      update: { ...data, ...(changed ? { reminderVersion: { increment: 1 } } : {}) },
      create: { userId, eventId, ...data },
    });
    await scheduleSavedReminders(tx, saved, event);
  });
  return savedMembership(userId, eventId);
}
export async function removeSavedEvent(userId: string, eventId: string) {
  return serializableTransaction(async (tx) => {
    await lockSave(tx, userId, eventId);
    const saved = await tx.savedEvent.findUnique({
      where: { userId_eventId: { userId, eventId } },
    });
    if (saved) {
      await cancelSavedReminders(tx, saved.id);
      await tx.savedEvent.delete({ where: { id: saved.id } });
    }
    return { removed: true };
  });
}
export async function listSavedEvents(userId: string, query: z.infer<typeof savedQuery>) {
  const now = new Date(),
    db = getPrisma();
  const where = {
    userId,
    ...(query.period === 'upcoming'
      ? { event: { status: 'PUBLISHED' as const, deletedAt: null, startAt: { gt: now } } }
      : query.period === 'past'
        ? {
            event: {
              OR: [
                { status: { not: 'PUBLISHED' as const } },
                { deletedAt: { not: null } },
                { startAt: { lte: now } },
              ],
            },
          }
        : {}),
  };
  const [rows, total] = await db.$transaction([
    db.savedEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        ...savedSelect,
        event: {
          select: {
            id: true,
            title: true,
            slug: true,
            startAt: true,
            endAt: true,
            status: true,
            deletedAt: true,
            venue: true,
            city: true,
            imageUrl: true,
            ticketTiers: {
              where: { deletedAt: null },
              select: {
                id: true,
                name: true,
                pricePaisa: true,
                salesStartAt: true,
                salesEndAt: true,
                salesPaused: true,
                capacity: true,
                reservedQuantity: true,
                soldQuantity: true,
              },
            },
          },
        },
      },
    }),
    db.savedEvent.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((row) => {
      const tiers = row.event.ticketTiers.map((tier) => {
        const { saleState, availableQuantity } = tierCapabilities(row.event, tier, false, now);
        return {
          id: tier.id,
          name: tier.name,
          pricePaisa: tier.pricePaisa,
          salesStartAt: tier.salesStartAt,
          salesEndAt: tier.salesEndAt,
          saleState,
          availableQuantity,
        };
      });
      const { ticketTiers, ...event } = row.event;
      void ticketTiers;
      return {
        ...row,
        event: {
          ...event,
          ticketTiers: tiers,
          canView: event.status === 'PUBLISHED' && !event.deletedAt,
          canBuy: upcomingEvent(event, now) && tiers.some((tier) => tier.saleState === 'OPEN'),
        },
        serverTime: now,
      };
    }),
  };
}
