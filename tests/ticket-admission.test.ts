import { describe, it, expect } from 'vitest';
import {
  effectiveAdmissionState,
  type AdmissionInput,
} from '../src/modules/tickets/ticket-admission.js';
import { attendeeRefundView } from '../src/modules/refunds/attendee-refund.js';
const ticket = (): AdmissionInput => ({
  status: 'ACTIVE',
  event: { status: 'PUBLISHED', endAt: new Date('2099-01-01') },
  order: {
    status: 'PAID',
    financialReviewRequired: false,
    fulfilledPaymentAttemptId: 'capture',
    fulfilledPaymentAttempt: {
      status: 'SUCCEEDED',
      providerTransactionId: 'verified',
      replayOfAttemptId: null,
    },
    refunds: [],
  },
});
describe('effective admission', () => {
  it('blocks requested, approved and uncertain original-capture refunds', () => {
    for (const status of ['REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'FAILED']) {
      const pass = ticket();
      pass.order.refunds = [{ paymentAttemptId: 'capture', status, needsInvestigation: false }];
      expect(effectiveAdmissionState(pass)).toBe('REFUND_PENDING');
    }
  });
  it('restores rejected requests but ignores refunds on unrelated duplicate captures', () => {
    const pass = ticket();
    pass.order.refunds = [
      { paymentAttemptId: 'capture', status: 'REJECTED', needsInvestigation: false },
    ];
    expect(effectiveAdmissionState(pass)).toBe('ACTIVE');
    pass.order.refunds = [
      { paymentAttemptId: 'other-capture', status: 'PROCESSING', needsInvestigation: false },
    ];
    expect(effectiveAdmissionState(pass)).toBe('ACTIVE');
  });
  it('distinguishes cancellation, used passes, refunds and payment review', () => {
    const pass = ticket();
    pass.event.status = 'CANCELLED';
    expect(effectiveAdmissionState(pass)).toBe('CANCELLED');
    pass.event.status = 'PUBLISHED';
    pass.status = 'CHECKED_IN';
    expect(effectiveAdmissionState(pass)).toBe('CHECKED_IN');
    pass.status = 'ACTIVE';
    pass.order.financialReviewRequired = true;
    expect(effectiveAdmissionState(pass)).toBe('PAYMENT_REVIEW');
    pass.order.status = 'REFUNDED';
    expect(effectiveAdmissionState(pass)).toBe('REFUNDED');
  });
});
describe('attendee refund projection', () => {
  it('keeps review reasons while removing provider diagnostics', () => {
    const refund = attendeeRefundView({
      status: 'FAILED',
      failureCode: 'provider-secret',
      failureMessage: 'provider secret',
      activities: [
        {
          id: '1',
          action: 'PROVIDER_CONFIRMED_FAILED',
          note: 'provider secret',
          createdAt: new Date(),
        },
        { id: '2', action: 'REFUND_REJECTED', note: 'Tickets were used', createdAt: new Date() },
      ],
    });
    expect(refund.failureCode).toBeNull();
    expect(JSON.stringify(refund)).not.toContain('provider secret');
    expect(refund.activities[1]?.note).toBe('Tickets were used');
  });
});
