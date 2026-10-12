type EventState = { status: string; startAt: Date; endAt: Date; deletedAt?: Date | null };
type TierState = {
  capacity: number;
  reservedQuantity: number;
  soldQuantity: number;
  salesStartAt: Date;
  salesEndAt: Date;
  deletedAt?: Date | null;
};

export const checkInWindow = (event: EventState, now = new Date()) => {
  const opensAt = new Date(event.startAt.getTime() - 7200000);
  return {
    opensAt,
    closesAt: event.endAt,
    isOpen:
      event.status === 'PUBLISHED' && !event.deletedAt && now >= opensAt && now <= event.endAt,
  };
};

export const eventCapabilities = (
  event: EventState,
  activeTiers: number,
  orderCount: number,
  now = new Date(),
) => {
  const draft = event.status === 'DRAFT' && !event.deletedAt;
  const upcoming = event.startAt > now;
  const setupChecks = {
    futureStart: upcoming,
    validDates: event.endAt > event.startAt,
    hasActiveTier: activeTiers > 0,
  };
  return {
    editable: !event.deletedAt && ['DRAFT', 'PUBLISHED'].includes(event.status),
    editableFields: draft
      ? [
          'title',
          'description',
          'category',
          'venue',
          'city',
          'address',
          'startAt',
          'endAt',
          'imageUrl',
        ]
      : event.status === 'PUBLISHED'
        ? ['title', 'description', 'imageUrl']
        : [],
    canPublish: draft && Object.values(setupChecks).every(Boolean),
    canCancel: !event.deletedAt && upcoming && ['DRAFT', 'PUBLISHED'].includes(event.status),
    canDelete: draft && orderCount === 0,
    canManageTiers: draft,
    setupChecks,
    checkInWindow: checkInWindow(event, now),
  };
};

export const tierCapabilities = (
  event: EventState,
  tier: TierState,
  hasOrderHistory: boolean,
  now = new Date(),
) => {
  const availableQuantity = Math.max(0, tier.capacity - tier.reservedQuantity - tier.soldQuantity);
  const saleState =
    event.status !== 'PUBLISHED' || event.deletedAt || tier.deletedAt
      ? 'UNAVAILABLE'
      : now >= event.startAt || now >= tier.salesEndAt
        ? 'CLOSED'
        : now < tier.salesStartAt
          ? 'UPCOMING'
          : availableQuantity === 0
            ? 'SOLD_OUT'
            : 'OPEN';
  const canEdit = event.status === 'DRAFT' && !event.deletedAt && !tier.deletedAt;
  return {
    availableQuantity,
    saleState,
    canEdit,
    canDelete: canEdit && !hasOrderHistory,
    editableFields: !canEdit
      ? []
      : hasOrderHistory
        ? ['capacity', 'salesEndAt']
        : ['name', 'pricePaisa', 'capacity', 'salesStartAt', 'salesEndAt'],
    minimumCapacity: hasOrderHistory ? tier.capacity : tier.reservedQuantity + tier.soldQuantity,
    restrictionCodes: [
      ...(!canEdit ? ['EVENT_NOT_DRAFT'] : []),
      ...(hasOrderHistory ? ['TIER_HISTORY_LOCKED', 'CAPACITY_REDUCTION_LOCKED'] : []),
    ],
  };
};

export type RefundEligibilityOrder = {
  status: string;
  financialReviewRequired: boolean;
  fulfilledPaymentAttemptId: string | null;
  event: { status: string; startAt: Date };
  tickets: { status: string }[];
  fulfilledPaymentAttempt?: {
    status: string;
    providerTransactionId: string | null;
    replayOfAttemptId: string | null;
  } | null;
  refunds?: {
    paymentAttemptId: string | null;
    status: string;
    needsInvestigation: boolean;
    reason: string;
    requestCount: number;
  }[];
};
export const refundEligibility = (order: RefundEligibilityOrder, now = new Date()) => {
  const reasons: string[] = [];
  if (order.financialReviewRequired || !order.fulfilledPaymentAttemptId)
    reasons.push('PAYMENT_REQUIRES_INVESTIGATION');
  if (order.status !== 'PAID') reasons.push('ORDER_NOT_PAID');
  if (order.event.status !== 'PUBLISHED') reasons.push('EVENT_NOT_PUBLISHED');
  if (order.event.startAt.getTime() - now.getTime() < 86400000)
    reasons.push('REFUND_WINDOW_CLOSED');
  if (!order.tickets.length || order.tickets.some((ticket) => ticket.status !== 'ACTIVE'))
    reasons.push('TICKETS_NOT_UNUSED');
  if (
    order.fulfilledPaymentAttempt !== undefined &&
    (!order.fulfilledPaymentAttempt ||
      order.fulfilledPaymentAttempt.status !== 'SUCCEEDED' ||
      !order.fulfilledPaymentAttempt.providerTransactionId ||
      order.fulfilledPaymentAttempt.replayOfAttemptId)
  )
    reasons.push('CAPTURE_NOT_REFUNDABLE');
  for (const refund of order.refunds ?? []) {
    if (refund.paymentAttemptId !== order.fulfilledPaymentAttemptId) continue;
    if (
      refund.needsInvestigation ||
      ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED'].includes(refund.status)
    )
      reasons.push('REFUND_ALREADY_EXISTS');
    else if (
      refund.reason === 'ATTENDEE_REQUEST' &&
      (refund.status !== 'REJECTED' || refund.requestCount >= 3)
    )
      reasons.push('REFUND_REQUEST_LIMIT');
  }
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    deadline: new Date(order.event.startAt.getTime() - 86400000),
  };
};
