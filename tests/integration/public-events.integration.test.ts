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

    it('keeps previously published event details accessible after completion or cancellation without reopening sales', async () => {
      const event = await createPublishedEvent('Dhaka', 'Historical event');
      for (const status of [EventStatus.COMPLETED, EventStatus.CANCELLED]) {
        await database.event.update({ where: { id: event.id }, data: { status } });
        const detail = await request(app).get(`/api/v1/events/${event.slug}`).expect(200);
        expect(detail.body.data.status).toBe(status);
        expect(detail.body.data.title).toBe(event.title);
        expect(detail.body.data.organizer.email).toBeUndefined();
        const catalog = await request(app).get('/api/v1/events').expect(200);
        expect(catalog.body.data).toHaveLength(0);
        await request(app).get(`/api/v1/events/${event.slug}/availability`).expect(404);
      }
      await database.event.update({ where: { id: event.id }, data: { publishedAt: null } });
      await request(app).get(`/api/v1/events/${event.slug}`).expect(404);
      await database.event.update({ where: { id: event.id }, data: { status: EventStatus.DRAFT } });
      await request(app).get(`/api/v1/events/${event.slug}`).expect(404);
      await database.event.update({
        where: { id: event.id },
        data: { status: EventStatus.COMPLETED, publishedAt: new Date(), deletedAt: new Date() },
      });
      await request(app).get(`/api/v1/events/${event.slug}`).expect(404);
    });

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

    it('returns fresh availability after stock changes and hides unpublished events', async () => {
      const event = await createPublishedEvent('Dhaka', 'Fresh Stock');
      const url = `/api/v1/events/${event.slug}/availability`;
      const first = await request(app).get(url).expect(200);
      expect(first.body.data.ticketTiers[0].availableQuantity).toBe(5);
      await database.ticketTier.updateMany({
        where: { eventId: event.id },
        data: { reservedQuantity: 4 },
      });
      const second = await request(app).get(url).expect(200);
      expect(second.body.data.ticketTiers[0].availableQuantity).toBe(3);
      await database.event.update({ where: { id: event.id }, data: { status: EventStatus.DRAFT } });
      await request(app).get(url).expect(404);
    });

    it('returns public event detail and uses PostgreSQL when Redis is not configured', async () => {
      const event = await createPublishedEvent('Dhaka', 'Caching Fallback Meetup');

      const detail = await request(app).get(`/api/v1/events/${event.slug}`).expect(200);

      expect(detail.body.data).toMatchObject({ id: event.id, slug: event.slug });
      expect(detail.body.data.ticketTiers[0].availableQuantity).toBe(5);
    });
  });
}
