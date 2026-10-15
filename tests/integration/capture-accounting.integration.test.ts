import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase } from './database-cleanup.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  describe.skip('capture accounting', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  if (!new URL(testUrl).pathname.includes('eventgate_test'))
    throw new Error('Use a dedicated eventgate_test database.');
  process.env.DATABASE_URL = testUrl;
  process.env.REDIS_URL = 'redis://127.0.0.1:6397';
  for (const [key, value] of Object.entries({
    SSLCOMMERZ_STORE_ID: 'fixture',
    SSLCOMMERZ_STORE_PASSWORD: 'fixture',
    SSLCOMMERZ_IS_LIVE: 'false',
    SSLCOMMERZ_SUCCESS_URL: 'https://example.test/success',
    SSLCOMMERZ_FAIL_URL: 'https://example.test/fail',
    SSLCOMMERZ_CANCEL_URL: 'https://example.test/cancel',
    SSLCOMMERZ_IPN_URL: 'https://example.test/ipn',
  }))
    process.env[key] = value;
  const [
    { getPrisma },
    {
      initiateCheckout,
      fulfillValidatedPayment,
      processSslcommerzCallback,
      reconcilePaymentAttempt,
    },
    { requestRefund, reviewRefund, startRefund, reconcileRefund, listRefunds },
    { ensureCaptureRefund },
    { serializableTransaction },
    { lockOrderGraph },
    { SslcommerzAdapter },
    { cancelEvent },
    { checkInTicket },
  ] = await Promise.all([
    import('../../src/lib/prisma.js'),
    import('../../src/modules/payments/payments.service.js'),
    import('../../src/modules/refunds/refunds.service.js'),
    import('../../src/modules/refunds/capture-refund.js'),
    import('../../src/lib/transaction.js'),
    import('../../src/lib/financial-locks.js'),
    import('../../src/integrations/sslcommerz/sslcommerz.adapter.js'),
    import('../../src/modules/events/events.service.js'),
    import('../../src/modules/tickets/tickets.service.js'),
  ]);
  const db = getPrisma();
  const notices = await import('../../src/modules/notifications/notifications.service.js');
  const hosted = {
    sessionKey: 'fixture-session',
    gatewayUrl: 'https://sandbox.sslcommerz.com/checkout',
  };
  const fixture = async () => {
    const organizer = await db.user.create({
      data: {
        email: `${crypto.randomUUID()}@example.test`,
        displayName: 'Organizer',
        role: 'ORGANIZER',
      },
    });
    const admin = await db.user.create({
      data: { email: `${crypto.randomUUID()}@example.test`, displayName: 'Admin', role: 'ADMIN' },
    });
    const attendee = await db.user.create({
      data: {
        email: `${crypto.randomUUID()}@example.test`,
        displayName: 'Guest',
        role: 'ATTENDEE',
        phone: '01700000000',
        address: 'Fixture address',
        city: 'Dhaka',
        postalCode: '1200',
        country: 'Bangladesh',
      },
    });
    const event = await db.event.create({
      data: {
        organizerId: organizer.id,
        title: 'Accounting fixture',
        slug: crypto.randomUUID(),
        description: 'Local disposable financial fixture',
        category: 'Test',
        venue: 'Test hall',
        city: 'Dhaka',
        address: 'Test address',
        startAt: new Date(Date.now() + 259200000),
        endAt: new Date(Date.now() + 262800000),
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    const tier = await db.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'Admission',
        pricePaisa: 10000,
        capacity: 10,
        reservedQuantity: 2,
        salesStartAt: new Date(Date.now() - 60000),
        salesEndAt: event.startAt,
      },
    });
    const order = await db.order.create({
      data: {
        attendeeId: attendee.id,
        eventId: event.id,
        ticketTierId: tier.id,
        eventNameSnapshot: event.title,
        ticketTierNameSnapshot: tier.name,
        unitPricePaisaSnapshot: 10000,
        totalAmountPaisaSnapshot: 20000,
        quantity: 2,
        reservationExpiresAt: new Date(Date.now() + 900000),
      },
    });
    return { organizer, admin, attendee, event, tier, order };
  };
  const capture = async (orderId: string, sequence = 1, bank = crypto.randomUUID()) => {
    const attempt = await db.paymentAttempt.create({
      data: {
        orderId,
        sequence,
        merchantTransactionId: crypto.randomUUID().replaceAll('-', '').slice(0, 30),
        amountPaisa: 20000,
        status: 'PENDING',
      },
    });
    const validation = {
      validationId: crypto.randomUUID(),
      merchantTransactionId: attempt.merchantTransactionId,
      providerTransactionId: bank,
      amountPaisa: 20000,
      currency: 'BDT',
      status: 'VALID',
    };
    await fulfillValidatedPayment(attempt.id, validation);
    return { attempt, validation };
  };
  describe('capture accounting', () => {
    beforeAll(async () => db.$connect());
    beforeEach(async () => {
      vi.restoreAllMocks();
      await cleanDatabase(db);
      // All external calls are intercepted; tests never contact a payment provider.
      vi.spyOn(SslcommerzAdapter.prototype, 'createSession').mockResolvedValue(hosted);
      vi.spyOn(SslcommerzAdapter.prototype, 'initiateRefund').mockResolvedValue({
        providerRefundId: 'fixture-ref',
        status: 'PROCESSING',
      });
      vi.spyOn(SslcommerzAdapter.prototype, 'getRefundStatus').mockResolvedValue('SUCCEEDED');
      vi.spyOn(SslcommerzAdapter.prototype, 'validateTransaction').mockRejectedValue(
        new Error('No fixture validation configured'),
      );
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      await db.$disconnect();
    });

    it('atomically fulfills a verified capture when notification work exceeds five seconds', async () => {
      const f = await fixture();
      const original = notices.writeNotification;
      vi.spyOn(notices, 'writeNotification').mockImplementationOnce(async (tx, ...args) => {
        await tx.$queryRaw`SELECT 1::integer AS delayed FROM pg_sleep(5.2)`;
        return original(tx, ...args);
      });
      const { attempt } = await capture(f.order.id);
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('PAID');
      expect(await db.ticket.count({ where: { orderId: f.order.id } })).toBe(2);
      expect(
        (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      ).toBe('SUCCEEDED');
      const notification = await db.notification.findFirstOrThrow({
        where: { userId: f.attendee.id, type: 'BOOKING_PAID' },
      });
      expect(
        await db.notificationDelivery.count({ where: { notificationId: notification.id } }),
      ).toBe(2);
    }, 15000);

    it('clears temporary verification errors after a genuine validated capture recovers', async () => {
      const f = await fixture();
      const attempt = await db.paymentAttempt.create({
        data: {
          orderId: f.order.id,
          sequence: 1,
          merchantTransactionId: crypto.randomUUID().replaceAll('-', '').slice(0, 30),
          amountPaisa: 20000,
          status: 'UNKNOWN',
          failureCode: 'PAYMENT_LOOKUP_UNRESOLVED',
          failureMessage: 'Temporary provider error',
        },
      });
      const validation = {
        validationId: crypto.randomUUID(),
        merchantTransactionId: attempt.merchantTransactionId,
        providerTransactionId: crypto.randomUUID(),
        amountPaisa: 20000,
        currency: 'BDT',
        status: 'VALID',
      };
      await fulfillValidatedPayment(attempt.id, validation);
      await fulfillValidatedPayment(attempt.id, validation);
      expect(
        await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ).toMatchObject({ status: 'SUCCEEDED', failureCode: null, failureMessage: null });
      expect(await db.ticket.count({ where: { orderId: f.order.id } })).toBe(2);
      expect(await db.refund.count({ where: { orderId: f.order.id } })).toBe(0);
    });

    it('simultaneous first checkouts share one attempt even with different keys', async () => {
      const f = await fixture();
      const outcomes = await Promise.all([
        initiateCheckout(f.attendee.id, f.order.id, 'concurrent-a'),
        initiateCheckout(f.attendee.id, f.order.id, 'concurrent-b'),
      ]);
      expect(outcomes[0]!.data.paymentAttemptId).toBe(outcomes[1]!.data.paymentAttemptId);
      expect(SslcommerzAdapter.prototype.createSession).toHaveBeenCalledTimes(1);
      expect(await db.paymentAttempt.count()).toBe(1);
    });

    it('a scan racing event cancellation never leaves a usable pass on a cancelled event', async () => {
      const f = await fixture();
      await capture(f.order.id);
      await db.event.update({
        where: { id: f.event.id },
        data: { startAt: new Date(Date.now() + 3600000), endAt: new Date(Date.now() + 7200000) },
      });
      const ticket = await db.ticket.findFirstOrThrow({ where: { orderId: f.order.id } });
      const actor = { id: f.organizer.id, role: 'ORGANIZER' as const };
      const outcomes = await Promise.allSettled([
        checkInTicket(actor, f.event.id, { qrToken: ticket.qrToken }),
        cancelEvent(actor, f.event.id),
      ]);
      expect(outcomes[1]!.status).toBe('fulfilled');
      expect(await db.event.findUnique({ where: { id: f.event.id } })).toMatchObject({
        status: 'CANCELLED',
      });
      expect(await db.ticket.count({ where: { orderId: f.order.id, status: 'VOIDED' } })).toBe(2);
      await expect(
        checkInTicket(actor, f.event.id, { qrToken: ticket.qrToken }),
      ).resolves.toMatchObject({ resultCode: 'WINDOW_CLOSED' });
    });

    it('unknown checkout creation cannot be restarted by changing the key', async () => {
      const f = await fixture();
      vi.mocked(SslcommerzAdapter.prototype.createSession).mockRejectedValue(
        new Error('Network outcome unknown'),
      );
      const unknown = await initiateCheckout(f.attendee.id, f.order.id, 'unknown-first');
      const retry = await initiateCheckout(f.attendee.id, f.order.id, 'unknown-second');
      expect(unknown).toMatchObject({ statusCode: 202, data: { paymentStatus: 'UNKNOWN' } });
      expect(retry.data.paymentAttemptId).toBe(unknown.data.paymentAttemptId);
      expect(SslcommerzAdapter.prototype.createSession).toHaveBeenCalledTimes(1);
    });

    it('rejects amount mismatch without changing the booking or issuing tickets', async () => {
      const f = await fixture();
      const result = await initiateCheckout(f.attendee.id, f.order.id, 'mismatch');
      await expect(
        fulfillValidatedPayment(result.data.paymentAttemptId, {
          validationId: 'bad-validation',
          merchantTransactionId: result.data.merchantTransactionId,
          providerTransactionId: 'bad-bank',
          amountPaisa: 10000,
          currency: 'BDT',
          status: 'VALID',
        }),
      ).rejects.toThrow('does not match');
      expect(await db.ticket.count()).toBe(0);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        status: 'PENDING_PAYMENT',
        fulfilledPaymentAttemptId: null,
      });
    });

    it('enforces one live whole-capture refund across different reasons at the database boundary', async () => {
      const f = await fixture();
      const paid = await capture(f.order.id);
      await requestRefund(f.attendee.id, f.order.id);
      await expect(
        db.refund.create({
          data: {
            orderId: f.order.id,
            paymentAttemptId: paid.attempt.id,
            reason: 'ADMIN_ACTION',
            idempotencyKey: 'illegal-second-refund',
            amountPaisa: 20000,
            status: 'APPROVED',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await db.refund.count()).toBe(1);
    });

    it('event cancellation reuses an existing attendee request instead of refunding the capture twice', async () => {
      const f = await fixture();
      const paid = await capture(f.order.id);
      const requested = await requestRefund(f.attendee.id, f.order.id, 'Existing request');
      await cancelEvent({ id: f.organizer.id, role: 'ORGANIZER' }, f.event.id);
      const automatic = await serializableTransaction(async (tx) => {
        await lockOrderGraph(tx, f.order.id);
        return ensureCaptureRefund(tx, f.order.id, paid.attempt.id, 'EVENT_CANCELLATION', 20000);
      });
      expect(automatic).toMatchObject({
        id: requested.id,
        status: 'APPROVED',
        userMessage: 'Existing request',
      });
      expect(await db.refund.count()).toBe(1);
      expect(await db.ticket.count({ where: { status: 'VOIDED' } })).toBe(2);
    });

    it('binds checkout before I/O; concurrent requests and completed replay make one provider call', async () => {
      const f = await fixture();
      let release!: (value: typeof hosted) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const provider = vi
        .mocked(SslcommerzAdapter.prototype.createSession)
        .mockImplementation(() => {
          entered();
          return new Promise((resolve) => {
            release = resolve;
          });
        });
      const first = initiateCheckout(f.attendee.id, f.order.id, 'same-key');
      await started;
      const pending = await initiateCheckout(f.attendee.id, f.order.id, 'same-key');
      const alias = await initiateCheckout(f.attendee.id, f.order.id, 'other-key');
      expect(pending).toMatchObject({ statusCode: 202, data: { status: 'PROCESSING' } });
      expect(alias.data.paymentAttemptId).toBe(pending.data.paymentAttemptId);
      release(hosted);
      const ready = await first;
      expect(ready).toMatchObject({
        statusCode: 200,
        data: { status: 'AVAILABLE', checkoutUrl: hosted.gatewayUrl },
      });
      expect(await initiateCheckout(f.attendee.id, f.order.id, 'same-key')).toEqual(ready);
      expect(provider).toHaveBeenCalledTimes(1);
      const other = await db.order.create({
        data: { ...f.order, id: undefined, quantity: 1, totalAmountPaisaSnapshot: 10000 },
      });
      await expect(initiateCheckout(f.attendee.id, other.id, 'same-key')).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    it('never regresses a fast successful callback to PENDING when session creation returns', async () => {
      const f = await fixture();
      vi.mocked(SslcommerzAdapter.prototype.createSession).mockImplementation(async (input) => {
        const attempt = await db.paymentAttempt.findUniqueOrThrow({
          where: { merchantTransactionId: input.merchantTransactionId },
        });
        await fulfillValidatedPayment(attempt.id, {
          validationId: 'fast-validation',
          merchantTransactionId: input.merchantTransactionId,
          providerTransactionId: 'fast-bank',
          amountPaisa: 20000,
          currency: 'BDT',
          status: 'VALID',
        });
        return hosted;
      });
      const result = await initiateCheckout(f.attendee.id, f.order.id, 'fast-key');
      expect(result).toMatchObject({ statusCode: 202, data: { paymentStatus: 'SUCCEEDED' } });
      expect(
        await db.paymentAttempt.findUnique({ where: { id: result.data.paymentAttemptId } }),
      ).toMatchObject({ status: 'SUCCEEDED' });
      expect(await db.ticket.count()).toBe(2);
    });

    it('repeated and simultaneous verified callbacks fulfill one booking once', async () => {
      const f = await fixture();
      const { attempt, validation } = await capture(f.order.id);
      await Promise.all([
        fulfillValidatedPayment(attempt.id, validation),
        fulfillValidatedPayment(attempt.id, validation),
      ]);
      expect(await db.ticket.count()).toBe(2);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        status: 'PAID',
        fulfilledPaymentAttemptId: attempt.id,
      });
      expect(await db.ticketTier.findUnique({ where: { id: f.tier.id } })).toMatchObject({
        soldQuantity: 2,
        reservedQuantity: 0,
      });
      expect(
        await db.auditLog.count({ where: { action: 'PAYMENT_VERIFIED_AND_ORDER_FULFILLED' } }),
      ).toBe(1);
    });

    it('a distinct excess capture refund preserves the canonical booking, passes and inventory', async () => {
      const f = await fixture();
      const first = await capture(f.order.id);
      const excess = await capture(f.order.id, 2);
      const refund = await db.refund.findFirstOrThrow({
        where: { paymentAttemptId: excess.attempt.id },
      });
      expect(refund.reason).toBe('DUPLICATE_PAYMENT');
      await Promise.all([startRefund(refund.id), startRefund(refund.id)]);
      expect(SslcommerzAdapter.prototype.initiateRefund).toHaveBeenCalledTimes(1);
      await Promise.all([reconcileRefund(refund.id), reconcileRefund(refund.id)]);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        status: 'PAID',
        fulfilledPaymentAttemptId: first.attempt.id,
      });
      expect(await db.ticket.count({ where: { status: 'ACTIVE' } })).toBe(2);
      expect(await db.ticketTier.findUnique({ where: { id: f.tier.id } })).toMatchObject({
        soldQuantity: 2,
      });
      expect(await db.refund.findUnique({ where: { id: refund.id } })).toMatchObject({
        status: 'SUCCEEDED',
      });
      await serializableTransaction(async (tx) => {
        await lockOrderGraph(tx, f.order.id);
        expect(
          (await ensureCaptureRefund(tx, f.order.id, excess.attempt.id, 'ADMIN_ACTION', 20000)).id,
        ).toBe(refund.id);
      });
      expect(await db.refund.count({ where: { paymentAttemptId: excess.attempt.id } })).toBe(1);
    });

    it('same provider capture on a second attempt is associated as replay, not refunded again', async () => {
      const f = await fixture();
      const first = await capture(f.order.id, 1, 'same-bank');
      const replay = await capture(f.order.id, 2, 'same-bank');
      expect(
        await db.paymentAttempt.findUnique({ where: { id: replay.attempt.id } }),
      ).toMatchObject({ replayOfAttemptId: first.attempt.id, providerTransactionId: null });
      expect(await db.refund.count()).toBe(0);
      expect(await db.ticket.count()).toBe(2);
    });

    it('canonical refund settles tickets and sold inventory exactly once', async () => {
      const f = await fixture();
      await capture(f.order.id);
      const refund = await requestRefund(f.attendee.id, f.order.id, 'Plans changed');
      await reviewRefund(f.admin.id, refund.id, {
        decision: 'approve',
        reviewerNote: 'Eligible unused passes',
      });
      await Promise.all([reconcileRefund(refund.id), reconcileRefund(refund.id)]);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        status: 'REFUNDED',
      });
      expect(await db.ticket.count({ where: { status: 'REFUNDED' } })).toBe(2);
      expect(await db.ticketTier.findUnique({ where: { id: f.tier.id } })).toMatchObject({
        soldQuantity: 0,
      });
      expect(
        await db.refundActivity.count({
          where: { refundId: refund.id, action: 'PROVIDER_CONFIRMED_REFUNDED' },
        }),
      ).toBe(1);
      await expect(requestRefund(f.attendee.id, f.order.id)).rejects.toMatchObject({
        code: 'ORDER_NOT_PAID',
      });
    });

    it('retains all rejection notes and audits, and caps eligible resubmissions at three', async () => {
      const f = await fixture();
      await capture(f.order.id);
      let refund = await requestRefund(f.attendee.id, f.order.id, 'First request');
      for (let count = 1; count <= 3; count++) {
        await reviewRefund(f.admin.id, refund.id, {
          decision: 'reject',
          reviewerNote: `Review ${count}`,
        });
        if (count < 3)
          refund = await requestRefund(f.attendee.id, f.order.id, `Request ${count + 1}`);
      }
      await expect(requestRefund(f.attendee.id, f.order.id)).rejects.toMatchObject({
        code: 'REFUND_REQUEST_LIMIT',
      });
      expect(await db.refundActivity.count({ where: { refundId: refund.id } })).toBe(6);
      expect(await db.auditLog.count({ where: { action: 'REFUND_REJECTED' } })).toBe(3);
      expect(
        (await listRefunds({ id: f.attendee.id, role: 'ATTENDEE' }, { page: 1, limit: 20 }))
          .refunds[0]?.activities,
      ).toHaveLength(6);
      expect(SslcommerzAdapter.prototype.initiateRefund).not.toHaveBeenCalled();
    });

    it('never reinitiates a network-unknown refund without a provider reference', async () => {
      const f = await fixture();
      await capture(f.order.id);
      const refund = await requestRefund(f.attendee.id, f.order.id);
      vi.mocked(SslcommerzAdapter.prototype.initiateRefund).mockRejectedValue(
        new Error('Connection lost after provider accepted'),
      );
      await reviewRefund(f.admin.id, refund.id, { decision: 'approve' });
      await db.refund.update({
        where: { id: refund.id },
        data: { processedAt: new Date(Date.now() - 60000) },
      });
      await startRefund(refund.id);
      await expect(reconcileRefund(refund.id)).rejects.toMatchObject({
        code: 'REFUND_REQUIRES_INVESTIGATION',
      });
      expect(SslcommerzAdapter.prototype.initiateRefund).toHaveBeenCalledTimes(1);
      expect(await db.refund.findUnique({ where: { id: refund.id } })).toMatchObject({
        status: 'UNKNOWN',
        needsInvestigation: true,
        providerRefundId: null,
      });
    });

    it('cancellation voids checked-in passes and refunds the fulfilled capture; attendee requests cannot', async () => {
      const f = await fixture();
      const paid = await capture(f.order.id);
      await db.ticket.updateMany({
        where: { orderId: f.order.id },
        data: { status: 'CHECKED_IN', checkedInAt: new Date(), checkedInById: f.organizer.id },
      });
      await expect(requestRefund(f.attendee.id, f.order.id)).rejects.toMatchObject({
        code: 'TICKETS_NOT_UNUSED',
      });
      await cancelEvent({ id: f.organizer.id, role: 'ORGANIZER' }, f.event.id);
      expect(await db.ticket.count({ where: { status: 'VOIDED' } })).toBe(2);
      const refund = await serializableTransaction(async (tx) => {
        await lockOrderGraph(tx, f.order.id);
        return ensureCaptureRefund(tx, f.order.id, paid.attempt.id, 'EVENT_CANCELLATION', 20000);
      });
      await startRefund(refund.id);
      await reconcileRefund(refund.id);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        status: 'REFUNDED',
      });
      expect(
        (await listRefunds({ id: f.attendee.id, role: 'ATTENDEE' }, { page: 1, limit: 20 })).total,
      ).toBe(1);
    });

    it('recovery validates persisted callback evidence without assigning an unverified unique validation ID', async () => {
      const f = await fixture();
      const checkout = await initiateCheckout(f.attendee.id, f.order.id, 'recover-key');
      await expect(
        processSslcommerzCallback('IPN', {
          tran_id: checkout.data.merchantTransactionId,
          val_id: 'recover-validation',
        }),
      ).rejects.toThrow('Persisted payment callback verification needs retry.');
      expect(
        await db.paymentAttempt.findUnique({ where: { id: checkout.data.paymentAttemptId } }),
      ).toMatchObject({ status: 'UNKNOWN', providerValidationId: null });
      vi.mocked(SslcommerzAdapter.prototype.validateTransaction).mockResolvedValue({
        validationId: 'recover-validation',
        merchantTransactionId: checkout.data.merchantTransactionId,
        providerTransactionId: 'recover-bank',
        amountPaisa: 20000,
        currency: 'BDT',
        status: 'VALID',
      });
      await reconcilePaymentAttempt(checkout.data.paymentAttemptId);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        status: 'PAID',
      });
    });

    it('historical backfill uses verified audit evidence and flags ambiguous purchases without guessing', async () => {
      const f = await fixture();
      const first = await capture(f.order.id);
      await capture(f.order.id, 2);
      await db.order.update({
        where: { id: f.order.id },
        data: { fulfilledPaymentAttemptId: null },
      });
      const migration = await readFile(
        new URL(
          '../../prisma/migrations/20261012000000_capture_accounting/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const backfill = migration.slice(
        migration.indexOf('WITH evidence AS'),
        migration.indexOf('UPDATE "Order" SET "financialReviewRequired"'),
      );
      await db.$executeRawUnsafe(backfill);
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        fulfilledPaymentAttemptId: first.attempt.id,
      });
      await db.order.update({
        where: { id: f.order.id },
        data: { fulfilledPaymentAttemptId: null },
      });
      await db.auditLog.create({
        data: {
          action: 'PAYMENT_VERIFIED_AND_ORDER_FULFILLED',
          entityType: 'ORDER',
          entityId: f.order.id,
          metadata: {},
        },
      });
      await db.$executeRawUnsafe(backfill);
      await db.$executeRawUnsafe(
        'UPDATE "Order" SET "financialReviewRequired" = true WHERE "status" IN (\'PAID\', \'REFUNDED\') AND "fulfilledPaymentAttemptId" IS NULL',
      );
      expect(await db.order.findUnique({ where: { id: f.order.id } })).toMatchObject({
        fulfilledPaymentAttemptId: null,
        financialReviewRequired: true,
        status: 'PAID',
      });
      expect(await db.ticket.count()).toBe(2);
    });
  });
}
