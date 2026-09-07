import {
  OrderStatus,
  Prisma,
  RefundReason,
  RefundStatus,
  TicketStatus,
  UserRole,
} from '../../generated/prisma/client.js';
import {
  SslcommerzAdapter,
  SslcommerzProviderError,
} from '../../integrations/sslcommerz/sslcommerz.adapter.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ReviewRefundInput } from './refunds.schemas.js';

const err = (statusCode: number, code: string, message: string, detail: string) =>
  new AppError({ statusCode, code, message, errors: [{ code, message: detail }] });

export const requestRefund = async (attendeeId: string, orderId: string) =>
  getPrisma().$transaction(
    async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, attendeeId },
        include: {
          event: true,
          tickets: true,
          paymentAttempts: {
            where: { status: 'SUCCEEDED' },
            orderBy: { completedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!order) throw err(404, 'NOT_FOUND', 'Order not found', 'Order not found.');
      if (
        order.status !== OrderStatus.PAID ||
        order.event.startAt.getTime() - Date.now() < 24 * 60 * 60 * 1000 ||
        order.tickets.some((ticket) => ticket.status === TicketStatus.CHECKED_IN)
      )
        throw err(
          409,
          'REFUND_NOT_ELIGIBLE',
          'Order is not eligible for refund',
          'Paid orders need unused tickets and at least 24 hours before the event.',
        );
      const attempt = order.paymentAttempts[0];
      if (!attempt)
        throw err(
          409,
          'REFUND_NOT_ELIGIBLE',
          'Order is not eligible for refund',
          'No verified payment exists.',
        );
      const existing = await tx.refund.findFirst({
        where: {
          orderId,
          status: {
            in: [
              RefundStatus.REQUESTED,
              RefundStatus.APPROVED,
              RefundStatus.PROCESSING,
              RefundStatus.SUCCEEDED,
              RefundStatus.UNKNOWN,
            ],
          },
        },
      });
      if (existing)
        throw err(
          409,
          'REFUND_ALREADY_EXISTS',
          'A refund is already active',
          'This order already has an active or completed refund.',
        );
      const refund = await tx.refund.upsert({
        where: { orderId_reason: { orderId, reason: RefundReason.ATTENDEE_REQUEST } },
        update: {
          status: RefundStatus.REQUESTED,
          requestedById: attendeeId,
          failureCode: null,
          failureMessage: null,
        },
        create: {
          orderId,
          paymentAttemptId: attempt.id,
          requestedById: attendeeId,
          reason: RefundReason.ATTENDEE_REQUEST,
          idempotencyKey: `attendee-refund:${orderId}`,
          amountPaisa: order.totalAmountPaisaSnapshot,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: attendeeId,
          action: 'REFUND_REQUESTED',
          entityType: 'REFUND',
          entityId: refund.id,
          metadata: { orderId },
        },
      });
      return refund;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

export const reviewRefund = async (adminId: string, refundId: string, input: ReviewRefundInput) => {
  const refund = await getPrisma().$transaction(
    async (tx) => {
      const found = await tx.refund.findUnique({
        where: { id: refundId },
        include: { order: true },
      });
      if (!found) throw err(404, 'NOT_FOUND', 'Refund not found', 'Refund not found.');
      if (found.status !== RefundStatus.REQUESTED)
        throw err(
          409,
          'REFUND_NOT_REVIEWABLE',
          'Refund cannot be reviewed',
          'Only requested refunds can be reviewed.',
        );
      if (input.decision === 'reject')
        return tx.refund.update({
          where: { id: found.id },
          data: { status: RefundStatus.REJECTED, reviewedById: adminId, reviewedAt: new Date() },
        });
      const checkedIn = await tx.ticket.count({
        where: { orderId: found.orderId, status: TicketStatus.CHECKED_IN },
      });
      if (checkedIn > 0)
        throw err(
          409,
          'REFUND_NOT_ELIGIBLE',
          'Order is not eligible for refund',
          'A ticket was checked in before approval.',
        );
      const approved = await tx.refund.update({
        where: { id: found.id },
        data: { status: RefundStatus.APPROVED, reviewedById: adminId, reviewedAt: new Date() },
      });
      // Blocking happens before the external call; check-in's ACTIVE transition cannot win afterwards.
      await tx.ticket.updateMany({
        where: { orderId: found.orderId, status: TicketStatus.ACTIVE },
        data: { status: TicketStatus.VOIDED },
      });
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'REFUND_APPROVED',
          entityType: 'REFUND',
          entityId: found.id,
          metadata: { orderId: found.orderId },
        },
      });
      return approved;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  if (input.decision === 'approve') await startRefund(refund.id);
  return getPrisma().refund.findUniqueOrThrow({ where: { id: refund.id } });
};

export const startRefund = async (
  refundId: string,
  adapter = new SslcommerzAdapter(),
): Promise<void> => {
  const refund = await getPrisma().$transaction(async (tx) => {
    const found = await tx.refund.findUnique({
      where: { id: refundId },
      include: { paymentAttempt: true },
    });
    if (
      !found ||
      !found.paymentAttempt?.providerTransactionId ||
      (found.status !== RefundStatus.APPROVED && found.status !== RefundStatus.FAILED)
    )
      return undefined;
    return tx.refund.update({
      where: { id: found.id },
      data: {
        status: RefundStatus.PROCESSING,
        processedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
      include: { paymentAttempt: true },
    });
  });
  if (!refund || !refund.paymentAttempt?.providerTransactionId) return;
  try {
    const result = await adapter.initiateRefund({
      bankTransactionId: refund.paymentAttempt.providerTransactionId,
      refundTransactionId: `rf_${refund.id.replaceAll('-', '').slice(0, 26)}`,
      amountPaisa: refund.amountPaisa,
      remarks: refund.reason,
    });
    await getPrisma().refund.update({
      where: { id: refund.id },
      data: {
        status: result.status === 'FAILED' ? RefundStatus.FAILED : RefundStatus.PROCESSING,
        providerRefundId: result.providerRefundId,
        failureCode: result.status === 'FAILED' ? 'PROVIDER_REFUND_REJECTED' : null,
      },
    });
  } catch (error) {
    await getPrisma().refund.update({
      where: { id: refund.id },
      data: {
        status:
          error instanceof SslcommerzProviderError && error.outcome === 'FAILED'
            ? RefundStatus.FAILED
            : RefundStatus.UNKNOWN,
        failureCode: 'PROVIDER_REFUND_UNKNOWN',
        failureMessage:
          error instanceof Error ? error.message.slice(0, 2000) : 'Unknown provider error.',
      },
    });
  }
};

export const reconcileRefund = async (
  refundId: string,
  adapter = new SslcommerzAdapter(),
): Promise<void> => {
  const refund = await getPrisma().refund.findUnique({
    where: { id: refundId },
    include: { order: true },
  });
  if (!refund) return;
  if (refund.status === RefundStatus.APPROVED) {
    await startRefund(refund.id, adapter);
    return;
  }
  if (
    !refund.providerRefundId ||
    (refund.status !== RefundStatus.PROCESSING && refund.status !== RefundStatus.UNKNOWN)
  )
    return;
  try {
    const status = await adapter.getRefundStatus(refund.providerRefundId);
    if (status === 'PROCESSING') return;
    if (status === 'FAILED') {
      await getPrisma().refund.update({
        where: { id: refund.id },
        data: { status: RefundStatus.FAILED },
      });
      return;
    }
    await getPrisma().$transaction(
      async (tx) => {
        const locked = await tx.refund.findUnique({
          where: { id: refund.id },
          include: { order: { include: { tickets: true } } },
        });
        if (!locked || locked.status === RefundStatus.SUCCEEDED) return;
        await tx.refund.update({
          where: { id: locked.id },
          data: { status: RefundStatus.SUCCEEDED, completedAt: new Date() },
        });
        if (locked.order.status === OrderStatus.PAID) {
          await tx.order.update({
            where: { id: locked.orderId },
            data: { status: OrderStatus.REFUNDED, refundedAt: new Date() },
          });
          await tx.ticket.updateMany({
            where: { orderId: locked.orderId },
            data: { status: TicketStatus.REFUNDED },
          });
          const changed = await tx.ticketTier.updateMany({
            where: { id: locked.order.ticketTierId, soldQuantity: { gte: locked.order.quantity } },
            data: { soldQuantity: { decrement: locked.order.quantity } },
          });
          if (changed.count !== 1) throw new Error('Refund inventory could not be released.');
        }
        await tx.auditLog.create({
          data: { action: 'REFUND_PROVIDER_CONFIRMED', entityType: 'REFUND', entityId: locked.id },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    await getPrisma().refund.update({
      where: { id: refund.id },
      data: {
        status: RefundStatus.UNKNOWN,
        failureCode: 'REFUND_RECONCILIATION_UNKNOWN',
        failureMessage:
          error instanceof Error ? error.message.slice(0, 2000) : 'Unknown provider error.',
      },
    });
  }
};

export const listRefunds = async (actor: { id: string; role: UserRole }) => {
  const where = actor.role === UserRole.ADMIN ? {} : { requestedById: actor.id };
  const database = getPrisma();
  const [refunds, total] = await database.$transaction([
    database.refund.findMany({ where, orderBy: { requestedAt: 'desc' }, take: 100 }),
    database.refund.count({ where }),
  ]);
  return { refunds, total };
};
