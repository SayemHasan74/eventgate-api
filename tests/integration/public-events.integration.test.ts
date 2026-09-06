import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanDatabase } from './database-cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('public event discovery integration', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  if (!testDatabaseUrl.includes('eventgate_test')) {
    throw new Error(
      'TEST_DATABASE_URL must point to a dedicated database whose URL contains "eventgate_test".',
    );
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  delete process.env.REDIS_URL;

  const [{ app }, { getPrisma }, { EventStatus, UserRole }] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/lib/prisma.js'),
    import('../../src/generated/prisma/client.js'),
  ]);
  const request = (await import('supertest')).default;
  const database = getPrisma();

  const createPublishedEvent = async (city: string, title: string) => {
    const organizer = await database.user.create({
      data: {
        email: `organizer-${crypto.randomUUID()}@example.com`,
        displayName: 'Organizer',
        role: UserRole.ORGANIZER,
      },
    });
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const event = await database.event.create({
      data: {
        organizerId: organizer.id,
        title,
        slug: `${title.toLowerCase().replaceAll(' ', '-')}-${crypto.randomUUID()}`,
        description: 'A sufficiently detailed published event fixture for public discovery tests.',
        category: 'Technology',
        venue: 'Innovation Hall',
        city,
        address: '42 Software Avenue',
        startAt,
        endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
        status: EventStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
    await database.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General Admission',
        pricePaisa: 50000,
        capacity: 10,
        reservedQuantity: 2,
        soldQuantity: 3,
        salesStartAt: new Date(),
        salesEndAt: new Date(startAt.getTime() - 60_000),
      },
    });
    return event;
  };

  describe('public event discovery integration', () => {
    beforeAll(async () => database.$connect());

    beforeEach(async () => {
      await cleanDatabase(database);
    });

    afterAll(async () => database.$disconnect());

    it('finds only published events with filtering, pagination, and derived availability', async () => {
      const dhaka = await createPublishedEvent('Dhaka', 'Dhaka Developer Meetup');
      await createPublishedEvent('Chattogram', 'Chattogram Developer Meetup');
      const draftOrganizer = await database.user.create({
        data: {
          email: `draft-${crypto.randomUUID()}@example.com`,
          displayName: 'Draft Organizer',
          role: UserRole.ORGANIZER,
        },
      });
      await database.event.create({
        data: {
          organizerId: draftOrganizer.id,
          title: 'Unpublished Meetup',
          slug: `unpublished-${crypto.randomUUID()}`,
          description: 'A sufficiently detailed draft event fixture for public discovery tests.',
          category: 'Technology',
          venue: 'Innovation Hall',
          city: 'Dhaka',
          address: '42 Software Avenue',
          startAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          endAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        },
      });

      const listing = await request(app)
        .get('/api/v1/events?city=Dhaka&limit=1&sort=title')
        .expect(200);
      expect(listing.body.meta).toMatchObject({ page: 1, limit: 1, total: 1 });
      expect(listing.body.data[0]).toMatchObject({ id: dhaka.id, city: 'Dhaka' });
      expect(listing.body.data[0].ticketTiers[0].availableQuantity).toBe(5);
    });

    it('returns public event detail and uses PostgreSQL when Redis is not configured', async () => {
      const event = await createPublishedEvent('Dhaka', 'Caching Fallback Meetup');

      const detail = await request(app).get(`/api/v1/events/${event.slug}`).expect(200);

      expect(detail.body.data).toMatchObject({ id: event.id, slug: event.slug });
      expect(detail.body.data.ticketTiers[0].availableQuantity).toBe(5);
    });
  });
}
