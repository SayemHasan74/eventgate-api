import { z } from 'zod';
import {
  Prisma,
  type Event,
  type Order,
  type SavedEvent,
  type Job,
} from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { writeNotification } from '../notifications/notifications.service.js';
import {
  bookingReminderPlan,
  savedReminderPlan,
  upcomingEvent,
  sourceDigest,
  type ReminderIntent,
} from './reminder-plan.js';
import { tierCapabilities } from '../../shared/domain/capabilities.js';
const intentSchema = z
  .object({
    kind: z.enum(['SAVED_SALE', 'SAVED_EVENT', 'BOOKING_24H', 'BOOKING_2H']),
    eventId: z.string().uuid(),
    eventVersion: z.number().int().nonnegative(),
    userId: z.string().uuid(),
    runAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    sourceKey: z.string().max(255),
    savedId: z.string().uuid().optional(),
    savedVersion: z.number().int().nonnegative().optional(),
    orderId: z.string().uuid().optional(),
    tierId: z.string().uuid().optional(),
    windowStart: z.string().datetime().optional(),
    windowEnd: z.string().datetime().optional(),
  })
  .strict();
async function persistIntents(tx: Prisma.TransactionClient, intents: ReminderIntent[]) {
  for (let offset = 0; offset < intents.length; offset += 100)
    await tx.job.createMany({
      skipDuplicates: true,
      data: intents.slice(offset, offset + 100).map((intent) => ({
        type: 'SEND_EVENT_REMINDER',
        deduplicationKey: `event-reminder:${sourceDigest(intent)}`,
        payload: { ...intent },
        runAt: new Date(intent.runAt),
      })),
    });
}
export async function scheduleSavedReminders(
  tx: Prisma.TransactionClient,
  saved: SavedEvent,
  event: Event,
) {
  const tiers = await tx.ticketTier.findMany({ where: { eventId: event.id, deletedAt: null } });
  await persistIntents(tx, savedReminderPlan(saved, event, tiers));
}
export async function scheduleBookingReminders(
  tx: Prisma.TransactionClient,
  order: Pick<Order, 'id' | 'attendeeId' | 'status' | 'paidAt' | 'financialReviewRequired'>,
  event: Event,
) {
  await persistIntents(tx, bookingReminderPlan(order, event));
}
export async function cancelSavedReminders(tx: Prisma.TransactionClient, savedId: string) {
  await tx.job.updateMany({
    where: {
      type: 'SEND_EVENT_REMINDER',
      status: { in: ['PENDING', 'RUNNING'] },
      payload: { path: ['savedId'], equals: savedId },
    },
    data: { status: 'CANCELLED', completedAt: new Date(), leaseToken: null, leaseExpiresAt: null },
  });
  await tx.notificationDelivery.updateMany({
    where: {
      channel: 'EMAIL',
      state: 'PENDING',
      notification: { reminderJob: { payload: { path: ['savedId'], equals: savedId } } },
    },
    data: { state: 'CANCELLED', nextAttemptAt: null, error: 'REMINDER_SOURCE_CHANGED' },
  });
}
export async function refreshEventReminders(tx: Prisma.TransactionClient, eventId: string) {
  const event = await tx.event.update({
    where: { id: eventId },
    data: { reminderVersion: { increment: 1 } },
  });
  await tx.job.updateMany({
    where: {
      type: { in: ['SEND_EVENT_REMINDER', 'REFRESH_EVENT_REMINDERS'] },
      status: { in: ['PENDING', 'RUNNING'] },
      payload: { path: ['eventId'], equals: eventId },
    },
    data: { status: 'CANCELLED', completedAt: new Date(), leaseToken: null, leaseExpiresAt: null },
  });
  await tx.notificationDelivery.updateMany({
    where: {
      channel: 'EMAIL',
      state: 'PENDING',
      notification: { reminderJob: { payload: { path: ['eventId'], equals: eventId } } },
    },
    data: { state: 'CANCELLED', nextAttemptAt: null, error: 'REMINDER_SOURCE_CHANGED' },
  });
  if (upcomingEvent(event))
    await tx.job.upsert({
      where: { deduplicationKey: `refresh-reminders:${eventId}:${event.reminderVersion}` },
      update: {},
      create: {
        type: 'REFRESH_EVENT_REMINDERS',
        deduplicationKey: `refresh-reminders:${eventId}:${event.reminderVersion}`,
        payload: { eventId, eventVersion: event.reminderVersion, phase: 'SAVES' },
        runAt: new Date(),
      },
    });
}
const leaseWhere = (job: Pick<Job, 'id' | 'leaseToken'>) => ({
  id: job.id,
  status: 'RUNNING' as const,
  leaseToken: job.leaseToken,
  leaseExpiresAt: { gt: new Date() },
});
export async function refreshReminderBatch(job: Job) {
  const payload = z
    .object({
      eventId: z.string().uuid(),
      eventVersion: z.number().int().nonnegative(),
      phase: z.enum(['SAVES', 'ORDERS']).default('SAVES'),
      cursor: z.string().uuid().optional(),
    })
    .strict()
    .parse(job.payload);
  return serializableTransaction(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Event" WHERE "id"=${payload.eventId}::uuid FOR UPDATE`,
      );
      const event = await tx.event.findUnique({ where: { id: payload.eventId } });
      if (!event || event.reminderVersion !== payload.eventVersion || !upcomingEvent(event))
        return true;
      const cursor = payload.cursor ? { id: { gt: payload.cursor } } : {};
      let next: typeof payload;
      let complete = false;
      if (payload.phase === 'SAVES') {
        const rows = await tx.savedEvent.findMany({
          where: { eventId: event.id, ...cursor },
          orderBy: { id: 'asc' },
          take: 10,
        });
        const tiers = await tx.ticketTier.findMany({
          where: { eventId: event.id, deletedAt: null },
        });
        for (const saved of rows) await persistIntents(tx, savedReminderPlan(saved, event, tiers));
        next =
          rows.length === 10
            ? { ...payload, cursor: rows.at(-1)!.id }
            : { eventId: event.id, eventVersion: event.reminderVersion, phase: 'ORDERS' };
      } else {
        const rows = await tx.order.findMany({
          where: {
            eventId: event.id,
            status: 'PAID',
            tickets: { some: { status: 'ACTIVE' } },
            ...cursor,
          },
          orderBy: { id: 'asc' },
          take: 10,
        });
        for (const order of rows) await scheduleBookingReminders(tx, order, event);
        complete = rows.length < 10;
        next = rows.length ? { ...payload, cursor: rows.at(-1)!.id } : payload;
      }
      const updated = await tx.job.updateMany({
        where: leaseWhere(job),
        data: { payload: { ...next } },
      });
      if (updated.count !== 1) throw new Error('Reminder scheduling lease lost.');
      return complete;
    },
    { timeout: 15000 },
  );
}
export async function reminderStillRelevant(
  tx: Prisma.TransactionClient,
  job: Pick<Job, 'payload'>,
  userId: string,
  now = new Date(),
) {
  const parsed = intentSchema.safeParse(job.payload);
  if (!parsed.success) return null;
  const intent = parsed.data;
  if (intent.userId !== userId || new Date(intent.runAt) > now || new Date(intent.expiresAt) <= now)
    return null;
  const event = await tx.event.findUnique({ where: { id: intent.eventId } });
  if (!event || event.reminderVersion !== intent.eventVersion || !upcomingEvent(event, now))
    return null;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, deletedAt: true },
  });
  if (!user || user.role !== 'ATTENDEE' || user.status !== 'ACTIVE' || user.deletedAt) return null;
  if (intent.kind.startsWith('SAVED')) {
    if (!intent.savedId || intent.savedVersion === undefined) return null;
    const saved = await tx.savedEvent.findFirst({
      where: { id: intent.savedId, userId, eventId: event.id },
    });
    if (
      !saved ||
      saved.reminderVersion !== intent.savedVersion ||
      saved.createdAt > new Date(intent.runAt)
    )
      return null;
    if (intent.kind === 'SAVED_EVENT') {
      if (
        !saved.eventReminderEnabled ||
        event.startAt.getTime() - 24 * 3600000 !== new Date(intent.runAt).getTime()
      )
        return null;
      const preference = await tx.notificationPreference.findUnique({
        where: { userId },
        select: { bookingUpdates: true },
      });
      if (
        preference?.bookingUpdates !== false &&
        (await tx.order.count({
          where: {
            attendeeId: userId,
            eventId: event.id,
            status: 'PAID',
            tickets: { some: { status: 'ACTIVE' } },
          },
        }))
      )
        return null;
    } else {
      if (!saved.saleReminderEnabled || !intent.tierId) return null;
      const tier = await tx.ticketTier.findFirst({
        where: { id: intent.tierId, eventId: event.id, deletedAt: null },
      });
      if (
        !tier ||
        tier.salesStartAt.toISOString() !== intent.windowStart ||
        tier.salesEndAt.toISOString() !== intent.windowEnd ||
        tierCapabilities(event, tier, false, now).saleState !== 'OPEN'
      )
        return null;
      if (
        await tx.order.count({
          where: {
            attendeeId: userId,
            ticketTierId: tier.id,
            OR: [
              { status: 'PAID', tickets: { some: { status: 'ACTIVE' } } },
              {
                status: 'PENDING_PAYMENT',
                reservationReleasedAt: null,
                reservationExpiresAt: { gt: now },
              },
            ],
          },
        })
      )
        return null;
    }
    return { intent, event, actionPath: `/events/${event.slug}` };
  }
  if (!intent.orderId) return null;
  const order = await tx.order.findFirst({
    where: {
      id: intent.orderId,
      attendeeId: userId,
      eventId: event.id,
      status: 'PAID',
      financialReviewRequired: false,
      tickets: { some: { status: 'ACTIVE' } },
      refunds: {
        none: {
          OR: [
            { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED'] } },
            { needsInvestigation: true },
          ],
        },
      },
    },
  });
  if (!order?.paidAt || order.paidAt > new Date(intent.runAt)) return null;
  const hours = intent.kind === 'BOOKING_24H' ? 24 : 2;
  if (event.startAt.getTime() - hours * 3600000 !== new Date(intent.runAt).getTime()) return null;
  return { intent, event, actionPath: `/orders/${order.id}` };
}
export async function sendEventReminder(job: Job) {
  const intent = intentSchema.parse(job.payload);
  await serializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id"=${intent.eventId}::uuid FOR UPDATE`,
    );
    const relevant = await reminderStillRelevant(tx, job, intent.userId);
    if (!relevant) return;
    const { event, actionPath } = relevant;
    const title =
      intent.kind === 'SAVED_SALE' ? 'Ticket sales have opened' : 'Your upcoming event reminder';
    const starts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(event.startAt);
    await writeNotification(tx, {
      userId: intent.userId,
      type:
        intent.kind === 'SAVED_SALE'
          ? 'SAVED_SALE_REMINDER'
          : intent.kind === 'SAVED_EVENT'
            ? 'SAVED_EVENT_REMINDER'
            : 'BOOKING_REMINDER',
      title,
      body:
        intent.kind === 'SAVED_SALE'
          ? `${event.title}: this ticket window is open. Saving does not reserve stock; availability is checked when you book.`
          : `${event.title}: starts ${starts} (Bangladesh time). Scheduled ${intent.kind === 'BOOKING_2H' ? '2-hour' : '24-hour'} reminder; check the current venue and booking before you go.`,
      actionPath,
      sourceKey: intent.sourceKey,
      reminderJobId: job.id,
    });
    const fenced = await tx.job.updateMany({
      where: leaseWhere(job),
      data: { payload: job.payload as Prisma.InputJsonValue },
    });
    if (fenced.count !== 1) throw new Error('Reminder delivery lease lost.');
  });
}
export async function bootstrapReminderJobs(stopped: () => boolean) {
  const rows = await getPrisma().$queryRaw<Array<{ id: string; reminderVersion: number }>>(
    Prisma.sql`SELECT e."id",e."reminderVersion" FROM "Event" e LEFT JOIN "Job" j ON j."deduplicationKey"='refresh-reminders:'||e."id"::text||':'||e."reminderVersion"::text WHERE e."status"='PUBLISHED' AND e."deletedAt" IS NULL AND e."startAt">NOW() AND j."id" IS NULL AND (EXISTS(SELECT 1 FROM "SavedEvent" s WHERE s."eventId"=e."id") OR EXISTS(SELECT 1 FROM "Order" o WHERE o."eventId"=e."id" AND o."status"='PAID')) ORDER BY e."id" LIMIT 50`,
  );
  for (const event of rows) {
    if (stopped()) return;
    await getPrisma().job.upsert({
      where: { deduplicationKey: `refresh-reminders:${event.id}:${event.reminderVersion}` },
      update: {},
      create: {
        type: 'REFRESH_EVENT_REMINDERS',
        deduplicationKey: `refresh-reminders:${event.id}:${event.reminderVersion}`,
        payload: { eventId: event.id, eventVersion: event.reminderVersion, phase: 'SAVES' },
        runAt: new Date(),
      },
    });
  }
}
