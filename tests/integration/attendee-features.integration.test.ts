import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase } from './database-cleanup.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  describe.skip('attendee feature journeys', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  process.env.DATABASE_URL = testUrl;
  process.env.JWT_ACCESS_SECRET = 'attendee-audit-secret-at-least-thirty-two-characters';
  delete process.env.REDIS_URL;
  const [
    { app },
    { getPrisma },
    { signAccessToken },
    { fulfillValidatedPayment },
    alerts,
    reminders,
    notices,
  ] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/lib/prisma.js'),
    import('../../src/modules/auth/token.service.js'),
    import('../../src/modules/payments/payments.service.js'),
    import('../../src/modules/waitlists/availability.service.js'),
    import('../../src/modules/saved-events/reminders.service.js'),
    import('../../src/modules/notifications/notifications.service.js'),
  ]);
  const request = (await import('supertest')).default;
  const db = getPrisma();
  const user = (role: 'ATTENDEE' | 'ORGANIZER' = 'ATTENDEE') =>
    db.user.create({
      data: {
        email: `${crypto.randomUUID()}@example.test`,
        displayName: 'Audit ' + role,
        role,
        phone: '01700000000',
        address: 'Fictional audit address',
        city: 'Dhaka',
        postalCode: '1200',
        country: 'Bangladesh',
      },
    });
  const auth = async (actor: { id: string; role: string }) => ({
    Authorization: `Bearer ${await signAccessToken({ userId: actor.id, role: actor.role })}`,
  });
  async function event(city = 'Dhaka', category = 'Technology') {
    const organizer = await user('ORGANIZER');
    const startAt = new Date(Date.now() + 3 * 86400000);
    const event = await db.event.create({
      data: {
        organizerId: organizer.id,
        title: `${city} ${category}`,
        slug: `audit-${crypto.randomUUID()}`,
        description: 'Disposable attendee journey event, not production data.',
        category,
        venue: 'Audit Hall',
        city,
        address: 'Fictional address',
        startAt,
        endAt: new Date(+startAt + 3600000),
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    const tier = await db.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General',
        pricePaisa: 10000,
        capacity: 2,
        salesStartAt: new Date(Date.now() - 60000),
        salesEndAt: new Date(+startAt - 60000),
      },
    });
    return { event, tier, organizer };
  }
  async function reserve(actor: Awaited<ReturnType<typeof user>>, tierId: string) {
    const result = await request(app)
      .post('/api/v1/orders')
      .set(await auth(actor))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ ticketTierId: tierId, quantity: 1 })
      .expect(201);
    return result.body.data;
  }
  async function pay(order: { id: string; totalAmountPaisaSnapshot: number }) {
    const attempt = await db.paymentAttempt.create({
      data: {
        orderId: order.id,
        sequence: 1,
        merchantTransactionId: crypto.randomUUID().replaceAll('-', ''),
        amountPaisa: order.totalAmountPaisaSnapshot,
        status: 'PENDING',
      },
    });
    await fulfillValidatedPayment(attempt.id, {
      validationId: crypto.randomUUID(),
      merchantTransactionId: attempt.merchantTransactionId,
      providerTransactionId: crypto.randomUUID(),
      amountPaisa: attempt.amountPaisa,
      currency: 'BDT',
      status: 'VALID',
    });
  }
  describe('attendee feature journeys', () => {
    beforeEach(async () => {
      vi.useRealTimers();
      await cleanDatabase(db);
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('External network forbidden in attendee fixture'))),
      );
    });
    afterAll(async () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await db.$disconnect();
    });

    it('persists city preferences, changes real recommendations, and isolates another attendee', async () => {
      const attendee = await user(),
        other = await user(),
        sylhet = await event('Sylhet'),
        dhaka = await event('Dhaka');
      const headers = await auth(attendee);
      await request(app)
        .patch('/api/v1/users/me/event-preferences')
        .set(headers)
        .send({ preferredCity: 'Sylhet', preferredCategories: [], personalizationEnabled: true })
        .expect(200);
      const stored = await request(app)
        .get('/api/v1/users/me/event-preferences')
        .set(headers)
        .expect(200);
      expect(stored.body.data.preferredCity).toBe('Sylhet');
      const suggested = await request(app)
        .get('/api/v1/events/recommended')
        .set(headers)
        .expect(200);
      expect(suggested.body.data.personalized).toBe(true);
      expect(suggested.body.data.events.map((r: { event: { id: string } }) => r.event.id)).toEqual([
        sylhet.event.id,
      ]);
      expect(suggested.body.data.events[0].reason).toBe('In your preferred city');
      const untouched = await request(app)
        .get('/api/v1/events/recommended')
        .set(await auth(other))
        .expect(200);
      expect(untouched.body.data.events).toHaveLength(2);
      await request(app)
        .patch('/api/v1/users/me/event-preferences')
        .set(headers)
        .send({ preferredCity: 'Sylhet', preferredCategories: [], personalizationEnabled: false })
        .expect(200);
      const all = await request(app).get('/api/v1/events/recommended').set(headers).expect(200);
      expect(all.body.data.events.map((r: { event: { id: string } }) => r.event.id)).toContain(
        dhaka.event.id,
      );
    });

    it('explains fallback when a saved city has no eligible future events', async () => {
      const attendee = await user(),
        sylhet = await event('Sylhet');
      await event('Dhaka');
      const headers = await auth(attendee);
      await request(app)
        .patch('/api/v1/users/me/event-preferences')
        .set(headers)
        .send({ preferredCity: 'Sylhet', preferredCategories: [], personalizationEnabled: true })
        .expect(200);
      await db.event.update({ where: { id: sylhet.event.id }, data: { status: 'CANCELLED' } });
      const suggested = await request(app)
        .get('/api/v1/events/recommended')
        .set(headers)
        .expect(200);
      expect(suggested.body.data.personalized).toBe(false);
      expect(suggested.body.data.explanation).toMatch(/no upcoming events match/i);
    });

    it('saves without reserving stock, persists choices, creates a real reminder and removes it', async () => {
      const attendee = await user(),
        other = await user(),
        f = await event();
      const headers = await auth(attendee);
      const saved = await request(app)
        .put(`/api/v1/saved-events/${f.event.id}`)
        .set(headers)
        .send({ saleReminderEnabled: false, eventReminderEnabled: true })
        .expect(200);
      expect(
        (await db.ticketTier.findUniqueOrThrow({ where: { id: f.tier.id } })).reservedQuantity,
      ).toBe(0);
      expect(
        (
          await request(app)
            .get('/api/v1/saved-events')
            .set(await auth(other))
            .expect(200)
        ).body.data,
      ).toHaveLength(0);
      const job = await db.job.findFirstOrThrow({
        where: {
          type: 'SEND_EVENT_REMINDER',
          payload: { path: ['savedId'], equals: saved.body.data.saved.id },
        },
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(+job.runAt + 1000);
      const claimed = await db.job.update({
        where: { id: job.id },
        data: {
          status: 'RUNNING',
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      await reminders.sendEventReminder(claimed);
      vi.useRealTimers();
      const inbox = await request(app).get('/api/v1/notifications').set(headers).expect(200);
      expect(inbox.body.data.some((n: { type: string }) => n.type === 'SAVED_EVENT_REMINDER')).toBe(
        true,
      );
      await request(app)
        .delete(`/api/v1/saved-events/${f.event.id}`)
        .set(headers)
        .send({})
        .expect(200);
      expect(
        (await request(app).get('/api/v1/saved-events').set(headers).expect(200)).body.data,
      ).toHaveLength(0);
    });

    it('turns released sold-out stock into one in-app alert, not a reservation', async () => {
      const attendee = await user(),
        buyer = await user(),
        f = await event();
      await db.ticketTier.update({ where: { id: f.tier.id }, data: { capacity: 1 } });
      const order = await reserve(buyer, f.tier.id),
        headers = await auth(attendee),
        url = `/api/v1/events/${f.event.id}/ticket-tiers/${f.tier.id}/waitlist`;
      await request(app).put(url).set(headers).send({}).expect(200);
      await request(app)
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set(await auth(buyer))
        .send({})
        .expect(200);
      const job = await db.job.findFirstOrThrow({ where: { type: 'DISPATCH_WAITLIST_ALERTS' } });
      const claimed = await db.job.update({
        where: { id: job.id },
        data: {
          status: 'RUNNING',
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      await alerts.dispatchWaitlistWave(claimed);
      await alerts.dispatchWaitlistWave(claimed);
      const inbox = await request(app).get('/api/v1/notifications').set(headers).expect(200);
      const messages = inbox.body.data.filter(
        (n: { type: string }) => n.type === 'WAITLIST_STOCK_ALERT',
      );
      expect(messages).toHaveLength(1);
      const membership = await request(app).get(url).set(headers).expect(200);
      expect(membership.body.data.entry.status).toBe('NOTIFIED');
      expect(await db.order.count({ where: { attendeeId: attendee.id } })).toBe(0);
      await request(app)
        .patch(`/api/v1/notifications/${messages[0].id}/read`)
        .set(await auth(buyer))
        .send({})
        .expect(404);
      await request(app)
        .patch(`/api/v1/notifications/${messages[0].id}/read`)
        .set(headers)
        .send({})
        .expect(200);
      expect(
        (await request(app).get('/api/v1/notifications?read=unread').set(headers).expect(200)).body
          .data,
      ).toHaveLength(0);
    });

    it('keeps valid-booking reminders after an excess capture is refunded, but blocks failed canonical refunds', async () => {
      const attendee = await user(),
        f = await event();
      const order = await reserve(attendee, f.tier.id);
      await pay(order);
      const purchased = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      const extra = await db.paymentAttempt.create({
        data: {
          orderId: order.id,
          sequence: 2,
          merchantTransactionId: crypto.randomUUID(),
          amountPaisa: order.totalAmountPaisaSnapshot,
          status: 'SUCCEEDED',
          providerTransactionId: crypto.randomUUID(),
          completedAt: new Date(),
        },
      });
      await db.refund.create({
        data: {
          orderId: order.id,
          paymentAttemptId: extra.id,
          reason: 'DUPLICATE_PAYMENT',
          idempotencyKey: crypto.randomUUID(),
          amountPaisa: extra.amountPaisa,
          status: 'SUCCEEDED',
          completedAt: new Date(),
        },
      });
      const job = await db.job.findFirstOrThrow({
        where: {
          type: 'SEND_EVENT_REMINDER',
          payload: { path: ['orderId'], equals: order.id },
        },
        orderBy: { runAt: 'asc' },
      });
      const now = new Date(+job.runAt + 1000);
      expect(
        await db.$transaction((tx) => reminders.reminderStillRelevant(tx, job, attendee.id, now)),
      ).not.toBeNull();
      await db.refund.create({
        data: {
          orderId: order.id,
          paymentAttemptId: purchased.fulfilledPaymentAttemptId!,
          reason: 'ATTENDEE_REQUEST',
          idempotencyKey: crypto.randomUUID(),
          amountPaisa: extra.amountPaisa,
          status: 'FAILED',
        },
      });
      expect(
        await db.$transaction((tx) => reminders.reminderStillRelevant(tx, job, attendee.id, now)),
      ).toBeNull();
    });

    it('enforces notification choices instead of displaying disabled categories', async () => {
      const attendee = await user(),
        headers = await auth(attendee);
      await request(app)
        .patch('/api/v1/users/me/notification-preferences')
        .set(headers)
        .send({ bookingUpdates: false, inAppEnabled: true })
        .expect(200);
      await db.$transaction((tx) =>
        notices.writeNotification(tx, {
          userId: attendee.id,
          type: 'BOOKING_PAID',
          title: 'Fixture',
          body: 'Fixture',
          actionPath: '/account',
          sourceKey: 'muted-booking',
        }),
      );
      expect(
        (await request(app).get('/api/v1/notifications').set(headers).expect(200)).body.data,
      ).toHaveLength(0);
      await request(app)
        .patch('/api/v1/users/me/notification-preferences')
        .set(headers)
        .send({ bookingUpdates: true })
        .expect(200);
      await db.$transaction((tx) =>
        notices.writeNotification(tx, {
          userId: attendee.id,
          type: 'BOOKING_PAID',
          title: 'Fixture',
          body: 'Fixture',
          actionPath: '/account',
          sourceKey: 'enabled-booking',
        }),
      );
      expect(
        (await request(app).get('/api/v1/notifications').set(headers).expect(200)).body.data,
      ).toHaveLength(1);
    });

    it('issues owned passes after verified payment, blocks requested refunds, and restores rejected requests', async () => {
      const attendee = await user(),
        other = await user(),
        f = await event(),
        headers = await auth(attendee);
      const order = await reserve(attendee, f.tier.id);
      await pay(order);
      const tickets = await request(app)
        .get(`/api/v1/tickets/bookings?orderId=${order.id}`)
        .set(headers)
        .expect(200);
      const ticket = tickets.body.data[0].tickets[0];
      expect(ticket.effectiveAdmissionState).toBe('ACTIVE');
      await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(await auth(other))
        .expect(404);
      const refund = await request(app)
        .post(`/api/v1/orders/${order.id}/refund-requests`)
        .set(headers)
        .send({ userMessage: 'Cannot attend' })
        .expect(201);
      expect(
        (await request(app).get(`/api/v1/tickets/${ticket.id}`).set(headers).expect(200)).body.data
          .effectiveAdmissionState,
      ).toBe('REFUND_PENDING');
      await request(app).get(`/api/v1/tickets/${ticket.id}/qr`).set(headers).expect(409);
      await request(app)
        .get(`/api/v1/refund-requests/${refund.body.data.id}`)
        .set(await auth(other))
        .expect(404);
      const admin = await db.user.create({
        data: { email: `${crypto.randomUUID()}@example.test`, displayName: 'Admin', role: 'ADMIN' },
      });
      await request(app)
        .patch(`/api/v1/admin/refunds/${refund.body.data.id}`)
        .set(await auth(admin))
        .send({ decision: 'reject', reviewerNote: 'Fixture rejection' })
        .expect(200);
      expect(
        (await request(app).get(`/api/v1/tickets/${ticket.id}`).set(headers).expect(200)).body.data
          .effectiveAdmissionState,
      ).toBe('ACTIVE');
      expect(
        (await request(app).get(`/api/v1/orders/${order.id}`).set(headers).expect(200)).body.data
          .refundEligibility.eligible,
      ).toBe(true);
    });
  });
}
