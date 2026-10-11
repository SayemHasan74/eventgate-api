import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanDatabase } from './database-cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('user access-control integration', () => {
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

  const [
    { app },
    { getPrisma },
    { signAccessToken, createRefreshToken },
    { UserRole, UserStatus },
  ] = await Promise.all([
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

  describe('user access-control integration', () => {
    beforeAll(async () => {
      await database.$connect();
    });

    beforeEach(async () => {
      await cleanDatabase(database);
    });

    afterAll(async () => {
      await database.$disconnect();
    });

    it('allows an attendee to edit only their profile and rejects privilege injection', async () => {
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const headers = await bearer(attendee);

      await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ displayName: 'Updated Attendee' })
        .expect(200);
      await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ displayName: 'Attacker', role: UserRole.ADMIN })
        .expect(400);
      await request(app).get('/api/v1/admin/users').set(headers).expect(403);
      await request(app)
        .get('/api/v1/admin/users')
        .set(await bearer(organizer))
        .expect(403);
    });

    it('allows an admin to promote an attendee and records the audit event', async () => {
      const admin = await createUser(UserRole.ADMIN, 'Admin');
      const attendee = await createUser(UserRole.ATTENDEE, 'Candidate');

      const response = await request(app)
        .patch(`/api/v1/admin/users/${attendee.id}/role`)
        .set(await bearer(admin))
        .send({ role: UserRole.ORGANIZER })
        .expect(200);

      expect(response.body.data.role).toBe(UserRole.ORGANIZER);
      await expect(
        database.auditLog.findFirst({
          where: { actorId: admin.id, entityId: attendee.id, action: 'USER_ROLE_CHANGED' },
        }),
      ).resolves.not.toBeNull();
    });

    it('prevents demotion while an organizer has a nonterminal event', async () => {
      const admin = await createUser(UserRole.ADMIN, 'Admin');
      const organizer = await createUser(UserRole.ORGANIZER, 'Organizer');
      const startAt = new Date(Date.now() + 86_400_000);
      await database.event.create({
        data: {
          organizerId: organizer.id,
          title: 'Future Event',
          slug: `future-event-${crypto.randomUUID()}`,
          description: 'A valid event description that is long enough for the database fixture.',
          category: 'Technology',
          venue: 'Auditorium',
          city: 'Dhaka',
          address: '123 Event Street',
          startAt,
          endAt: new Date(startAt.getTime() + 3_600_000),
        },
      });

      const response = await request(app)
        .patch(`/api/v1/admin/users/${organizer.id}/role`)
        .set(await bearer(admin))
        .send({ role: UserRole.ATTENDEE })
        .expect(409);

      expect(response.body.errors[0].code).toBe('ORGANIZER_HAS_EVENTS');
      const deletion = await request(app)
        .delete(`/api/v1/admin/users/${organizer.id}`)
        .set(await bearer(admin))
        .expect(409);
      expect(deletion.body.errors[0].code).toBe('ORGANIZER_HAS_EVENTS');
    });

    it('invalidates an existing access token when an account is suspended', async () => {
      const admin = await createUser(UserRole.ADMIN, 'Admin');
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      const attendeeHeaders = await bearer(attendee);
      const session = createRefreshToken();
      await database.refreshSession.create({
        data: {
          userId: attendee.id,
          familyId: session.familyId,
          tokenHash: session.hash,
          expiresAt: session.expiresAt,
        },
      });

      const suspension = await request(app)
        .patch(`/api/v1/admin/users/${attendee.id}/status`)
        .set(await bearer(admin))
        .send({ status: UserStatus.SUSPENDED })
        .expect(200);
      const response = await request(app).get('/api/v1/users/me').set(attendeeHeaders).expect(401);

      expect(response.body.errors[0].code).toBe('ACCOUNT_INACTIVE');
      await expect(
        database.auditLog.findFirst({
          where: { actorId: admin.id, entityId: attendee.id, action: 'USER_STATUS_CHANGED' },
        }),
      ).resolves.not.toBeNull();
      expect(suspension.body.data.status).toBe(UserStatus.SUSPENDED);
      expect(
        await database.refreshSession.count({ where: { userId: attendee.id, revokedAt: null } }),
      ).toBe(0);
    });

    it('never exposes a password hash when role or status is unchanged', async () => {
      const admin = await createUser(UserRole.ADMIN, 'Admin');
      const attendee = await createUser(UserRole.ATTENDEE, 'Attendee');
      await database.user.update({
        where: { id: attendee.id },
        data: { passwordHash: 'private-password-hash' },
      });
      for (const [field, value] of [
        ['role', UserRole.ATTENDEE],
        ['status', UserStatus.ACTIVE],
      ] as const) {
        const response = await request(app)
          .patch(`/api/v1/admin/users/${attendee.id}/${field}`)
          .set(await bearer(admin))
          .send({ [field]: value })
          .expect(200);
        expect(response.body.data.changed).toBe(false);
        expect(response.body.data).not.toHaveProperty('passwordHash');
        expect(JSON.stringify(response.body)).not.toContain('private-password-hash');
      }
    });

    it('prevents self-suspension and self-deletion even when another admin exists', async () => {
      const admin = await createUser(UserRole.ADMIN, 'Admin');
      await createUser(UserRole.ADMIN, 'Other Admin');
      const headers = await bearer(admin);
      const suspension = await request(app)
        .patch(`/api/v1/admin/users/${admin.id}/status`)
        .set(headers)
        .send({ status: UserStatus.SUSPENDED })
        .expect(409);
      const deletion = await request(app)
        .delete(`/api/v1/admin/users/${admin.id}`)
        .set(headers)
        .expect(409);
      expect(suspension.body.errors[0].code).toBe('SELF_ACTION_FORBIDDEN');
      expect(deletion.body.errors[0].code).toBe('SELF_ACTION_FORBIDDEN');
    });

    it('protects the last active admin from suspension and soft deletion', async () => {
      const admin = await createUser(UserRole.ADMIN, 'Only Admin');
      const headers = await bearer(admin);

      await request(app)
        .patch(`/api/v1/admin/users/${admin.id}/status`)
        .set(headers)
        .send({ status: UserStatus.SUSPENDED })
        .expect(409);
      const deletion = await request(app)
        .delete(`/api/v1/admin/users/${admin.id}`)
        .set(headers)
        .expect(409);

      expect(deletion.body.errors[0].code).toBe('LAST_ACTIVE_ADMIN');
    });
  });
}
