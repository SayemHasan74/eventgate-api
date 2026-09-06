import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanDatabase } from './database-cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('orders integration', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  if (!testDatabaseUrl.includes('eventgate_test')) {
    throw new Error(
      'TEST_DATABASE_URL must point to a dedicated database whose URL contains "eventgate_test".',
    );
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-thirty-two-characters';
  delete process.env.REDIS_URL;

  const [{ app }, { getPrisma }, { signAccessToken }, { EventStatus, UserRole }] =
    await Promise.all([
      import('../../src/app.js'),
      import('../../src/lib/prisma.js'),
      import('../../src/modules/auth/token.service.js'),
      import('../../src/generated/prisma/client.js'),
    ]);
  const request = (await import('supertest')).default;
  const database = getPrisma();

  const createUser = async (role: (typeof UserRole)[keyof typeof UserRole], name: string) =>
    database.user.create({
      data: {
        email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`,
        displayName: name,
        role,
      },
    });

  const bearer = async (user: { id: string; role: string }) => ({
    Authorization: `Bearer ${await signAccessToken({ userId: user.id, role: user.role })}`,
  });

  const createSaleTier = async (capacity: number) => {
    const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const event = await database.event.create({
      data: {
        organizerId: organizer.id,
        title: 'Order Fixture Event',
        slug: `order-fixture-${crypto.randomUUID()}`,
        description: 'A detailed published fixture event used to test inventory reservations.',
        category: 'Technology',
        venue: 'Innovation Hall',
        city: 'Dhaka',
        address: '42 Software Avenue',
        startAt,
        endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
        status: EventStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
    return database.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General Admission',
        pricePaisa: 50000,
        capacity,
        salesStartAt: new Date(Date.now() - 60_000),
        salesEndAt: new Date(startAt.getTime() - 60_000),
      },
    });
  };

  describe('orders integration', () => {
    beforeAll(async () => database.$connect());
    beforeEach(async () => {
      await cleanDatabase(database);
    });
    afterAll(async () => database.$disconnect());

    it('reserves stock with server-calculated snapshots and replays an idempotent request', async () => {
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      const tier = await createSaleTier(10);
      const headers = { ...(await bearer(attendee)), 'Idempotency-Key': 'order-request-1' };

      await request(app)
        .post('/api/v1/orders')
        .set(await bearer(attendee))
        .send({ ticketTierId: tier.id, quantity: 2 })
        .expect(400);
      const first = await request(app)
        .post('/api/v1/orders')
        .set(headers)
        .send({ ticketTierId: tier.id, quantity: 2 })
        .expect(201);
      const replay = await request(app)
        .post('/api/v1/orders')
        .set(headers)
        .send({ ticketTierId: tier.id, quantity: 2 })
        .expect(201);

      expect(first.body.data).toMatchObject({
        id: replay.body.data.id,
        unitPricePaisaSnapshot: 50000,
        totalAmountPaisaSnapshot: 100000,
        quantity: 2,
        currency: 'BDT',
      });
      await expect(
        database.ticketTier.findUnique({ where: { id: tier.id } }),
      ).resolves.toMatchObject({ reservedQuantity: 2 });
      await request(app)
        .post('/api/v1/orders')
        .set(headers)
        .send({ ticketTierId: tier.id, quantity: 1 })
        .expect(409);
    });

    it('restricts order access and releases a reservation exactly once on cancellation', async () => {
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      const intruder = await createUser(UserRole.ATTENDEE, 'Intruder');
      const tier = await createSaleTier(5);
      const created = await request(app)
        .post('/api/v1/orders')
        .set({ ...(await bearer(attendee)), 'Idempotency-Key': 'order-request-2' })
        .send({ ticketTierId: tier.id, quantity: 2 })
        .expect(201);
      const orderId = created.body.data.id as string;

      await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set(await bearer(intruder))
        .expect(404);
      await request(app)
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set(await bearer(attendee))
        .expect(200);
      await request(app)
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set(await bearer(attendee))
        .expect(409);
      await expect(
        database.ticketTier.findUnique({ where: { id: tier.id } }),
      ).resolves.toMatchObject({ reservedQuantity: 0 });
      await expect(database.order.findUnique({ where: { id: orderId } })).resolves.toMatchObject({
        status: 'CANCELLED',
        reservationReleasedAt: expect.any(Date),
      });
    });

    it('does not oversell when two attendees request the final ticket concurrently', async () => {
      const firstAttendee = await createUser(UserRole.ATTENDEE, 'First Attendee');
      const secondAttendee = await createUser(UserRole.ATTENDEE, 'Second Attendee');
      const tier = await createSaleTier(1);

      const responses = await Promise.all([
        request(app)
          .post('/api/v1/orders')
          .set({ ...(await bearer(firstAttendee)), 'Idempotency-Key': 'last-ticket-first' })
          .send({ ticketTierId: tier.id, quantity: 1 }),
        request(app)
          .post('/api/v1/orders')
          .set({ ...(await bearer(secondAttendee)), 'Idempotency-Key': 'last-ticket-second' })
          .send({ ticketTierId: tier.id, quantity: 1 }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      await expect(
        database.ticketTier.findUnique({ where: { id: tier.id } }),
      ).resolves.toMatchObject({ reservedQuantity: 1, soldQuantity: 0 });
      await expect(database.order.count({ where: { ticketTierId: tier.id } })).resolves.toBe(1);
    });
  });
}
