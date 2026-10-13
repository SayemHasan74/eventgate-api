import { z } from 'zod';
import { Prisma, type Job } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { writeNotification, emailAvailable } from '../notifications/notifications.service.js';
import {
  effectiveAvailability,
  waitlistClosed,
  activeWaitlistStatuses,
  waitlistNotice,
} from './waitlist-policy.js';
import { entitlementWhere } from './waitlists.service.js';
const waveSchema = z
  .object({
    eventId: z.string().uuid(),
    tierId: z.string().uuid(),
    wave: z.number().int().positive(),
    openedAt: z.string().datetime(),
    cursor: z.object({ joinedAt: z.string().datetime(), id: z.string().uuid() }).optional(),
  })
  .strict();
export async function recordInventoryRelease(
  tx: Prisma.TransactionClient,
  tierId: string,
  releasedQuantity: number,
  opening = false,
) {
  if (releasedQuantity <= 0 && !opening) return;
  const tier = await tx.ticketTier.findUniqueOrThrow({
      where: { id: tierId },
      include: { event: true },
    }),
    available = effectiveAvailability(tier.event, tier);
  if (!available || (!opening && available > releasedQuantity)) return;
  const updated = await tx.ticketTier.update({
    where: { id: tierId },
    data: { availabilityWave: { increment: 1 } },
  });
  const payload = {
    eventId: tier.eventId,
    tierId,
    wave: updated.availabilityWave,
    openedAt: new Date().toISOString(),
  };
  await tx.job.upsert({
    where: { deduplicationKey: `waitlist-wave:${tierId}:${payload.wave}` },
    update: {},
    create: {
      type: 'DISPATCH_WAITLIST_ALERTS',
      deduplicationKey: `waitlist-wave:${tierId}:${payload.wave}`,
      payload,
      runAt: new Date(),
    },
  });
}
export async function scheduleWaitlistClosure(tx: Prisma.TransactionClient, tierId: string) {
  const tier = await tx.ticketTier.findUniqueOrThrow({
    where: { id: tierId },
    include: { event: true },
  });
  const closes = new Date(Math.min(tier.salesEndAt.getTime(), tier.event.startAt.getTime()));
  await tx.job.upsert({
    where: { deduplicationKey: `waitlist-close:${tierId}:${closes.toISOString()}` },
    update: {},
    create: {
      type: 'CLOSE_TIER_WAITLIST',
      deduplicationKey: `waitlist-close:${tierId}:${closes.toISOString()}`,
      payload: { eventId: tier.eventId, tierId },
      runAt: closes,
    },
  });
}
async function lockTier(tx: Prisma.TransactionClient, eventId: string, tierId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Event" WHERE "id"=${eventId}::uuid FOR UPDATE`);
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "TicketTier" WHERE "id"=${tierId}::uuid AND "eventId"=${eventId}::uuid FOR UPDATE`,
  );
  return tx.ticketTier.findFirst({ where: { id: tierId, eventId }, include: { event: true } });
}
const leaseWhere = (job: Job) => ({
  id: job.id,
  status: 'RUNNING' as const,
  leaseToken: job.leaseToken,
  leaseExpiresAt: { gt: new Date() },
});
export async function closeTierWaitlist(job: Job) {
  const payload = z
    .object({ eventId: z.string().uuid(), tierId: z.string().uuid() })
    .strict()
    .parse(job.payload);
  return serializableTransaction(async (tx) => {
    const tier = await lockTier(tx, payload.eventId, payload.tierId);
    if (!tier || !waitlistClosed(tier.event, tier)) return true;
    const rows = await tx.waitlistEntry.findMany({
      where: { ticketTierId: tier.id, status: { in: [...activeWaitlistStatuses] } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    await tx.waitlistEntry.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, status: { in: [...activeWaitlistStatuses] } },
      data: { status: 'CLOSED', generation: { increment: 1 } },
    });
    if ((await tx.job.updateMany({ where: leaseWhere(job), data: { payload } })).count !== 1)
      throw new Error('Waitlist closure lease lost.');
    return rows.length < 100;
  });
}
export async function dispatchWaitlistWave(job: Job) {
  const payload = waveSchema.parse(job.payload);
  return serializableTransaction(
    async (tx) => {
      const tier = await lockTier(tx, payload.eventId, payload.tierId);
      if (
        !tier ||
        tier.availabilityWave !== payload.wave ||
        !effectiveAvailability(tier.event, tier)
      )
        return true;
      const now = new Date();
      const rows = await tx.waitlistEntry.findMany({
        where: {
          ticketTierId: tier.id,
          status: 'WAITING',
          joinedAt: { lte: new Date(payload.openedAt) },
          ...(payload.cursor
            ? {
                OR: [
                  { joinedAt: { gt: new Date(payload.cursor.joinedAt) } },
                  { joinedAt: new Date(payload.cursor.joinedAt), id: { gt: payload.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        take: 5,
      });
      for (const entry of rows) {
        if (entry.lastNotifiedAt && now.getTime() - entry.lastNotifiedAt.getTime() < 3600000)
          continue;
        const user = await tx.user.findUnique({
          where: { id: entry.userId },
          select: {
            status: true,
            role: true,
            deletedAt: true,
            emailVerifiedAt: true,
            notificationPreference: true,
          },
        });
        if (!user || user.status !== 'ACTIVE' || user.role !== 'ATTENDEE' || user.deletedAt)
          continue;
        const preference = user.notificationPreference;
        if (
          preference &&
          (!preference.waitlistAlerts ||
            (!preference.inAppEnabled &&
              !(preference.emailEnabled && user.emailVerifiedAt && emailAvailable())))
        )
          continue;
        const entitlement = await tx.order.findFirst({
          where: entitlementWhere(entry.userId, tier.id, now),
          select: { status: true },
        });
        if (entitlement) {
          if (entitlement.status === 'PAID')
            await tx.waitlistEntry.update({
              where: { id: entry.id },
              data: { status: 'FULFILLED', generation: { increment: 1 } },
            });
          continue;
        }
        await tx.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: 'NOTIFIED', lastNotifiedAt: now, lastAlertWave: payload.wave },
        });
        await writeNotification(tx, {
          userId: entry.userId,
          type: 'WAITLIST_STOCK_ALERT',
          title: 'Tickets became available',
          body: `${tier.event.title} — ${tier.name}. ${waitlistNotice} Stock may already have changed; this alert is not a reservation.`,
          actionPath: `/events/${tier.event.slug}/tickets?tierId=${tier.id}`,
          sourceKey: `waitlist:${entry.id}:${payload.wave}:${entry.generation}`,
        });
      }
      const next = rows.length
        ? {
            ...payload,
            cursor: { joinedAt: rows.at(-1)!.joinedAt.toISOString(), id: rows.at(-1)!.id },
          }
        : payload;
      if (
        (await tx.job.updateMany({ where: leaseWhere(job), data: { payload: next } })).count !== 1
      )
        throw new Error('Waitlist alert lease lost.');
      return rows.length < 5;
    },
    { timeout: 15000 },
  );
}
export async function waitlistAlertStillRelevant(
  tx: Prisma.TransactionClient,
  userId: string,
  sourceKey: string,
) {
  const match = /^waitlist:([0-9a-f-]{36}):(\d+):(\d+)$/.exec(sourceKey);
  if (!match) return false;
  const entry = await tx.waitlistEntry.findFirst({
    where: {
      id: match[1]!,
      userId,
      status: 'NOTIFIED',
      lastAlertWave: Number(match[2]),
      generation: Number(match[3]),
    },
    include: { ticketTier: { include: { event: true } }, user: { select: { role: true } } },
  });
  return (
    !!entry &&
    entry.ticketTier.availabilityWave === Number(match[2]) &&
    entry.user.role === 'ATTENDEE' &&
    !!effectiveAvailability(entry.ticketTier.event, entry.ticketTier) &&
    !(await tx.order.count({ where: entitlementWhere(userId, entry.ticketTierId) }))
  );
}
export async function scheduleWaitlistMaintenance(stopped: () => boolean) {
  const tiers = await getPrisma().$queryRaw<Array<{ id: string; eventId: string }>>(
    Prisma.sql`SELECT t."id",t."eventId" FROM "TicketTier" t JOIN "Event" e ON e."id"=t."eventId" LEFT JOIN "Job" j ON j."deduplicationKey"='waitlist-terminal:'||t."id"::text WHERE j."id" IS NULL AND (t."deletedAt" IS NOT NULL OR t."salesEndAt"<=NOW() OR e."status"<>'PUBLISHED' OR e."deletedAt" IS NOT NULL OR e."startAt"<=NOW()) AND EXISTS(SELECT 1 FROM "WaitlistEntry" w WHERE w."ticketTierId"=t."id" AND w."status" IN ('WAITING','NOTIFIED')) ORDER BY t."id" LIMIT 100`,
  );
  for (const tier of tiers) {
    if (stopped()) return;
    await getPrisma().job.upsert({
      where: { deduplicationKey: `waitlist-terminal:${tier.id}` },
      update: {},
      create: {
        type: 'CLOSE_TIER_WAITLIST',
        deduplicationKey: `waitlist-terminal:${tier.id}`,
        payload: { eventId: tier.eventId, tierId: tier.id },
        runAt: new Date(),
      },
    });
  }
}
