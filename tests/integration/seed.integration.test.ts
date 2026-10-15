import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDevelopmentData } from '../../prisma/seed-data.js';
import { cleanDatabase } from './database-cleanup.js';

const target = process.env.TEST_DATABASE_URL;
if (!target) {
  describe.skip('non-destructive seed', () => {
    it('requires TEST_DATABASE_URL', () => undefined);
  });
} else {
  const { assertSafeTestDatabaseUrl } = await import('../test-database-safety.js');
  assertSafeTestDatabaseUrl();
  process.env.DATABASE_URL = target;
  const { getPrisma } = await import('../../src/lib/prisma.js');
  const database = getPrisma();
  const settings = {
    SEED_ADMIN_EMAIL: 'seed-admin@example.test',
    SEED_ORGANIZER_EMAIL: 'seed-organizer@example.test',
    SEED_ATTENDEE_EMAIL: 'seed-attendee@example.test',
    SEED_ADMIN_PASSWORD: 'Original-admin-123',
    SEED_ORGANIZER_PASSWORD: 'Original-organizer-123',
    SEED_ATTENDEE_PASSWORD: 'Original-attendee-123',
  };
  describe('non-destructive seed', () => {
    beforeEach(() => cleanDatabase(database));
    afterAll(() => database.$disconnect());
    it('creates a complete fixture once and preserves credentials, published events, tiers and inventory on reruns', async () => {
      expect((await seedDevelopmentData(database, settings)).eventCreated).toBe(true);
      const attendee = await database.user.findUniqueOrThrow({
        where: { email: settings.SEED_ATTENDEE_EMAIL },
      });
      await database.user.update({
        where: { id: attendee.id },
        data: {
          displayName: 'Owner-edited name',
          passwordHash: 'owner-changed-hash',
          tokenVersion: 7,
        },
      });
      const event = await database.event.findUniqueOrThrow({
        where: { slug: 'eventgate-launch-demo' },
      });
      await database.event.update({
        where: { id: event.id },
        data: { status: 'PUBLISHED', title: 'Owner-edited event', publishedAt: new Date() },
      });
      const tier = await database.ticketTier.findFirstOrThrow({
        where: { eventId: event.id, name: 'General Admission' },
      });
      await database.ticketTier.update({
        where: { id: tier.id },
        data: {
          pricePaisa: 12345,
          capacity: 300,
          soldQuantity: 20,
          reservedQuantity: 4,
          salesPaused: true,
        },
      });
      const vip = await database.ticketTier.findFirstOrThrow({
        where: { eventId: event.id, name: 'VIP' },
      });
      await database.ticketTier.update({ where: { id: vip.id }, data: { deletedAt: new Date() } });
      const snapshot = {
        users: await database.user.findMany({ orderBy: { email: 'asc' } }),
        events: await database.event.findMany(),
        tiers: await database.ticketTier.findMany({ orderBy: { name: 'asc' } }),
      };
      expect(
        (
          await seedDevelopmentData(
            database,
            { ...settings, SEED_ATTENDEE_PASSWORD: 'Different-password-123' },
            new Date(Date.now() + 86400000),
          )
        ).eventCreated,
      ).toBe(false);
      expect(await database.user.findMany({ orderBy: { email: 'asc' } })).toEqual(snapshot.users);
      expect(await database.event.findMany()).toEqual(snapshot.events);
      expect(await database.ticketTier.findMany({ orderBy: { name: 'asc' } })).toEqual(
        snapshot.tiers,
      );
    });
    it('does not reactivate suspended or archived accounts', async () => {
      await seedDevelopmentData(database, settings);
      const user = await database.user.update({
        where: { email: settings.SEED_ATTENDEE_EMAIL },
        data: { status: 'SUSPENDED', deletedAt: new Date() },
      });
      await expect(seedDevelopmentData(database, settings)).rejects.toThrow('inactive status');
      expect(await database.user.findUnique({ where: { id: user.id } })).toEqual(user);
    });
    it('rolls back earlier creations instead of promoting an existing ordinary account', async () => {
      const user = await database.user.create({
        data: {
          email: settings.SEED_ORGANIZER_EMAIL,
          displayName: 'Existing attendee',
          role: 'ATTENDEE',
        },
      });
      await expect(seedDevelopmentData(database, settings)).rejects.toThrow('conflicting role');
      expect(await database.user.count()).toBe(1);
      expect(await database.user.findUnique({ where: { id: user.id } })).toEqual(user);
      expect(await database.event.count()).toBe(0);
    });
  });
}
