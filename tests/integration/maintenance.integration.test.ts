import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanDatabase } from './database-cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('maintenance integration', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  if (!testDatabaseUrl.includes('eventgate_test'))
    throw new Error('TEST_DATABASE_URL must contain eventgate_test.');
  process.env.DATABASE_URL = testDatabaseUrl;
  delete process.env.REDIS_URL;

  const [{ getPrisma }, { runMaintenance }, { EventStatus, JobType, OrderStatus, UserRole }] =
    await Promise.all([
      import('../../src/lib/prisma.js'),
      import('../../src/jobs/maintenance.service.js'),
      import('../../src/generated/prisma/client.js'),
    ]);
  const database = getPrisma();

  const fixture = async (
    eventStatus: (typeof EventStatus)[keyof typeof EventStatus] = EventStatus.PUBLISHED,
  ) => {
    const organizer = await database.user.create({
      data: {
        email: `org-${crypto.randomUUID()}@example.com`,
        displayName: 'Organizer',
        role: UserRole.ORGANIZER,
      },
    });
    const attendee = await database.user.create({
      data: {
        email: `attendee-${crypto.randomUUID()}@example.com`,
        displayName: 'Attendee',
        role: UserRole.ATTENDEE,
      },
    });
    const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const event = await database.event.create({
      data: {
        organizerId: organizer.id,
        title: 'Maintenance Fixture',
        slug: `maintenance-${crypto.randomUUID()}`,
        description: 'A detailed maintenance fixture event used to verify durable background work.',
        category: 'Technology',
        venue: 'Innovation Hall',
        city: 'Dhaka',
        address: '42 Software Avenue',
        startAt,
        endAt: new Date(startAt.getTime() + 60 * 60 * 1000),
        status: eventStatus,
        ...(eventStatus === EventStatus.PUBLISHED ? { publishedAt: new Date() } : {}),
        ...(eventStatus === EventStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
      },
    });
    const tier = await database.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General',
        pricePaisa: 50000,
        capacity: 10,
        reservedQuantity: 2,
        salesStartAt: new Date(Date.now() - 60_000),
        salesEndAt: new Date(startAt.getTime() - 60_000),
      },
    });
    const order = await database.order.create({
      data: {
        attendeeId: attendee.id,
        eventId: event.id,
        ticketTierId: tier.id,
        eventNameSnapshot: event.title,
        ticketTierNameSnapshot: tier.name,
        unitPricePaisaSnapshot: tier.pricePaisa,
        quantity: 2,
        totalAmountPaisaSnapshot: 100000,
        reservationExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    return { event, tier, order };
  };

  describe('maintenance integration', () => {
    beforeAll(async () => database.$connect());
    beforeEach(async () => cleanDatabase(database));
    afterAll(async () => database.$disconnect());

    it('expires a reservation and releases inventory exactly once', async () => {
      const { tier, order } = await fixture();
      await runMaintenance('expiry-worker');
      await runMaintenance('expiry-worker-repeat');
      await expect(database.order.findUnique({ where: { id: order.id } })).resolves.toMatchObject({
        status: OrderStatus.EXPIRED,
        reservationReleasedAt: expect.any(Date),
      });
      await expect(
        database.ticketTier.findUnique({ where: { id: tier.id } }),
      ).resolves.toMatchObject({ reservedQuantity: 0 });
      await expect(
        database.job.findUnique({ where: { deduplicationKey: `expire-order:${order.id}` } }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    });

    it('processes cancellation work in a durable job', async () => {
      const { event, tier, order } = await fixture(EventStatus.CANCELLED);
      await database.job.create({
        data: {
          type: JobType.PROCESS_EVENT_CANCELLATION,
          deduplicationKey: `event-cancellation:${event.id}`,
          payload: { eventId: event.id },
          runAt: new Date(),
        },
      });
      await runMaintenance('cancellation-worker');
      await expect(database.order.findUnique({ where: { id: order.id } })).resolves.toMatchObject({
        status: OrderStatus.CANCELLED,
        reservationReleasedAt: expect.any(Date),
      });
      await expect(
        database.ticketTier.findUnique({ where: { id: tier.id } }),
      ).resolves.toMatchObject({ reservedQuantity: 0 });
    });

    it('claims work once when maintenance workers overlap', async () => {
      const { tier, order } = await fixture();
      await Promise.all([runMaintenance('worker-a', 1), runMaintenance('worker-b', 1)]);
      await expect(database.order.findUnique({ where: { id: order.id } })).resolves.toMatchObject({
        status: OrderStatus.EXPIRED,
      });
      await expect(
        database.ticketTier.findUnique({ where: { id: tier.id } }),
      ).resolves.toMatchObject({ reservedQuantity: 0 });
    });

    it('marks a completed published event through scheduled work', async () => {
      const organizer = await database.user.create({
        data: {
          email: `org-${crypto.randomUUID()}@example.com`,
          displayName: 'Organizer',
          role: UserRole.ORGANIZER,
        },
      });
      const event = await database.event.create({
        data: {
          organizerId: organizer.id,
          title: 'Completed Fixture',
          slug: `completed-${crypto.randomUUID()}`,
          description: 'A detailed event fixture used to verify completed-event maintenance work.',
          category: 'Technology',
          venue: 'Innovation Hall',
          city: 'Dhaka',
          address: '42 Software Avenue',
          startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          endAt: new Date(Date.now() - 60_000),
          status: EventStatus.PUBLISHED,
          publishedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        },
      });
      await runMaintenance('completion-worker');
      await expect(database.event.findUnique({ where: { id: event.id } })).resolves.toMatchObject({
        status: EventStatus.COMPLETED,
        completedAt: expect.any(Date),
      });
    });
  });
}
