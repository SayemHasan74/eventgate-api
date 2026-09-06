import { randomUUID } from 'node:crypto';

import { PaymentStatus, Prisma } from '../../generated/prisma/client.js';
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
