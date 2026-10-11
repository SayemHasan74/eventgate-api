import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanDatabase } from './database-cleanup.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('password authentication integration', () => {
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

  const [{ app }, { getPrisma }, { hashRefreshToken }] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/lib/prisma.js'),
    import('../../src/modules/auth/token.service.js'),
  ]);
  const request = (await import('supertest')).default;
  const database = getPrisma();

  describe('password authentication integration', () => {
    beforeAll(async () => {
      await database.$connect();
    });

    beforeEach(async () => {
      await cleanDatabase(database);
    });

    afterAll(async () => {
      await database.$disconnect();
    });

    it('registers an attendee and rejects caller-supplied roles', async () => {
      const invalidResponse = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'attendee@example.com',
          displayName: 'Attendee',
          password: 'CorrectHorseBattery1',
          role: 'ADMIN',
        })
        .expect(400);

      expect(invalidResponse.body.success).toBe(false);
      expect(invalidResponse.body.message).toBe('Validation failed');

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'attendee@example.com',
          displayName: 'Attendee',
          password: 'CorrectHorseBattery1',
        })
        .expect(201);

      expect(response.body.data.user).toMatchObject({
        email: 'attendee@example.com',
        role: 'ATTENDEE',
      });
      expect(response.body.data).not.toHaveProperty('passwordHash');
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.refreshToken).toEqual(expect.any(String));
    });

    it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
      const registration = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'attendee@example.com',
          displayName: 'Attendee',
          password: 'CorrectHorseBattery1',
        })
        .expect(201);

      const originalToken = registration.body.data.refreshToken as string;
      const originalSession = await database.refreshSession.findUniqueOrThrow({
        where: { tokenHash: hashRefreshToken(originalToken) },
      });
      const rotation = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalToken })
        .expect(200);
      const replacementToken = rotation.body.data.refreshToken as string;
      const replacementSession = await database.refreshSession.findUniqueOrThrow({
        where: { tokenHash: hashRefreshToken(replacementToken) },
      });
      expect(replacementSession.familyId).toBe(originalSession.familyId);
      expect(replacementSession.expiresAt).toEqual(originalSession.expiresAt);

      const replay = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalToken })
        .expect(401);

      expect(replay.body.errors[0].code).toBe('REFRESH_TOKEN_REUSED');
      expect(
        await database.refreshSession.count({
          where: { familyId: originalSession.familyId, revokedAt: null },
        }),
      ).toBe(0);
      expect(
        await database.auditLog.findFirst({
          where: { entityId: originalSession.id, action: 'AUTH_REFRESH_REUSE_DETECTED' },
        }),
      ).not.toBeNull();

      await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: replacementToken })
        .expect(401);
    });

    it('logs out the whole family using an old token without affecting another sign-in', async () => {
      const credentials = {
        email: 'logout@example.com',
        displayName: 'Attendee',
        password: 'CorrectHorseBattery1',
      };
      const registration = await request(app)
        .post('/api/v1/auth/register')
        .send(credentials)
        .expect(201);
      const oldToken = registration.body.data.refreshToken as string;
      const rotation = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldToken })
        .expect(200);
      const otherLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: credentials.email, password: credentials.password })
        .expect(200);

      await request(app).post('/api/v1/auth/logout').send({ refreshToken: oldToken }).expect(200);
      await request(app).post('/api/v1/auth/logout').send({ refreshToken: oldToken }).expect(200);
      await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotation.body.data.refreshToken })
        .expect(401);
      await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: otherLogin.body.data.refreshToken })
        .expect(200);
    });

    it('commits family revocation on absolute expiry or an inactive account', async () => {
      for (const reason of ['expiry', 'inactive'] as const) {
        const registration = await request(app)
          .post('/api/v1/auth/register')
          .send({
            email: `${reason}@example.com`,
            displayName: 'Attendee',
            password: 'CorrectHorseBattery1',
          })
          .expect(201);
        const originalToken = registration.body.data.refreshToken as string;
        const originalSession = await database.refreshSession.findUniqueOrThrow({
          where: { tokenHash: hashRefreshToken(originalToken) },
        });
        const rotation = await request(app)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: originalToken })
          .expect(200);
        if (reason === 'expiry') {
          await database.refreshSession.update({
            where: { id: originalSession.id },
            data: { expiresAt: new Date(Date.now() - 1000) },
          });
        } else {
          await database.user.update({
            where: { id: originalSession.userId },
            data: { status: 'SUSPENDED' },
          });
        }
        const rejection = await request(app)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: rotation.body.data.refreshToken })
          .expect(reason === 'expiry' ? 401 : 403);
        expect(rejection.body.errors[0].code).toBe(
          reason === 'expiry' ? 'REFRESH_TOKEN_EXPIRED' : 'ACCOUNT_INACTIVE',
        );
        expect(
          await database.refreshSession.count({
            where: { familyId: originalSession.familyId, revokedAt: null },
          }),
        ).toBe(0);
        expect(
          await database.auditLog.findFirst({
            where: {
              action:
                reason === 'expiry' ? 'AUTH_REFRESH_EXPIRED' : 'AUTH_REFRESH_ACCOUNT_INACTIVE',
              actorId: originalSession.userId,
            },
          }),
        ).not.toBeNull();
      }
    });
  });
}
