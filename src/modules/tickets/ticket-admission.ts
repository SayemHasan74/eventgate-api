export type AdmissionInput = {
  status: string;
  event: { status: string; endAt: Date; deletedAt?: Date | null };
  order: {
    status: string;
    financialReviewRequired: boolean;
    fulfilledPaymentAttemptId: string | null;
    fulfilledPaymentAttempt: {
      status: string;
      providerTransactionId: string | null;
      replayOfAttemptId: string | null;
    } | null;
    refunds: { paymentAttemptId: string | null; status: string; needsInvestigation: boolean }[];
  };
};
export function effectiveAdmissionState(ticket: AdmissionInput, now = new Date()) {
  if (ticket.status === 'REFUNDED' || ticket.order.status === 'REFUNDED') return 'REFUNDED';
  if (ticket.event.status === 'CANCELLED') return 'CANCELLED';
  if (ticket.event.deletedAt) return 'VOIDED';
  if (ticket.order.financialReviewRequired) return 'PAYMENT_REVIEW';
  const refunds = ticket.order.refunds.filter(
    (refund) => refund.paymentAttemptId === ticket.order.fulfilledPaymentAttemptId,
  );
  if (refunds.some((refund) => refund.status === 'SUCCEEDED')) return 'REFUNDED';
  if (
    refunds.some(
      (refund) =>
        refund.needsInvestigation ||
        ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'FAILED'].includes(refund.status),
    )
  )
    return 'REFUND_PENDING';
  if (ticket.status !== 'ACTIVE') return ticket.status;
  const capture = ticket.order.fulfilledPaymentAttempt;
  if (
    ticket.order.status !== 'PAID' ||
    !capture ||
    capture.status !== 'SUCCEEDED' ||
    !capture.providerTransactionId ||
    capture.replayOfAttemptId
  )
    return 'VOIDED';
  if (ticket.event.endAt < now || ticket.event.status === 'COMPLETED') return 'EVENT_ENDED';
  if (ticket.event.status !== 'PUBLISHED') return 'VOIDED';
  return 'ACTIVE';
}
