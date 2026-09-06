import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('event lifecycle integration', () => {
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

  const futureEvent = () => {
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return {
      title: 'EventGate Engineering Meetup',
      slug: `engineering-meetup-${crypto.randomUUID()}`,
      description: 'A detailed engineering meetup description for a valid EventGate event.',
      category: 'Technology',
      venue: 'Innovation Hall',
      city: 'Dhaka',
      address: '42 Software Avenue, Dhaka',
      startAt: startAt.toISOString(),
      endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    };
  };

  describe('event lifecycle integration', () => {
    beforeAll(async () => database.$connect());

    beforeEach(async () => {
      await database.auditLog.deleteMany();
      await database.job.deleteMany();
      await database.ticketTier.deleteMany();
      await database.event.deleteMany();
      await database.refreshSession.deleteMany();
      await database.user.deleteMany();
    });

    afterAll(async () => database.$disconnect());

    it('allows only organizers to create events and records creation audit data', async () => {
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');

      await request(app)
        .post('/api/v1/organizer/events')
        .set(await bearer(attendee))
        .send(futureEvent())
        .expect(403);
      const created = await request(app)
        .post('/api/v1/organizer/events')
        .set(await bearer(organizer))
        .send(futureEvent())
        .expect(201);

      await expect(
        database.auditLog.findFirst({
          where: { actorId: organizer.id, entityId: created.body.data.id, action: 'EVENT_CREATED' },
        }),
      ).resolves.not.toBeNull();
    });

    it('hides an organizer event from another organizer', async () => {
      const owner = await createUser(UserRole.ORGANIZER, 'Owner');
      const intruder = await createUser(UserRole.ORGANIZER, 'Intruder');
      const created = await request(app)
        .post('/api/v1/organizer/events')
        .set(await bearer(owner))
        .send(futureEvent())
        .expect(201);

      await request(app)
        .patch(`/api/v1/organizer/events/${created.body.data.id}`)
        .set(await bearer(intruder))
        .send({ title: 'Takeover attempt' })
        .expect(404);
      await request(app)
        .post(`/api/v1/organizer/events/${created.body.data.id}/cancel`)
        .set(await bearer(intruder))
        .expect(404);
    });

    it('soft-deletes an eligible draft and records the deletion', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const created = await request(app)
        .post('/api/v1/organizer/events')
        .set(await bearer(organizer))
        .send(futureEvent())
        .expect(201);
      const eventId = created.body.data.id as string;

      await request(app)
        .delete(`/api/v1/organizer/events/${eventId}`)
        .set(await bearer(organizer))
        .expect(200);
      await expect(database.event.findUnique({ where: { id: eventId } })).resolves.toMatchObject({
        deletedAt: expect.any(Date),
      });
      await expect(
        database.auditLog.findFirst({ where: { entityId: eventId, action: 'EVENT_DELETED' } }),
      ).resolves.not.toBeNull();
    });

    it('enforces publication and post-publication edit transitions', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const created = await request(app)
        .post('/api/v1/organizer/events')
        .set(await bearer(organizer))
        .send(futureEvent())
        .expect(201);
      const eventId = created.body.data.id as string;

      await request(app)
        .post(`/api/v1/organizer/events/${eventId}/publish`)
        .set(await bearer(organizer))
        .expect(409);
      await database.ticketTier.create({
        data: {
          eventId,
          name: 'General Admission',
          pricePaisa: 50000,
          capacity: 50,
          salesStartAt: new Date(),
          salesEndAt: new Date(created.body.data.startAt),
        },
      });
      await request(app)
        .post(`/api/v1/organizer/events/${eventId}/publish`)
        .set(await bearer(organizer))
        .expect(200);
      await request(app)
        .patch(`/api/v1/organizer/events/${eventId}`)
        .set(await bearer(organizer))
        .send({ city: 'Chattogram' })
        .expect(409);
      await request(app)
        .patch(`/api/v1/organizer/events/${eventId}`)
        .set(await bearer(organizer))
        .send({ title: 'Updated Engineering Meetup' })
        .expect(200);
    });

    it('cancels an upcoming event with a durable job and rejects repeated cancellation', async () => {
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const created = await request(app)
        .post('/api/v1/organizer/events')
        .set(await bearer(organizer))
        .send(futureEvent())
        .expect(201);
      const eventId = created.body.data.id as string;

      await request(app)
        .post(`/api/v1/organizer/events/${eventId}/cancel`)
        .set(await bearer(organizer))
        .expect(200);
      await expect(
        database.job.findUnique({ where: { deduplicationKey: `event-cancellation:${eventId}` } }),
      ).resolves.not.toBeNull();
      await expect(
        database.auditLog.findFirst({ where: { entityId: eventId, action: 'EVENT_CANCELLED' } }),
      ).resolves.not.toBeNull();
      await request(app)
        .post(`/api/v1/organizer/events/${eventId}/cancel`)
        .set(await bearer(organizer))
        .expect(409);
    });
  });
}
