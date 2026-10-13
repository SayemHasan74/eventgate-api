import type { Prisma, RefundReason } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeRefundNotice } from '../notifications/notifications.service.js';

export const liveRefundStates = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  'UNKNOWN',
  'SUCCEEDED',
] as const;
export const financialConflict = (code: string, message: string) =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message }] });

// Caller owns the order graph locks. This is database-only and may be retried.
export async function ensureCaptureRefund(
  tx: Prisma.TransactionClient,
  orderId: string,
  paymentAttemptId: string,
  reason: RefundReason,
  amountPaisa: number,
) {
  const attempt = await tx.paymentAttempt.findUniqueOrThrow({
    where: { id: paymentAttemptId },
    include: { order: true },
  });
  if (
    attempt.orderId !== orderId ||
    attempt.status !== 'SUCCEEDED' ||
    !attempt.providerTransactionId ||
    attempt.replayOfAttemptId ||
    amountPaisa !== attempt.amountPaisa ||
    attempt.currency !== 'BDT'
  )
    throw financialConflict(
      'CAPTURE_NOT_REFUNDABLE',
      'Refund must reference one verified whole capture.',
    );
  if (await tx.refund.count({ where: { paymentAttemptId, needsInvestigation: true } }))
    throw financialConflict(
      'REFUND_REQUIRES_INVESTIGATION',
      'Uncertain capture history requires investigation before another refund.',
    );
  let refund = await tx.refund.findFirst({
    where: { paymentAttemptId, status: { in: [...liveRefundStates] } },
  });
  if (!refund) {
    const previous = await tx.refund.findUnique({
      where: { paymentAttemptId_reason: { paymentAttemptId, reason } },
    });
    if (previous?.status === 'FAILED') return previous; // Only the explicit confirmed-failure retry path may initiate it.
    refund = await tx.refund.upsert({
      where: { paymentAttemptId_reason: { paymentAttemptId, reason } },
      update: { status: 'APPROVED' },
      create: {
        orderId,
        paymentAttemptId,
        reason,
        idempotencyKey: `capture:${reason}:${paymentAttemptId}`,
        amountPaisa,
        status: 'APPROVED',
      },
    });
    await tx.refundActivity.create({
      data: { refundId: refund.id, action: 'AUTOMATIC_REFUND_APPROVED', note: reason },
    });
    await writeRefundNotice(
      tx,
      refund.id,
      'APPROVED',
      `automatic-${refund.updatedAt.toISOString()}`,
    );
  } else if (reason === 'EVENT_CANCELLATION' && refund.status === 'REQUESTED') {
    refund = await tx.refund.update({ where: { id: refund.id }, data: { status: 'APPROVED' } });
    await tx.refundActivity.create({
      data: {
        refundId: refund.id,
        action: 'EVENT_CANCELLATION_APPROVED',
        note: 'Existing attendee request reused for event cancellation.',
      },
    });
    await writeRefundNotice(
      tx,
      refund.id,
      'APPROVED',
      `cancellation-${refund.updatedAt.toISOString()}`,
    );
  }
  if (
    reason === 'EVENT_CANCELLATION' &&
    attempt.order.fulfilledPaymentAttemptId === paymentAttemptId
  ) {
    await tx.ticket.updateMany({
      where: { orderId, status: { in: ['ACTIVE', 'CHECKED_IN'] } },
      data: { status: 'VOIDED' },
    });
  }
  return refund;
}
