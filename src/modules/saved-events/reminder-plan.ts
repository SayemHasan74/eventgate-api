import { createHash } from 'node:crypto';
import type { Event, SavedEvent, TicketTier, Order } from '../../generated/prisma/client.js';
export type ReminderIntent = {
  kind: 'SAVED_SALE' | 'SAVED_EVENT' | 'BOOKING_24H' | 'BOOKING_2H';
  eventId: string;
  eventVersion: number;
  userId: string;
  runAt: string;
  expiresAt: string;
  sourceKey: string;
  savedId?: string;
  savedVersion?: number;
  orderId?: string;
  tierId?: string;
  windowStart?: string;
  windowEnd?: string;
};
export const sourceDigest = (source: unknown) =>
  createHash('sha256').update(JSON.stringify(source)).digest('hex');
export const upcomingEvent = (
  event: Pick<Event, 'status' | 'deletedAt' | 'startAt'>,
  now = new Date(),
) => event.status === 'PUBLISHED' && !event.deletedAt && event.startAt > now;
export function savedReminderPlan(
  saved: SavedEvent,
  event: Event,
  tiers: TicketTier[],
  now = new Date(),
): ReminderIntent[] {
  if (!upcomingEvent(event, now)) return [];
  const base = {
    eventId: event.id,
    eventVersion: event.reminderVersion,
    userId: saved.userId,
    savedId: saved.id,
    savedVersion: saved.reminderVersion,
  };
  const reminders: ReminderIntent[] = [];
  const eventAt = new Date(event.startAt.getTime() - 24 * 3600000);
  if (saved.eventReminderEnabled && eventAt > now && eventAt >= saved.createdAt)
    reminders.push({
      ...base,
      kind: 'SAVED_EVENT',
      runAt: eventAt.toISOString(),
      expiresAt: event.startAt.toISOString(),
      sourceKey: `saved-event:${event.id}:${event.startAt.toISOString()}`,
    });
  if (saved.saleReminderEnabled)
    for (const tier of tiers) {
      if (
        tier.deletedAt ||
        tier.salesPaused ||
        tier.salesStartAt <= now ||
        tier.salesStartAt < saved.createdAt ||
        tier.salesEndAt <= tier.salesStartAt ||
        tier.salesStartAt >= event.startAt
      )
        continue;
      const windowStart = tier.salesStartAt.toISOString(),
        windowEnd = tier.salesEndAt.toISOString();
      reminders.push({
        ...base,
        kind: 'SAVED_SALE',
        tierId: tier.id,
        windowStart,
        windowEnd,
        runAt: windowStart,
        expiresAt: new Date(
          Math.min(tier.salesEndAt.getTime(), event.startAt.getTime()),
        ).toISOString(),
        sourceKey: `saved-sale:${tier.id}:${sourceDigest([windowStart, windowEnd])}`,
      });
    }
  return reminders;
}
export function bookingReminderPlan(
  order: Pick<Order, 'id' | 'attendeeId' | 'status' | 'paidAt' | 'financialReviewRequired'>,
  event: Event,
  now = new Date(),
): ReminderIntent[] {
  if (
    !upcomingEvent(event, now) ||
    order.status !== 'PAID' ||
    !order.paidAt ||
    order.financialReviewRequired
  )
    return [];
  return ([24, 2] as const).flatMap((hours) => {
    const at = new Date(event.startAt.getTime() - hours * 3600000);
    if (at <= now || at < order.paidAt!) return [];
    return [
      {
        kind: hours === 24 ? ('BOOKING_24H' as const) : ('BOOKING_2H' as const),
        eventId: event.id,
        eventVersion: event.reminderVersion,
        userId: order.attendeeId,
        orderId: order.id,
        runAt: at.toISOString(),
        expiresAt: new Date(
          event.startAt.getTime() - (hours === 24 ? 2 * 3600000 : 0),
        ).toISOString(),
        sourceKey: `booking-reminder:${order.id}:${hours}:${event.startAt.toISOString()}`,
      },
    ];
  });
}
