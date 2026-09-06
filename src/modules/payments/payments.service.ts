import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundReason,
  RefundStatus,
} from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  assertSslcommerzConfigured,
  SslcommerzAdapter,
  SslcommerzProviderError,
} from '../../integrations/sslcommerz/sslcommerz.adapter.js';

const conflict = (code: string, message: string, detail: string): AppError =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message: detail }] });

const notFound = (): AppError =>
  new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Order not found',
    errors: [{ code: 'NOT_FOUND', message: 'Order not found.' }],
  });

const isUniqueError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const merchantTransactionId = (orderId: string): string =>
  `eg_${orderId.replaceAll('-', '').slice(0, 24)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

const checkoutProfileError = (): AppError =>
  new AppError({
    statusCode: 400,
    code: 'CHECKOUT_PROFILE_INCOMPLETE',
    message: 'Checkout profile is incomplete',
    errors: [
      {
        code: 'CHECKOUT_PROFILE_INCOMPLETE',
        message: 'Add phone, address, city, postal code, and country to your profile.',
      },
    ],
  });

export const initiateCheckout = async (
  attendeeId: string,
  orderId: string,
  adapter = new SslcommerzAdapter(),
) => {
  assertSslcommerzConfigured();
  let pendingAttempt: {
    id: string;
    merchantTransactionId: string;
    amountPaisa: number;
    customer: SslcommerzCustomer;
  };
  try {
    pendingAttempt = await getPrisma().$transaction(
      async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, attendeeId },
          include: { attendee: true },
        });
        if (!order) throw notFound();
        if (
          order.status !== 'PENDING_PAYMENT' ||
          order.reservationReleasedAt ||
          order.reservationExpiresAt <= new Date()
        ) {
          throw conflict(
            'ORDER_NOT_PAYABLE',
            'Order cannot be paid',
            'Only an active, unexpired pending-payment order can start checkout.',
          );
        }
        const customer = order.attendee;
        if (
          !customer.phone ||
          !customer.address ||
          !customer.city ||
          !customer.postalCode ||
          !customer.country
        ) {
          throw checkoutProfileError();
        }
        const activeAttempt = await tx.paymentAttempt.findFirst({
          where: {
            orderId: order.id,
            status: {
              in: [PaymentStatus.INITIATING, PaymentStatus.PENDING, PaymentStatus.UNKNOWN],
            },
          },
          select: { id: true },
        });
        if (activeAttempt) {
          throw conflict(
            'ACTIVE_PAYMENT_ATTEMPT_EXISTS',
            'Payment is already in progress',
            'Complete or reconcile the existing payment attempt first.',
          );
        }
        const sequence =
          (
            await tx.paymentAttempt.aggregate({
              where: { orderId: order.id },
              _max: { sequence: true },
            })
          )._max.sequence ?? 0;
        const attempt = await tx.paymentAttempt.create({
          data: {
            orderId: order.id,
            sequence: sequence + 1,
            merchantTransactionId: merchantTransactionId(order.id),
            amountPaisa: order.totalAmountPaisaSnapshot,
            status: PaymentStatus.INITIATING,
          },
          select: { id: true, sequence: true, merchantTransactionId: true, amountPaisa: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: attendeeId,
            action: 'PAYMENT_CHECKOUT_INITIATED',
            entityType: 'PAYMENT_ATTEMPT',
            entityId: attempt.id,
            metadata: { orderId: order.id, sequence: attempt.sequence },
          },
        });
        return {
          ...attempt,
          customer: {
            name: customer.displayName,
            email: customer.email,
            phone: customer.phone,
            address: customer.address,
            city: customer.city,
            postalCode: customer.postalCode,
            country: customer.country,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isUniqueError(error))
      throw conflict(
        'ACTIVE_PAYMENT_ATTEMPT_EXISTS',
        'Payment is already in progress',
        'Complete or reconcile the existing payment attempt first.',
      );
    throw error;
  }

  try {
    const session = await adapter.createSession({
      merchantTransactionId: pendingAttempt.merchantTransactionId,
      amountPaisa: pendingAttempt.amountPaisa,
      customer: pendingAttempt.customer,
    });
    await getPrisma().paymentAttempt.update({
      where: { id: pendingAttempt.id },
      data: { status: PaymentStatus.PENDING, providerSessionKey: session.sessionKey },
    });
    return {
      paymentAttemptId: pendingAttempt.id,
      merchantTransactionId: pendingAttempt.merchantTransactionId,
      checkoutUrl: session.gatewayUrl,
    };
  } catch (error) {
    const status =
      error instanceof SslcommerzProviderError
        ? error.outcome === 'FAILED'
          ? PaymentStatus.FAILED
          : PaymentStatus.UNKNOWN
        : PaymentStatus.UNKNOWN;
    await getPrisma().paymentAttempt.update({
      where: { id: pendingAttempt.id },
      data: {
        status,
        failureCode:
          error instanceof SslcommerzProviderError
            ? 'SSLCOMMERZ_SESSION_ERROR'
            : 'SESSION_INITIALIZATION_ERROR',
        failureMessage:
          error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown session error.',
      },
    });
    throw error;
  }
};

type SslcommerzCustomer = {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
};

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

const createAutomaticRefund = async (
  tx: Prisma.TransactionClient,
  orderId: string,
  paymentAttemptId: string,
  reason: RefundReason,
  amountPaisa: number,
) =>
  tx.refund.upsert({
    where: { orderId_reason: { orderId, reason } },
    update: {},
    create: {
      orderId,
      paymentAttemptId,
      reason,
      idempotencyKey: `automatic:${reason}:${paymentAttemptId}`,
      amountPaisa,
      status: RefundStatus.APPROVED,
    },
  });

/**
 * This function only receives a response from SSLCommerz's validation API.  It never
 * makes decisions based on a browser redirect or an IPN request body.
 */
const fulfillValidatedPayment = async (
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
  const result = await getPrisma().$transaction(
    async (tx) => {
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
        return { outcome: 'already-fulfilled' as const };

      const existingProviderPayment = await tx.paymentAttempt.findUnique({
        where: { providerTransactionId: validation.providerTransactionId },
        select: { id: true, orderId: true },
      });
      if (existingProviderPayment && existingProviderPayment.id !== attempt.id) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PaymentStatus.SUCCEEDED,
            providerValidationId: validation.validationId,
            providerTransactionId: validation.providerTransactionId,
            completedAt: new Date(),
          },
        });
        await createAutomaticRefund(
          tx,
          attempt.orderId,
          attempt.id,
          RefundReason.DUPLICATE_PAYMENT,
          attempt.amountPaisa,
        );
        return { outcome: 'duplicate-refund-created' as const };
      }

      const order = attempt.order;
      if (order.status === OrderStatus.PAID) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PaymentStatus.SUCCEEDED,
            providerValidationId: validation.validationId,
            providerTransactionId: validation.providerTransactionId,
            completedAt: new Date(),
          },
        });
        await createAutomaticRefund(
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
        await createAutomaticRefund(
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
        await createAutomaticRefund(
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
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
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
    await fulfillValidatedPayment(attempt.id, validation);
    await getPrisma().paymentEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), processingError: null },
    });
  } catch (error) {
    await getPrisma().paymentAttempt.updateMany({
      where: { id: attempt.id, status: { in: [PaymentStatus.INITIATING, PaymentStatus.PENDING] } },
      data: {
        status: PaymentStatus.UNKNOWN,
        providerValidationId: validationId,
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
  if (!attempt.providerValidationId)
    throw new Error('Cannot reconcile payment attempt without an SSLCommerz validation id.');
  const validation = await adapter.validateTransaction(attempt.providerValidationId);
  await fulfillValidatedPayment(attempt.id, validation);
};
