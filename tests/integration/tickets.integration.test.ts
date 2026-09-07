import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase } from './database-cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  describe.skip('tickets integration', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  if (!testDatabaseUrl.includes('eventgate_test'))
    throw new Error('TEST_DATABASE_URL must contain eventgate_test.');
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-thirty-two-characters';
  const [
    { app },
    { getPrisma },
    { signAccessToken },
    { EventStatus, OrderStatus, TicketStatus, UserRole },
  ] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/lib/prisma.js'),
    import('../../src/modules/auth/token.service.js'),
    import('../../src/generated/prisma/client.js'),
  ]);
  const request = (await import('supertest')).default;
  const database = getPrisma();
  const bearer = async (user: { id: string; role: string }) => ({
    Authorization: `Bearer ${await signAccessToken({ userId: user.id, role: user.role })}`,
  });
  const fixture = async () => {
    const organizer = await database.user.create({
      data: {
        email: `org-${crypto.randomUUID()}@e.test`,
        displayName: 'Organizer',
        role: UserRole.ORGANIZER,
      },
    });
    const attendee = await database.user.create({
      data: {
        email: `att-${crypto.randomUUID()}@e.test`,
        displayName: 'Attendee',
        role: UserRole.ATTENDEE,
      },
    });
    const other = await database.user.create({
      data: {
        email: `other-${crypto.randomUUID()}@e.test`,
        displayName: 'Other',
        role: UserRole.ATTENDEE,
      },
    });
    const startAt = new Date(Date.now() + 60 * 60 * 1000);
    const event = await database.event.create({
      data: {
        organizerId: organizer.id,
        title: 'Check in test',
        slug: `checkin-${crypto.randomUUID()}`,
        description: 'A long enough description for test fixture.',
        category: 'Tech',
        venue: 'Hall',
        city: 'Dhaka',
        address: 'Test road',
        startAt,
        endAt: new Date(startAt.getTime() + 3600000),
        status: EventStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
    const tier = await database.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General',
        pricePaisa: 10000,
        capacity: 2,
        soldQuantity: 1,
        salesStartAt: new Date(Date.now() - 60000),
        salesEndAt: new Date(startAt.getTime() - 60000),
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
        quantity: 1,
        totalAmountPaisaSnapshot: 10000,
        status: OrderStatus.PAID,
        reservationExpiresAt: new Date(),
        paidAt: new Date(),
      },
    });
    const ticket = await database.ticket.create({
      data: {
        orderId: order.id,
        eventId: event.id,
        ticketTierId: tier.id,
        attendeeId: attendee.id,
        sequence: 1,
        qrToken: crypto.randomBytes(32).toString('base64url'),
      },
    });
    return { organizer, attendee, other, event, ticket };
  };
  describe('tickets integration', () => {
    beforeAll(async () => database.$connect());
    beforeEach(async () => cleanDatabase(database));
    afterAll(async () => database.$disconnect());
    it('does not expose an attendee QR credential to another attendee', async () => {
      const { attendee, other, ticket } = await fixture();
      await request(app)
        .get(`/api/v1/tickets/${ticket.id}/qr`)
        .set(await bearer(other))
        .expect(404);
      await request(app)
        .get(`/api/v1/tickets/${ticket.id}/qr`)
        .set(await bearer(attendee))
        .expect('Content-Type', /image\/svg\+xml/)
        .expect(200);
    });
    it('allows exactly one of two simultaneous scans', async () => {
      const { organizer, event, ticket } = await fixture();
      const headers = await bearer(organizer);
      const responses = await Promise.all([
        request(app)
          .post(`/api/v1/organizer/events/${event.id}/check-ins`)
          .set(headers)
          .send({ qrToken: ticket.qrToken }),
        request(app)
          .post(`/api/v1/organizer/events/${event.id}/check-ins`)
          .set(headers)
          .send({ qrToken: ticket.qrToken }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      await expect(database.ticket.findUnique({ where: { id: ticket.id } })).resolves.toMatchObject(
        { status: TicketStatus.CHECKED_IN },
      );
    });
  });
}
