type RefundView = {
  failureCode?: string | null;
  failureMessage?: string | null;
  status: string;
  activities?: { id: string; action: string; note: string | null; createdAt: Date }[];
};
export function attendeeRefundView<T extends RefundView>(refund: T) {
  return {
    ...refund,
    failureCode: null,
    failureMessage:
      refund.status === 'FAILED'
        ? 'Refund processing could not complete. The platform administrator must review the next step.'
        : refund.status === 'UNKNOWN'
          ? 'The provider outcome is not confirmed. It requires reconciliation before another refund attempt.'
          : null,
    activities: (refund.activities ?? []).map((activity) => ({
      ...activity,
      note: ['REQUESTED', 'REQUEST_RESUBMITTED', 'REFUND_APPROVED', 'REFUND_REJECTED'].includes(
        activity.action,
      )
        ? activity.note
        : null,
    })),
  };
}
