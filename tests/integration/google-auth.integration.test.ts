import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  describe.skip('Google account-linking integration', () => {
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

  const [{ getPrisma }, { linkGoogleIdentity, loginWithGoogle }] = await Promise.all([
    import('../../src/lib/prisma.js'),
    import('../../src/modules/auth/google-auth.service.js'),
  ]);
  const database = getPrisma();

  describe('Google account-linking integration', () => {
    beforeAll(async () => database.$connect());
    beforeEach(async () => {
      await database.auditLog.deleteMany();
      await database.authIdentity.deleteMany();
      await database.refreshSession.deleteMany();
      await database.user.deleteMany();
    });
    afterAll(async () => database.$disconnect());

    it('does not silently link a password account by matching email', async () => {
      const user = await database.user.create({
        data: {
          email: 'existing@example.com',
          displayName: 'Existing User',
          passwordHash: 'test-hash',
        },
        select: { id: true, email: true, displayName: true, role: true },
      });
      const googleIdentity = {
        subject: 'google-subject-for-existing-user',
        email: 'existing@example.com',
        displayName: 'Google Existing User',
      };

      await expect(loginWithGoogle(googleIdentity)).rejects.toMatchObject({
        code: 'GOOGLE_IDENTITY_NOT_LINKED',
      });
      await expect(linkGoogleIdentity(user, googleIdentity)).resolves.toEqual({
        alreadyLinked: false,
      });
      await expect(loginWithGoogle(googleIdentity)).resolves.toMatchObject({
        user: { id: user.id },
      });
    });
  });
}
