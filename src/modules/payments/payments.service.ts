import { createHash, randomBytes } from 'node:crypto';

import { OrderStatus, PaymentStatus, Prisma, RefundReason } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { SslcommerzAdapter } from '../../integrations/sslcommerz/sslcommerz.adapter.js';

export { initiateCheckout } from './checkout.service.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { lockOrderGraph } from '../../lib/financial-locks.js';
import { ensureCaptureRefund } from '../refunds/capture-refund.js';

export type SslcommerzCallback = Record<string, unknown>;
type CallbackType = 'IPN' | 'SUCCESS' | 'FAIL' | 'CANCEL';

const callbackString = (payload: SslcommerzCallback, key: string): string | undefined =>
  typeof payload[key] === 'string' && payload[key].trim() ? payload[key].trim() : undefined;

const callbackKey = (type: CallbackType, payload: SslcommerzCallback): string => {
  const validationId = callbackString(payload, 'val_id');
  if (validationId) return `${type}:${validationId}`;
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `${type}:unverified:${digest}`;
};

const ticketToken = (): string => randomBytes(32).toString('base64url');

const validStatus = (status: string): boolean =>
  ['VALID', 'VALIDATED'].includes(status.toUpperCase());

/**
 * This function only receives a response from SSLCommerz's validation API.  It never
 * makes decisions based on a browser redirect or an IPN request body.
 */
export const fulfillValidatedPayment = async (
  attemptId: string,
  validation: {
    validationId: string;
    merchantTransactionId: string;
    providerTransactionId: string;
    amountPaisa: number;
    currency: string;
    status: string;
  },
) => {
  if (!validStatus(validation.status)) throw new Error('SSLCommerz did not validate this payment.');
  let invalidateDiscovery = false;
  const result = await serializableTransaction(async (tx) => {
    const identity = await tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      select: { orderId: true },
    });
    if (!identity) throw new Error('Payment attempt no longer exists.');
    await lockOrderGraph(tx, identity.orderId);
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: { order: { include: { event: true } } },
    });
    if (!attempt) throw new Error('Payment attempt no longer exists.');
    if (
      attempt.merchantTransactionId !== validation.merchantTransactionId ||
      attempt.amountPaisa !== validation.amountPaisa ||
      attempt.currency !== validation.currency
    ) {
      throw new Error('Validated payment does not match its EventGate payment attempt.');
    }
    if (attempt.status === PaymentStatus.SUCCEEDED)
      return {
        outcome: 'already-fulfilled' as const,
        capturedAttemptId: attempt.replayOfAttemptId ?? attempt.id,
      };

    const existingProviderPayment = await tx.paymentAttempt.findUnique({
      where: { providerTransactionId: validation.providerTransactionId },
      select: { id: true, orderId: true },
    });
    if (existingProviderPayment && existingProviderPayment.id !== attempt.id) {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          replayOfAttemptId: existingProviderPayment.id,
          completedAt: new Date(),
          providerValidationId: null,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'PAYMENT_CAPTURE_REPLAY',
          entityType: 'PAYMENT_ATTEMPT',
          entityId: attempt.id,
          metadata: { capturedPaymentAttemptId: existingProviderPayment.id },
        },
      });
      return { outcome: 'capture-replay' as const, capturedAttemptId: existingProviderPayment.id };
    }

    const order = attempt.order;
    if (
      order.fulfilledPaymentAttemptId ||
      order.status === OrderStatus.PAID ||
      order.status === OrderStatus.REFUNDED
    ) {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          providerValidationId: validation.validationId,
          providerTransactionId: validation.providerTransactionId,
          completedAt: new Date(),
        },
      });
      await ensureCaptureRefund(
        tx,
        order.id,
        attempt.id,
        RefundReason.DUPLICATE_PAYMENT,
        attempt.amountPaisa,
      );
      return { outcome: 'duplicate-refund-created' as const };
    }

    const now = new Date();
    const eventOnSale = order.event.status === 'PUBLISHED' && order.event.startAt > now;
    const mustReacquire =
      order.status === OrderStatus.EXPIRED ||
      order.status === OrderStatus.CANCELLED ||
      order.reservationExpiresAt <= now;
    if (!eventOnSale || order.status === OrderStatus.CANCELLED) {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          providerValidationId: validation.validationId,
          providerTransactionId: validation.providerTransactionId,
          completedAt: now,
        },
      });
      await ensureCaptureRefund(
        tx,
        order.id,
        attempt.id,
        order.status === OrderStatus.CANCELLED
          ? RefundReason.EVENT_CANCELLATION
          : RefundReason.LATE_PAYMENT,
        attempt.amountPaisa,
      );
      return { outcome: 'late-refund-created' as const };
    }

    if (mustReacquire && order.reservationReleasedAt === null) {
      const release = await tx.$executeRaw(Prisma.sql`
        UPDATE "TicketTier" SET "reservedQuantity" = "reservedQuantity" - ${order.quantity}
        WHERE "id" = ${order.ticketTierId} AND "reservedQuantity" >= ${order.quantity}
      `);
      if (release !== 1) throw new Error('Could not release expired payment reservation.');
      const markedExpired = await tx.order.updateMany({
        where: {
          id: order.id,
          status: OrderStatus.PENDING_PAYMENT,
          reservationReleasedAt: null,
        },
        data: { status: OrderStatus.EXPIRED, reservationReleasedAt: now },
      });
      if (markedExpired.count !== 1)
        throw new Error('Expired order changed while payment was verified.');
      invalidateDiscovery = true;
    }
    const inventory = mustReacquire
      ? await tx.$executeRaw(Prisma.sql`
          UPDATE "TicketTier" AS tier SET "soldQuantity" = tier."soldQuantity" + ${order.quantity}
          FROM "Event" AS event
          WHERE tier."id" = ${order.ticketTierId}
            AND event."id" = tier."eventId" AND event."status" = 'PUBLISHED'
            AND event."startAt" > ${now} AND tier."deletedAt" IS NULL
            AND tier."salesStartAt" <= ${now} AND tier."salesEndAt" > ${now}
            AND tier."soldQuantity" + tier."reservedQuantity" + ${order.quantity} <= tier."capacity"
        `)
      : await tx.$executeRaw(Prisma.sql`
          UPDATE "TicketTier" SET "reservedQuantity" = "reservedQuantity" - ${order.quantity},
            "soldQuantity" = "soldQuantity" + ${order.quantity}
          WHERE "id" = ${order.ticketTierId} AND "reservedQuantity" >= ${order.quantity}
        `);
    if (inventory !== 1) {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          providerValidationId: validation.validationId,
          providerTransactionId: validation.providerTransactionId,
          completedAt: now,
        },
      });
      await ensureCaptureRefund(
        tx,
        order.id,
        attempt.id,
        RefundReason.LATE_PAYMENT,
        attempt.amountPaisa,
      );
      return { outcome: 'late-refund-created' as const };
    }

    const orderUpdated = await tx.order.updateMany({
      where: { id: order.id, status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.EXPIRED] } },
      data: {
        status: OrderStatus.PAID,
        paidAt: now,
        fulfilledPaymentAttemptId: attempt.id,
        reservationReleasedAt: order.reservationReleasedAt ?? (mustReacquire ? now : null),
      },
    });
    if (orderUpdated.count !== 1)
      throw new Error('Order changed while its payment was being fulfilled.');
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        providerValidationId: validation.validationId,
        providerTransactionId: validation.providerTransactionId,
        completedAt: now,
      },
    });
    await tx.ticket.createMany({
      data: Array.from({ length: order.quantity }, (_, index) => ({
        orderId: order.id,
        eventId: order.eventId,
        ticketTierId: order.ticketTierId,
        attendeeId: order.attendeeId,
        sequence: index + 1,
        qrToken: ticketToken(),
      })),
    });
    await tx.auditLog.create({
      data: {
        action: 'PAYMENT_VERIFIED_AND_ORDER_FULFILLED',
        entityType: 'ORDER',
        entityId: order.id,
        metadata: {
          paymentAttemptId: attempt.id,
          providerTransactionId: validation.providerTransactionId,
        },
      },
    });
    invalidateDiscovery = true;
    return { outcome: 'fulfilled' as const };
  });
  if (invalidateDiscovery)
    await import('../public-events/public-events.cache.js').then(
      ({ invalidatePublicDiscoveryCache }) => invalidatePublicDiscoveryCache(),
    );
  return result;
};

export const processSslcommerzCallback = async (
  type: CallbackType,
  payload: SslcommerzCallback,
  adapter = new SslcommerzAdapter(),
): Promise<{ accepted: true }> => {
  const event = await getPrisma().paymentEvent.upsert({
    where: { providerEventKey: callbackKey(type, payload) },
    update: {},
    create: {
      providerEventKey: callbackKey(type, payload),
      eventType: `SSLCOMMERZ_${type}`,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  if (event.processedAt) return { accepted: true };
  const merchantTransactionId = callbackString(payload, 'tran_id');
  const validationId = callbackString(payload, 'val_id');
  if (!merchantTransactionId || !validationId) {
    await getPrisma().paymentEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        processingError: 'Callback was recorded but lacks tran_id or val_id.',
      },
    });
    return { accepted: true };
  }
  const attempt = await getPrisma().paymentAttempt.findUnique({ where: { merchantTransactionId } });
  if (!attempt) {
    await getPrisma().paymentEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        processingError: 'No payment attempt matches callback transaction id.',
      },
    });
    return { accepted: true };
  }
  await getPrisma().paymentEvent.update({
    where: { id: event.id },
    data: { paymentAttemptId: attempt.id },
  });
  if (type === 'FAIL' || type === 'CANCEL') {
    await getPrisma().paymentEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        processingError:
          'Untrusted failure callback recorded; provider validation is required before changing payment state.',
      },
    });
    return { accepted: true };
  }
  try {
    const validation = await adapter.validateTransaction(validationId);
    const fulfillment = await fulfillValidatedPayment(attempt.id, validation);
    await getPrisma().paymentEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        processingError: null,
        capturedPaymentAttemptId:
          'capturedAttemptId' in fulfillment ? fulfillment.capturedAttemptId : attempt.id,
      },
    });
  } catch (error) {
    await getPrisma().paymentAttempt.updateMany({
      where: { id: attempt.id, status: { in: [PaymentStatus.INITIATING, PaymentStatus.PENDING] } },
      data: {
        status: PaymentStatus.UNKNOWN,
        failureCode: 'PAYMENT_VERIFICATION_PENDING',
        failureMessage:
          error instanceof Error ? error.message.slice(0, 2_000) : 'Verification failed.',
      },
    });
    await getPrisma().paymentEvent.update({
      where: { id: event.id },
      data: {
        processingError:
          error instanceof Error ? error.message.slice(0, 2_000) : 'Callback processing failed.',
      },
    });
  }
  return { accepted: true };
};

/** Used by the durable worker for a callback whose verification response was uncertain. */
export const reconcilePaymentAttempt = async (
  paymentAttemptId: string,
  adapter = new SslcommerzAdapter(),
): Promise<void> => {
  const attempt = await getPrisma().paymentAttempt.findUnique({ where: { id: paymentAttemptId } });
  if (!attempt || attempt.status !== PaymentStatus.UNKNOWN) return;
  const callback = await getPrisma().paymentEvent.findFirst({
    where: { paymentAttemptId, processedAt: null },
    orderBy: { receivedAt: 'desc' },
  });
  const validationId =
    attempt.providerValidationId ??
    (callback?.payload && typeof callback.payload === 'object' && !Array.isArray(callback.payload)
      ? callbackString(callback.payload as SslcommerzCallback, 'val_id')
      : undefined);
  if (!validationId)
    throw new Error('Cannot reconcile payment attempt without an SSLCommerz validation id.');
  const validation = await adapter.validateTransaction(validationId);
  await fulfillValidatedPayment(attempt.id, validation);
};
