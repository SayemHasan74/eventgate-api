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

  const [{ app }, { getPrisma }] = await Promise.all([
    import('../../src/app.js'),
    import('../../src/lib/prisma.js'),
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
      const rotation = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalToken })
        .expect(200);
      const replacementToken = rotation.body.data.refreshToken as string;

      const replay = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalToken })
        .expect(401);

      expect(replay.body.errors[0].code).toBe('REFRESH_TOKEN_REUSED');

      await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: replacementToken })
        .expect(401);
    });
  });
}
