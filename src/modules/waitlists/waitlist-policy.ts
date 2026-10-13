import type { Event, TicketTier, WaitlistEntry } from '../../generated/prisma/client.js';
import { tierCapabilities } from '../../shared/domain/capabilities.js';
export const waitlistNotice =
  'Get notified if tickets become available. Availability is first come, first served.';
export const activeWaitlistStatuses = ['WAITING', 'NOTIFIED'] as const;
export const waitlistClosed = (
  event: Pick<Event, 'status' | 'deletedAt' | 'startAt'>,
  tier: Pick<TicketTier, 'deletedAt' | 'salesEndAt'>,
  now = new Date(),
) =>
  event.status !== 'PUBLISHED' ||
  !!event.deletedAt ||
  !!tier.deletedAt ||
  event.startAt <= now ||
  tier.salesEndAt <= now;
export const effectiveAvailability = (event: Event, tier: TicketTier, now = new Date()) =>
  tierCapabilities(event, tier, false, now).saleState === 'OPEN'
    ? Math.max(0, tier.capacity - tier.reservedQuantity - tier.soldQuantity)
    : 0;
export function waitlistEligibility(
  event: Event,
  tier: TicketTier,
  entry: Pick<WaitlistEntry, 'status' | 'lastNotifiedAt'> | null,
  entitled: boolean,
  now = new Date(),
) {
  const sale = tierCapabilities(event, tier, false, now),
    cooldownUntil = entry?.lastNotifiedAt
      ? new Date(entry.lastNotifiedAt.getTime() + 3600000)
      : null;
  const reason = waitlistClosed(event, tier, now)
    ? 'This event or ticket window is closed.'
    : sale.saleState === 'PAUSED'
      ? 'Ticket sales are paused.'
      : sale.saleState === 'UPCOMING'
        ? 'Sales have not opened. Save the event for a sale-opening reminder.'
        : entitled
          ? 'You already have a valid ticket or active reservation for this tier.'
          : sale.availableQuantity > 0
            ? 'Tickets are available. Use the normal ticket selector.'
            : entry?.status === 'WAITING'
              ? 'You are already waiting for a stock alert.'
              : cooldownUntil && cooldownUntil > now
                ? 'You can re-arm only 60 minutes after your last alert.'
                : null;
  return {
    saleState: sale.saleState,
    availableQuantity: sale.availableQuantity,
    canJoin: reason === null,
    canLeave: !!entry && activeWaitlistStatuses.some((status) => status === entry.status),
    reason,
    cooldownUntil,
    notice: waitlistNotice,
  };
}
