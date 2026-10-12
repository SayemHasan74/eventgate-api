import { type UserRole, type Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  SslcommerzAdapter,
  SslcommerzProviderError,
  assertSslcommerzConfigured,
} from '../../integrations/sslcommerz/sslcommerz.adapter.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { lockOrderGraph } from '../../lib/financial-locks.js';
import { invalidatePublicDiscoveryCache } from '../public-events/public-events.cache.js';
import { financialConflict, liveRefundStates } from './capture-refund.js';
import type { ReviewRefundInput } from './refunds.schemas.js';
import type { RefundListQuery } from './refunds.schemas.js';
import {
  refundEligibility,
  type RefundEligibilityOrder,
} from '../../shared/domain/capabilities.js';
import { refundSummarySelect } from '../../shared/responses/read-contracts.js';

async function lockedRefund(tx: Prisma.TransactionClient, refundId: string) {
  const identity = await tx.refund.findUnique({
    where: { id: refundId },
    select: { orderId: true },
  });
  if (!identity)
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Refund not found.' });
  await lockOrderGraph(tx, identity.orderId);
  return tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { order: { include: { event: true, tickets: true } }, paymentAttempt: true },
  });
}
function assertEligible(order: RefundEligibilityOrder) {
  const eligibility = refundEligibility(order);
  if (!eligibility.eligible)
    throw financialConflict(
      eligibility.reasons[0]!,
      'This booking is not eligible for an attendee refund.',
    );
}

export async function requestRefund(attendeeId: string, orderId: string, userMessage?: string) {
  return serializableTransaction(async (tx) => {
    await lockOrderGraph(tx, orderId);
    const order = await tx.order.findFirst({
      where: { id: orderId, attendeeId },
      include: { event: true, tickets: true, fulfilledPaymentAttempt: true, refunds: true },
    });
    if (!order)
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Order not found.' });
    assertEligible(order);
    const attempt = order.fulfilledPaymentAttempt!;
    if (
      attempt.status !== 'SUCCEEDED' ||
      !attempt.providerTransactionId ||
      attempt.replayOfAttemptId
    )
      throw financialConflict(
        'CAPTURE_NOT_REFUNDABLE',
        'The original verified payment is not refundable.',
      );
    if (
      await tx.refund.count({
        where: {
          paymentAttemptId: attempt.id,
          OR: [{ status: { in: [...liveRefundStates] } }, { needsInvestigation: true }],
        },
      })
    )
      throw financialConflict(
        'REFUND_ALREADY_EXISTS',
        'This capture already has an active, completed or uncertain refund.',
      );
    const previous = await tx.refund.findUnique({
      where: {
        paymentAttemptId_reason: { paymentAttemptId: attempt.id, reason: 'ATTENDEE_REQUEST' },
      },
    });
    if (previous && (previous.status !== 'REJECTED' || previous.requestCount >= 3))
      throw financialConflict(
        'REFUND_REQUEST_LIMIT',
        'This request cannot be resubmitted. Contact support.',
      );
    const refund = await tx.refund.upsert({
      where: {
        paymentAttemptId_reason: { paymentAttemptId: attempt.id, reason: 'ATTENDEE_REQUEST' },
      },
      update: {
        status: 'REQUESTED',
        requestCount: { increment: 1 },
        userMessage: userMessage ?? null,
        reviewerNote: null,
        requestedAt: new Date(),
        reviewedAt: null,
        reviewedById: null,
        failureCode: null,
        failureMessage: null,
      },
      create: {
        orderId,
        paymentAttemptId: attempt.id,
        requestedById: attendeeId,
        reason: 'ATTENDEE_REQUEST',
        idempotencyKey: `attendee-refund:${attempt.id}`,
        amountPaisa: attempt.amountPaisa,
        userMessage: userMessage ?? null,
      },
    });
    await tx.refundActivity.create({
      data: {
        refundId: refund.id,
        actorId: attendeeId,
        action: previous ? 'REQUEST_RESUBMITTED' : 'REQUESTED',
        note: userMessage ?? null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: attendeeId,
        action: 'REFUND_REQUESTED',
        entityType: 'REFUND',
        entityId: refund.id,
        metadata: { orderId, requestCount: refund.requestCount },
      },
    });
    return refund;
  });
}

export async function reviewRefund(adminId: string, refundId: string, input: ReviewRefundInput) {
  if (input.decision === 'reject' && !input.reviewerNote?.trim())
    throw financialConflict('REVIEW_NOTE_REQUIRED', 'Add a reason for rejecting this request.');
  const refund = await serializableTransaction(async (tx) => {
    const found = await lockedRefund(tx, refundId);
    if (found.status !== 'REQUESTED' || found.needsInvestigation)
      throw financialConflict(
        'REFUND_NOT_REVIEWABLE',
        'Only requested, confirmed-capture refunds can be reviewed.',
      );
    if (input.decision === 'approve') {
      assertEligible(found.order);
      if (found.paymentAttemptId !== found.order.fulfilledPaymentAttemptId)
        throw financialConflict(
          'CAPTURE_NOT_REFUNDABLE',
          'This request does not reference the fulfilled purchase.',
        );
      await tx.ticket.updateMany({
        where: { orderId: found.orderId, status: 'ACTIVE' },
        data: { status: 'VOIDED' },
      });
    }
    const reviewed = await tx.refund.update({
      where: { id: refundId },
      data: {
        status: input.decision === 'approve' ? 'APPROVED' : 'REJECTED',
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewerNote: input.reviewerNote ?? null,
      },
    });
    const action = input.decision === 'approve' ? 'REFUND_APPROVED' : 'REFUND_REJECTED';
    await tx.refundActivity.create({
      data: { refundId, actorId: adminId, action, note: input.reviewerNote ?? null },
    });
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action,
        entityType: 'REFUND',
        entityId: refundId,
        metadata: { orderId: found.orderId },
      },
    });
    return reviewed;
  });
  if (input.decision === 'approve') await startRefund(refund.id);
  return getPrisma().refund.findUniqueOrThrow({ where: { id: refund.id } });
}

export async function startRefund(
  refundId: string,
  adapter = new SslcommerzAdapter(),
): Promise<void> {
  assertSslcommerzConfigured();
  const claimed = await serializableTransaction(async (tx) => {
    const found = await lockedRefund(tx, refundId);
    if (!['APPROVED', 'FAILED'].includes(found.status)) return null;
    const attempt = found.paymentAttempt;
    if (
      found.needsInvestigation ||
      found.order.financialReviewRequired ||
      !attempt ||
      !attempt.providerTransactionId ||
      attempt.replayOfAttemptId ||
      attempt.status !== 'SUCCEEDED' ||
      found.amountPaisa !== attempt.amountPaisa ||
      found.currency !== attempt.currency
    )
      throw financialConflict(
        'REFUND_REQUIRES_INVESTIGATION',
        'Refund capture or financial history needs investigation.',
      );
    if (
      found.status === 'FAILED' &&
      !['PROVIDER_REFUND_REJECTED', 'PROVIDER_REFUND_CONFIRMED_FAILED'].includes(
        found.failureCode ?? '',
      )
    )
      throw financialConflict(
        'REFUND_REQUIRES_INVESTIGATION',
        'Only provider-confirmed failures may be retried.',
      );
    if (
      await tx.refund.count({
        where: {
          paymentAttemptId: attempt.id,
          id: { not: found.id },
          OR: [{ status: { in: [...liveRefundStates] } }, { needsInvestigation: true }],
        },
      })
    )
      throw financialConflict('REFUND_ALREADY_EXISTS', 'Another refund already owns this capture.');
    const processedAt = new Date();
    const claim = await tx.refund.updateMany({
      where: { id: refundId, status: found.status },
      data: { status: 'PROCESSING', processedAt, failureCode: null, failureMessage: null },
    });
    if (claim.count !== 1) return null;
    await tx.refundActivity.create({ data: { refundId, action: 'PROVIDER_INITIATION_CLAIMED' } });
    return { ...found, processedAt, bankTransactionId: attempt.providerTransactionId };
  });
  if (!claimed) return;
  try {
    const result = await adapter.initiateRefund({
      bankTransactionId: claimed.bankTransactionId,
      refundTransactionId: `rf_${claimed.id.replaceAll('-', '').slice(0, 26)}`,
      amountPaisa: claimed.amountPaisa,
      remarks: claimed.reason,
    });
    await serializableTransaction(async (tx) => {
      await lockedRefund(tx, refundId);
      const changed = await tx.refund.updateMany({
        where: {
          id: refundId,
          processedAt: claimed.processedAt,
          status: { in: ['PROCESSING', 'UNKNOWN'] },
        },
        data: {
          status: result.status === 'FAILED' ? 'FAILED' : 'PROCESSING',
          providerRefundId: result.providerRefundId,
          needsInvestigation: false,
          failureCode: result.status === 'FAILED' ? 'PROVIDER_REFUND_REJECTED' : null,
          failureMessage: null,
        },
      });
      if (changed.count)
        await tx.refundActivity.create({
          data: {
            refundId,
            action: result.status === 'FAILED' ? 'PROVIDER_REJECTED' : 'PROVIDER_PROCESSING',
          },
        });
    });
  } catch (error) {
    const definitive = error instanceof SslcommerzProviderError && error.outcome === 'FAILED';
    await getPrisma().refund.updateMany({
      where: {
        id: refundId,
        processedAt: claimed.processedAt,
        status: { in: ['PROCESSING', 'UNKNOWN'] },
      },
      data: {
        status: definitive ? 'FAILED' : 'UNKNOWN',
        needsInvestigation: !definitive,
        failureCode: definitive ? 'PROVIDER_REFUND_REJECTED' : 'REFUND_REFERENCE_UNCONFIRMED',
        failureMessage: definitive
          ? 'Provider rejected refund initiation.'
          : 'Refund initiation is uncertain. Do not retry without a confirmed provider reference.',
      },
    });
  }
}

export async function reconcileRefund(
  refundId: string,
  adapter = new SslcommerzAdapter(),
): Promise<void> {
  const refund = await getPrisma().refund.findUnique({ where: { id: refundId } });
  if (!refund) return;
  if (refund.status === 'APPROVED') return startRefund(refund.id, adapter);
  if (!['PROCESSING', 'UNKNOWN'].includes(refund.status)) return;
  if (refund.needsInvestigation && refund.providerRefundId)
    throw financialConflict(
      'REFUND_REQUIRES_INVESTIGATION',
      'Historical capture identity needs manual investigation.',
    );
  if (!refund.providerRefundId) {
    if (refund.processedAt && Date.now() - refund.processedAt.getTime() < 30000) return;
    // Official status queries require refund_ref_id; merchant transaction
    // lookup does not prove a particular refund. Never re-initiate to discover it.
    await getPrisma().refund.updateMany({
      where: { id: refundId, status: { in: ['PROCESSING', 'UNKNOWN'] }, providerRefundId: null },
      data: {
        status: 'UNKNOWN',
        needsInvestigation: true,
        failureCode: 'REFUND_REFERENCE_UNCONFIRMED',
        failureMessage:
          'Provider reference is missing. Investigate in the merchant portal; automatic re-initiation is blocked.',
      },
    });
    throw financialConflict(
      'REFUND_REQUIRES_INVESTIGATION',
      'Provider reference is required to reconcile this refund.',
    );
  }
  try {
    const captureIdentity = refund.paymentAttemptId
      ? await getPrisma().paymentAttempt.findUnique({
          where: { id: refund.paymentAttemptId },
          select: { providerTransactionId: true },
        })
      : null;
    if (!captureIdentity?.providerTransactionId)
      throw financialConflict(
        'REFUND_REQUIRES_INVESTIGATION',
        'Verified capture identity is missing.',
      );
    const status = await adapter.getRefundStatus(
      refund.providerRefundId,
      captureIdentity.providerTransactionId,
    );
    if (status === 'PROCESSING') return;
    const inventoryChanged = await serializableTransaction(async (tx) => {
      const found = await lockedRefund(tx, refundId);
      if (
        !['PROCESSING', 'UNKNOWN'].includes(found.status) ||
        found.providerRefundId !== refund.providerRefundId
      )
        return false;
      if (status === 'FAILED') {
        await tx.refund.update({
          where: { id: refundId },
          data: {
            status: 'FAILED',
            needsInvestigation: false,
            failureCode: 'PROVIDER_REFUND_CONFIRMED_FAILED',
          },
        });
        await tx.refundActivity.create({ data: { refundId, action: 'PROVIDER_CONFIRMED_FAILED' } });
        return false;
      }
      const capture = found.paymentAttempt;
      if (
        !capture ||
        capture.status !== 'SUCCEEDED' ||
        capture.orderId !== found.orderId ||
        !capture.providerTransactionId ||
        capture.replayOfAttemptId ||
        found.amountPaisa !== capture.amountPaisa ||
        found.currency !== capture.currency ||
        (await tx.refund.count({
          where: { paymentAttemptId: capture.id, id: { not: refundId }, status: 'SUCCEEDED' },
        }))
      )
        throw financialConflict(
          'REFUND_REQUIRES_INVESTIGATION',
          'Refund settlement conflicts with the captured amount.',
        );
      let released = false;
      if (
        found.order.fulfilledPaymentAttemptId === found.paymentAttemptId &&
        found.order.status === 'PAID'
      ) {
        if (found.order.financialReviewRequired)
          throw financialConflict(
            'REFUND_REQUIRES_INVESTIGATION',
            'Historical booking accounting needs investigation.',
          );
        await tx.order.update({
          where: { id: found.orderId },
          data: { status: 'REFUNDED', refundedAt: new Date() },
        });
        await tx.ticket.updateMany({
          where: { orderId: found.orderId },
          data: { status: 'REFUNDED' },
        });
        const changed = await tx.ticketTier.updateMany({
          where: { id: found.order.ticketTierId, soldQuantity: { gte: found.order.quantity } },
          data: { soldQuantity: { decrement: found.order.quantity } },
        });
        if (changed.count !== 1) throw new Error('Refund inventory could not be released.');
        released = true;
      }
      await tx.refund.update({
        where: { id: refundId },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          needsInvestigation: false,
          failureCode: null,
          failureMessage: null,
        },
      });
      await tx.refundActivity.create({ data: { refundId, action: 'PROVIDER_CONFIRMED_REFUNDED' } });
      await tx.auditLog.create({
        data: {
          action: 'REFUND_PROVIDER_CONFIRMED',
          entityType: 'REFUND',
          entityId: refundId,
          metadata: { captureId: capture.id, bookingInventoryReleased: released },
        },
      });
      return released;
    });
    if (inventoryChanged) await invalidatePublicDiscoveryCache();
  } catch (error) {
    await getPrisma().refund.updateMany({
      where: { id: refundId, status: { in: ['PROCESSING', 'UNKNOWN'] } },
      data: {
        status: 'UNKNOWN',
        failureCode: 'REFUND_RECONCILIATION_UNKNOWN',
        failureMessage:
          'Refund could not be confirmed. Reconcile with the provider before retrying.',
      },
    });
    throw error;
  }
}

export async function listRefunds(actor: { id: string; role: UserRole }, query: RefundListQuery) {
  const where: Prisma.RefundWhereInput = {
    ...(actor.role === 'ADMIN' ? {} : { order: { attendeeId: actor.id } }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          order: {
            ...(actor.role === 'ADMIN' ? {} : { attendeeId: actor.id }),
            eventNameSnapshot: { contains: query.search, mode: 'insensitive' },
          },
        }
      : {}),
  };
  const database = getPrisma();
  const [refunds, total] = await database.$transaction([
    database.refund.findMany({
      where,
      select: refundSummarySelect,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.refund.count({ where }),
  ]);
  return { refunds, total };
}

export async function getRefund(actor: { id: string; role: UserRole }, refundId: string) {
  const refund = await getPrisma().refund.findFirst({
    where: { id: refundId, ...(actor.role === 'ADMIN' ? {} : { order: { attendeeId: actor.id } }) },
    select: {
      ...refundSummarySelect,
      order: { select: { id: true, eventNameSnapshot: true, status: true } },
    },
  });
  if (!refund)
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Refund not found.' });
  return { ...refund, serverTime: new Date() };
}
