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
  process.env.JWT_REFRESH_SECRET = 'fixture-recovery-secret-at-least-thirty-two-characters';
  process.env.RESEND_API_KEY = 're_fixture_never_sent';
  process.env.EMAIL_FROM = 'EventGate <no-reply@example.test>';
  process.env.EMAIL_VERIFICATION_SECRET = 'fixture-email-secret-at-least-thirty-two-characters';
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
        email: `${name.toLowerCase().replaceAll(' ', '-')}-${crypto.randomUUID()}@example.com`,
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

    it('reads current identity without exposing profile secrets and rejects revoked sessions', async () => {
      const attendee = await createUser(UserRole.ATTENDEE, 'Identity Owner');
      const headers = await bearer(attendee);
      const identity = await request(app).get('/api/v1/users/me/identity').set(headers).expect(200);
      expect(identity.body.data).toEqual({
        id: attendee.id,
        email: attendee.email,
        displayName: attendee.displayName,
        role: 'ATTENDEE',
        isQuickAccess: false,
      });
      await database.user.update({
        where: { id: attendee.id },
        data: { role: UserRole.ORGANIZER },
      });
      const updated = await request(app).get('/api/v1/users/me/identity').set(headers).expect(200);
      expect(updated.body.data.role).toBe('ORGANIZER');
      await database.user.update({
        where: { id: attendee.id },
        data: { tokenVersion: { increment: 1 } },
      });
      await request(app).get('/api/v1/users/me/identity').set(headers).expect(401);
      await request(app).get('/api/v1/users/me/identity').expect(401);
    });

    it('changes credentials and immediately revokes old access and refresh sessions', async () => {
      const { default: argon2 } = await import('argon2');
      const attendee = await createUser(UserRole.ATTENDEE, 'Password Owner');
      await database.user.update({
        where: { id: attendee.id },
        data: { passwordHash: await argon2.hash('Original-password-123') },
      });
      const headers = await bearer(attendee),
        refresh = createRefreshToken();
      await database.refreshSession.create({
        data: {
          userId: attendee.id,
          familyId: refresh.familyId,
          tokenHash: refresh.hash,
          expiresAt: refresh.expiresAt,
        },
      });
      await request(app)
        .post('/api/v1/users/me/password')
        .set(headers)
        .send({ currentPassword: 'incorrect', password: 'Replacement-password-123' })
        .expect(400);
      await request(app)
        .post('/api/v1/users/me/password')
        .set(headers)
        .send({ currentPassword: 'Original-password-123', password: 'Replacement-password-123' })
        .expect(200);
      const response = await request(app).get('/api/v1/users/me').set(headers).expect(401);
      expect(response.body.errors[0].code).toBe('SESSION_REVOKED');
      expect(
        await database.refreshSession.count({ where: { userId: attendee.id, revokedAt: null } }),
      ).toBe(0);
      const updated = await database.user.findUniqueOrThrow({ where: { id: attendee.id } });
      expect(await argon2.verify(updated.passwordHash!, 'Replacement-password-123')).toBe(true);
      const newToken = await signAccessToken({
        userId: attendee.id,
        role: attendee.role,
        tokenVersion: updated.tokenVersion,
      });
      const profile = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${newToken}`)
        .expect(200);
      expect(profile.body.data.passwordLoginEnabled).toBe(true);
      expect(profile.body.data).not.toHaveProperty('passwordHash');
    });

    it('queues private recovery links, separates verification tokens, and consumes resets once', async () => {
      const { default: argon2 } = await import('argon2');
      const { passwordResetToken } = await import('../../src/modules/auth/password.service.js');
      const { verificationToken } =
        await import('../../src/modules/notifications/notifications.service.js');
      const attendee = await createUser(UserRole.ATTENDEE, 'Recovery Owner');
      await database.user.update({
        where: { id: attendee.id },
        data: { passwordHash: await argon2.hash('Original-password-123') },
      });
      const response = await request(app)
        .post('/api/v1/auth/request-password-reset')
        .send({ email: attendee.email })
        .expect(202);
      const unknown = await request(app)
        .post('/api/v1/auth/request-password-reset')
        .send({ email: 'missing@example.test' })
        .expect(202);
      expect(unknown.body.data).toEqual(response.body.data);
      const reset = await database.passwordReset.findFirstOrThrow({
        where: { userId: attendee.id },
      });
      const token = passwordResetToken(reset.id, attendee.id);
      expect(JSON.stringify(response.body)).not.toContain(token);
      const delivery = await database.notificationDelivery.findFirstOrThrow({
        where: { passwordResetId: reset.id },
      });
      expect(delivery.state).toBe('PENDING');
      expect(
        JSON.stringify(
          await database.notification.findFirstOrThrow({ where: { userId: attendee.id } }),
        ),
      ).not.toContain(token);
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: verificationToken(reset.id, attendee.id), password: 'New-password-123456' })
        .expect(400);
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token, password: 'New-password-123456' })
        .expect(200);
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token, password: 'Second-password-123456' })
        .expect(400);
      expect(
        (await database.user.findUniqueOrThrow({ where: { id: attendee.id } })).tokenVersion,
      ).toBe(1);
    });

    it('protects shared quick-access credentials from password changes and recovery', async () => {
      const { quickAccessEmail } = await import('../../src/shared/security/quick-access.js');
      const user = await database.user.create({
        data: { email: quickAccessEmail('ATTENDEE'), role: 'ATTENDEE', displayName: 'Shared' },
      });
      await request(app)
        .post('/api/v1/users/me/password')
        .set(await bearer(user))
        .send({ currentPassword: 'anything', password: 'Replacement-password-123' })
        .expect(403);
      await request(app)
        .post('/api/v1/auth/request-password-reset')
        .send({ email: user.email })
        .expect(202);
      expect(await database.passwordReset.count({ where: { userId: user.id } })).toBe(0);
    });

    it('cleans old operational records while retaining active token families', async () => {
      const { cleanExpiredOperationalRecords } = await import('../../src/jobs/retention.js');
      const user = await createUser(UserRole.ATTENDEE, 'Retention');
      const old = new Date(Date.now() - 40 * 86400000),
        family = crypto.randomUUID();
      for (const [familyId, expiresAt] of [
        [family, old],
        [family, new Date(Date.now() + 86400000)],
        [crypto.randomUUID(), old],
      ] as const) {
        await database.refreshSession.create({
          data: { userId: user.id, familyId, tokenHash: crypto.randomUUID(), expiresAt },
        });
      }
      const result = await cleanExpiredOperationalRecords();
      expect(result.sessions).toBe(1);
      expect(await database.refreshSession.count({ where: { familyId: family } })).toBe(2);
    });

    it('archives retired classification flags before removing unused columns', async () => {
      const { readFile } = await import('node:fs/promises');
      const user = await createUser(UserRole.ATTENDEE, 'Legacy');
      await database.$executeRawUnsafe(
        'ALTER TABLE "User" ADD COLUMN "isDemo" boolean NOT NULL DEFAULT false',
      );
      await database.$executeRawUnsafe(
        'ALTER TABLE "Event" ADD COLUMN "isDemo" boolean NOT NULL DEFAULT false',
      );
      await database.$executeRaw`UPDATE "User" SET "isDemo"=true WHERE "id"=${user.id}::uuid`;
      const sql = await readFile(
        new URL(
          '../../prisma/migrations/20261016010000_retire_unused_demo_flags/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await database.$executeRawUnsafe(sql);
      expect(
        await database.auditLog.count({
          where: { entityId: user.id, action: 'LEGACY_DEMO_CLASSIFICATION_ARCHIVED' },
        }),
      ).toBe(1);
      const columns = await database.$queryRaw<
        { count: number }[]
      >`SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('User','Event') AND column_name='isDemo'`;
      expect(columns[0]?.count).toBe(0);
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
