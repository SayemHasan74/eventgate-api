type Event = {
  status: string;
  title: string;
  description: string;
  category: string;
  venue: string;
  city: string;
  address: string;
  startAt: Date;
  endAt: Date;
  deletedAt?: Date | null;
};
type Tier = {
  id: string;
  name: string;
  pricePaisa: number;
  capacity: number;
  reservedQuantity: number;
  soldQuantity: number;
  salesStartAt: Date;
  salesEndAt: Date;
  salesPaused: boolean;
  deletedAt: Date | null;
};
export const publicationReadiness = (event: Event, tiers: Tier[], now = new Date()) => {
  const blockers: { code: string; message: string; field?: string; tierId?: string }[] = [];
  if (event.deletedAt || event.status !== 'DRAFT')
    blockers.push({
      code: 'EVENT_NOT_DRAFT',
      message: 'Only an undeleted draft can be published.',
    });
  if (event.startAt <= now)
    blockers.push({
      code: 'EVENT_START_PASSED',
      field: 'startAt',
      message: 'The event must start in the future.',
    });
  if (event.endAt <= event.startAt)
    blockers.push({
      code: 'INVALID_EVENT_DATES',
      field: 'endAt',
      message: 'Event end must follow its start.',
    });
  for (const [field, minimum] of Object.entries({
    title: 3,
    description: 20,
    category: 2,
    venue: 2,
    city: 2,
    address: 5,
  })) {
    if (String(event[field as keyof Event] ?? '').trim().length < minimum)
      blockers.push({
        code: 'EVENT_DETAILS_INCOMPLETE',
        field,
        message: `Complete the event ${field}.`,
      });
  }
  const checks = tiers
    .filter((tier) => !tier.deletedAt)
    .map((tier) => {
      const reasons: string[] = [];
      if (tier.salesPaused) reasons.push('Sales are paused.');
      if (tier.capacity < 1) reasons.push('Capacity must be positive.');
      if (tier.salesEndAt <= tier.salesStartAt) reasons.push('Sales end must follow sales start.');
      if (tier.salesEndAt <= now) reasons.push('Sales window has already closed.');
      if (tier.salesEndAt > event.startAt) reasons.push('Sales end exceeds the event start.');
      return {
        id: tier.id,
        name: tier.name,
        pricePaisa: tier.pricePaisa,
        capacity: tier.capacity,
        reservedQuantity: tier.reservedQuantity,
        soldQuantity: tier.soldQuantity,
        availableQuantity: Math.max(0, tier.capacity - tier.reservedQuantity - tier.soldQuantity),
        salesStartAt: tier.salesStartAt,
        salesEndAt: tier.salesEndAt,
        salesPaused: tier.salesPaused,
        eligible: reasons.length === 0,
        reasons,
      };
    });
  if (!checks.some((tier) => tier.eligible)) {
    blockers.push({
      code: 'NO_ELIGIBLE_TIER',
      message:
        'Save at least one unpaused tier with capacity and a valid sales window ending in the future, no later than the event start.',
    });
    for (const tier of checks)
      for (const message of tier.reasons)
        blockers.push({
          code: 'TIER_NOT_READY',
          tierId: tier.id,
          message: `${tier.name}: ${message}`,
        });
  }
  return { ready: blockers.length === 0, blockers, tiers: checks, checkedAt: now };
};
