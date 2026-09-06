import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('ticket-tier integration', () => {
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

  const [{ app }, { getPrisma }, { signAccessToken }, { UserRole }] = await Promise.all([
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

  const createDraftEvent = async (organizerId: string) => {
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return database.event.create({
      data: {
        organizerId,
        title: 'Ticket Tier Fixture Event',
        slug: `tier-fixture-${crypto.randomUUID()}`,
        description: 'A detailed event description used for ticket-tier integration testing.',
        category: 'Technology',
        venue: 'Innovation Hall',
        city: 'Dhaka',
        address: '42 Software Avenue, Dhaka',
        startAt,
        endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
      },
    });
  };

  const tierInput = (eventStartAt: Date) => ({
    name: 'General Admission',
    pricePaisa: 50000,
    capacity: 20,
    salesStartAt: new Date(Date.now() + 60_000).toISOString(),
    salesEndAt: new Date(eventStartAt.getTime() - 60_000).toISOString(),
  });

  describe('ticket-tier integration', () => {
    beforeAll(async () => database.$connect());

    beforeEach(async () => {
      await database.auditLog.deleteMany();
      await database.order.deleteMany();
      await database.ticketTier.deleteMany();
      await database.event.deleteMany();
      await database.refreshSession.deleteMany();
      await database.user.deleteMany();
    });

    afterAll(async () => database.$disconnect());

    it('creates a tier for its organizer and records an audit event', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const event = await createDraftEvent(organizer.id);

      const response = await request(app)
        .post(`/api/v1/organizer/events/${event.id}/ticket-tiers`)
        .set(await bearer(organizer))
        .send(tierInput(event.startAt))
        .expect(201);

      await expect(
        database.auditLog.findFirst({
          where: { entityId: response.body.data.id, action: 'TICKET_TIER_CREATED' },
        }),
      ).resolves.not.toBeNull();
    });

    it('hides an organizer tier from another organizer', async () => {
      const owner = await createUser(UserRole.ORGANIZER, 'Owner');
      const intruder = await createUser(UserRole.ORGANIZER, 'Intruder');
      const event = await createDraftEvent(owner.id);
      const tier = await database.ticketTier.create({
        data: {
          ...tierInput(event.startAt),
          salesStartAt: new Date(Date.now() + 60_000),
          eventId: event.id,
        },
      });

      await request(app)
        .delete(`/api/v1/organizer/events/${event.id}/ticket-tiers/${tier.id}`)
        .set(await bearer(intruder))
        .expect(404);
    });

    it('prevents capacity changes that invalidate reserved or sold inventory', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const event = await createDraftEvent(organizer.id);
      const tier = await database.ticketTier.create({
        data: {
          ...tierInput(event.startAt),
          salesStartAt: new Date(Date.now() + 60_000),
          reservedQuantity: 3,
          soldQuantity: 4,
          eventId: event.id,
        },
      });

      const response = await request(app)
        .patch(`/api/v1/organizer/events/${event.id}/ticket-tiers/${tier.id}`)
        .set(await bearer(organizer))
        .send({ capacity: 6 })
        .expect(409);

      expect(response.body.errors[0].code).toBe('CAPACITY_TOO_LOW');
    });

    it('prevents price edits and deletion after order history', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      const event = await createDraftEvent(organizer.id);
      const tier = await database.ticketTier.create({
        data: {
          ...tierInput(event.startAt),
          salesStartAt: new Date(Date.now() + 60_000),
          eventId: event.id,
        },
      });
      await database.order.create({
        data: {
          attendeeId: attendee.id,
          eventId: event.id,
          ticketTierId: tier.id,
          eventNameSnapshot: event.title,
          ticketTierNameSnapshot: tier.name,
          unitPricePaisaSnapshot: tier.pricePaisa,
          quantity: 1,
          totalAmountPaisaSnapshot: tier.pricePaisa,
          reservationExpiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });

      await request(app)
        .patch(`/api/v1/organizer/events/${event.id}/ticket-tiers/${tier.id}`)
        .set(await bearer(organizer))
        .send({ pricePaisa: 60000 })
        .expect(409);
      await request(app)
        .delete(`/api/v1/organizer/events/${event.id}/ticket-tiers/${tier.id}`)
        .set(await bearer(organizer))
        .expect(409);
    });

    it('relies on PostgreSQL constraints for inventory safety', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const event = await createDraftEvent(organizer.id);
      const input = tierInput(event.startAt);

      await expect(
        database.ticketTier.create({
          data: {
            ...input,
            salesStartAt: new Date(input.salesStartAt),
            salesEndAt: new Date(input.salesEndAt),
            eventId: event.id,
            capacity: 1,
            reservedQuantity: 2,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2004' });
    });
  });
}
