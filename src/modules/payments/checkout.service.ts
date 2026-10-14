import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PaymentAttempt } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { lockOrderGraph } from '../../lib/financial-locks.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  SslcommerzAdapter,
  SslcommerzProviderError,
  assertSslcommerzConfigured,
} from '../../integrations/sslcommerz/sslcommerz.adapter.js';
import type { SslcommerzEnvironment } from '../../integrations/sslcommerz/sslcommerz.adapter.js';
import { env } from '../../config/env.js';

const conflict = (code: string, message: string) =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message }] });
const scopeFor = (id: string) => `payment:checkout:${id}`;
const resultFor = (attempt: PaymentAttempt, payable: boolean) => {
  if (
    payable &&
    attempt.status === 'PENDING' &&
    attempt.checkoutUrl &&
    attempt.checkoutExpiresAt &&
    attempt.checkoutExpiresAt > new Date()
  )
    return {
      statusCode: 200,
      data: {
        status: 'AVAILABLE' as const,
        paymentAttemptId: attempt.id,
        merchantTransactionId: attempt.merchantTransactionId,
        checkoutUrl: attempt.checkoutUrl,
        checkoutExpiresAt: attempt.checkoutExpiresAt.toISOString(),
      },
    };
  return {
    statusCode: 202,
    data: {
      status: attempt.status === 'UNKNOWN' ? ('UNKNOWN' as const) : ('PROCESSING' as const),
      paymentAttemptId: attempt.id,
      merchantTransactionId: attempt.merchantTransactionId,
      paymentStatus: attempt.status,
      statusPath: `/api/v1/payments/attempts/${attempt.id}`,
    },
  };
};

export async function initiateCheckout(
  attendeeId: string,
  orderId: string,
  key: string,
  suppliedAdapter?: SslcommerzAdapter,
) {
  const scope = scopeFor(attendeeId);
  const hash = createHash('sha256').update(JSON.stringify({ orderId })).digest('hex');
  const preparation = async () =>
    serializableTransaction(async (tx) => {
      if (!(await lockOrderGraph(tx, orderId)))
        throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Order not found' });
      const order = await tx.order.findFirst({
        where: { id: orderId, attendeeId },
        include: { attendee: true, event: true, ticketTier: true },
      });
      if (!order)
        throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Order not found' });
      if (order.attendee.isDemo !== order.event.isDemo)
        throw new AppError({ statusCode: 403, code: 'DEMO_EVENT_SCOPE_MISMATCH', message: 'This account cannot pay for tickets in this event catalog.' });
      const paymentEnvironment: SslcommerzEnvironment = order.event.isDemo ? 'DEMO' : 'LIVE';
      const payable =
        order.status === 'PENDING_PAYMENT' &&
        !order.financialReviewRequired &&
        !order.reservationReleasedAt &&
        order.reservationExpiresAt > new Date() &&
        order.event.status === 'PUBLISHED' &&
        !order.event.deletedAt &&
        order.event.startAt > new Date() &&
        !order.ticketTier.deletedAt &&
        !order.ticketTier.salesPaused &&
        order.ticketTier.salesStartAt <= new Date() &&
        order.ticketTier.salesEndAt > new Date();
      const previous = await tx.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key } },
      });
      if (previous) {
        if (previous.requestHash !== hash)
          throw conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Use a new key for a different checkout request.',
          );
        if (!previous.resourceId)
          throw conflict(
            'PAYMENT_REQUIRES_INVESTIGATION',
            'The previous checkout needs investigation.',
          );
        const attempt = await tx.paymentAttempt.findUniqueOrThrow({
          where: { id: previous.resourceId },
        });
        return { kind: 'existing' as const, result: resultFor(attempt, payable) };
      }
      const active = await tx.paymentAttempt.findFirst({
        where: { orderId, status: { in: ['INITIATING', 'PENDING', 'UNKNOWN'] } },
      });
      if (active) {
        await tx.idempotencyRecord.create({
          data: {
            userId: attendeeId,
            scope,
            key,
            requestHash: hash,
            resourceId: active.id,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
        return { kind: 'existing' as const, result: resultFor(active, payable) };
      }
      const latest = await tx.paymentAttempt.findFirst({
        where: { orderId },
        orderBy: { sequence: 'desc' },
      });
      if (latest && !['FAILED', 'CANCELLED'].includes(latest.status))
        return { kind: 'existing' as const, result: resultFor(latest, false) };
      if (!payable)
        throw conflict(
          'ORDER_NOT_PAYABLE',
          'Only an active reservation with eligible ticket sales can start checkout.',
        );
      assertSslcommerzConfigured(paymentEnvironment);
      const customer = order.attendee;
      if (
        !customer.phone ||
        !customer.address ||
        !customer.city ||
        !customer.postalCode ||
        !customer.country
      )
        throw new AppError({
          statusCode: 400,
          code: 'CHECKOUT_PROFILE_INCOMPLETE',
          message: 'Add phone, address, city, postal code, and country before payment.',
        });
      const sequence =
        (await tx.paymentAttempt.aggregate({ where: { orderId }, _max: { sequence: true } }))._max
          .sequence ?? 0;
      const attempt = await tx.paymentAttempt.create({
        data: {
          orderId,
          sequence: sequence + 1,
          merchantTransactionId: `eg_${randomUUID().replaceAll('-', '').slice(0, 27)}`,
          amountPaisa: order.totalAmountPaisaSnapshot,
          paymentEnvironment,
          merchantIdentity: paymentEnvironment === 'DEMO' ? env.DEMO_SSLCOMMERZ_STORE_ID! : env.SSLCOMMERZ_STORE_ID!,
        },
      });
      await tx.idempotencyRecord.create({
        data: {
          userId: attendeeId,
          scope,
          key,
          requestHash: hash,
          resourceId: attempt.id,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: attendeeId,
          action: 'PAYMENT_CHECKOUT_INITIATED',
          entityType: 'PAYMENT_ATTEMPT',
          entityId: attempt.id,
          metadata: { orderId, sequence: attempt.sequence },
        },
      });
      return {
        kind: 'new' as const,
        attempt,
        paymentEnvironment,
        expiresAt: order.reservationExpiresAt,
        productName: `${order.event.title} — ${order.ticketTierNameSnapshot}`.slice(0, 255),
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
    });
  let prepared: Awaited<ReturnType<typeof preparation>>;
  try {
    prepared = await preparation();
  } catch (error) {
    // Resolve a concurrent unique insert by reading its committed binding, not
    // retrying a money operation or weakening the unique constraints.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error;
    const previous = await getPrisma().idempotencyRecord.findUnique({
      where: { scope_key: { scope, key } },
    });
    if (previous?.requestHash !== hash)
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'Use a new key for a different checkout request.');
    if (!previous.resourceId)
      throw conflict('PAYMENT_REQUIRES_INVESTIGATION', 'The checkout needs investigation.');
    const attempt = await getPrisma().paymentAttempt.findUniqueOrThrow({
      where: { id: previous.resourceId },
      include: { order: { include: { event: true, ticketTier: true } } },
    });
    return resultFor(
      attempt,
      attempt.order.status === 'PENDING_PAYMENT' &&
        !attempt.order.financialReviewRequired &&
        attempt.order.reservationExpiresAt > new Date() &&
        !attempt.order.reservationReleasedAt &&
        attempt.order.event.status === 'PUBLISHED' &&
        !attempt.order.event.deletedAt &&
        attempt.order.event.startAt > new Date() &&
        !attempt.order.ticketTier.deletedAt &&
        !attempt.order.ticketTier.salesPaused &&
        attempt.order.ticketTier.salesStartAt <= new Date() &&
        attempt.order.ticketTier.salesEndAt > new Date(),
    );
  }
  if (prepared.kind === 'existing') return prepared.result;
  const attempt = prepared.attempt;
  try {
    // Exactly one transaction winner reaches external I/O. Never put this in a retry loop.
    const adapter = suppliedAdapter ?? new SslcommerzAdapter(fetch, prepared.paymentEnvironment, attempt.merchantIdentity);
    const hosted = await adapter.createSession({
      merchantTransactionId: attempt.merchantTransactionId,
      amountPaisa: attempt.amountPaisa,
      productName: prepared.productName,
      customer: prepared.customer,
    });
    return await serializableTransaction(async (tx) => {
      await lockOrderGraph(tx, orderId);
      await tx.paymentAttempt.updateMany({
        where: { id: attempt.id, status: 'INITIATING' },
        data: {
          status: 'PENDING',
          providerSessionKey: hosted.sessionKey,
          checkoutUrl: hosted.gatewayUrl,
          checkoutExpiresAt: prepared.expiresAt,
        },
      });
      const current = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
        include: { order: { include: { event: true, ticketTier: true } } },
      });
      const result = resultFor(
        current,
        current.order.status === 'PENDING_PAYMENT' &&
          !current.order.financialReviewRequired &&
          !current.order.reservationReleasedAt &&
          current.order.reservationExpiresAt > new Date() &&
          current.order.event.status === 'PUBLISHED' &&
          !current.order.event.deletedAt &&
          current.order.event.startAt > new Date() &&
          !current.order.ticketTier.deletedAt &&
          !current.order.ticketTier.salesPaused &&
          current.order.ticketTier.salesStartAt <= new Date() &&
          current.order.ticketTier.salesEndAt > new Date(),
      );
      await tx.idempotencyRecord.updateMany({
        where: { scope, resourceId: attempt.id },
        data: { status: 'COMPLETED', responseStatus: result.statusCode, responseBody: result.data },
      });
      return result;
    });
  } catch (error) {
    await getPrisma().paymentAttempt.updateMany({
      where: { id: attempt.id, status: 'INITIATING' },
      data: {
        status:
          error instanceof SslcommerzProviderError && error.outcome === 'FAILED'
            ? 'FAILED'
            : 'UNKNOWN',
        failureCode: 'CHECKOUT_INITIALIZATION_FAILED',
        failureMessage: 'Checkout could not be confirmed. Check payment status before retrying.',
      },
    });
    // A fast verified callback may have completed while initiation failed.
    const current = await getPrisma().paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    return resultFor(current, false);
  }
}
