import { describe, expect, it } from 'vitest';

process.env.GOOGLE_CLIENT_ID = 'eventgate-test-client.apps.googleusercontent.com';

const { GoogleTokenVerifier } =
  await import('../../src/integrations/google/google-token-verifier.js');
const testIdToken = 'a'.repeat(40);

describe('Google ID-token verification', () => {
  it('rejects a token when Google rejects its audience', async () => {
    const verifier = new GoogleTokenVerifier({
      verifyIdToken: async () => {
        throw new Error('Wrong audience');
      },
    });
    await expect(verifier.verify(testIdToken)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_ID_TOKEN',
    });
  });

  it('rejects an expired token reported by Google', async () => {
    const verifier = new GoogleTokenVerifier({
      verifyIdToken: async () => {
        throw new Error('Token used too late');
      },
    });
    await expect(verifier.verify(testIdToken)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_ID_TOKEN',
    });
  });

  it('rejects a Google profile with an unverified email', async () => {
    const verifier = new GoogleTokenVerifier({
      verifyIdToken: async () => ({
        getPayload: () => ({
          sub: 'google-subject',
          email: 'user@example.com',
          email_verified: false,
        }),
      }),
    });
    await expect(verifier.verify(testIdToken)).rejects.toMatchObject({
      code: 'GOOGLE_EMAIL_NOT_VERIFIED',
    });
  });

  it('uses Google subject rather than email as the stable identity', async () => {
    const verifier = new GoogleTokenVerifier({
      verifyIdToken: async ({ audience }) => {
        expect(audience).toBe('eventgate-test-client.apps.googleusercontent.com');
        return {
          getPayload: () => ({
            sub: 'google-stable-subject',
            email: 'User@Example.com',
            email_verified: true,
            name: 'Google User',
          }),
        };
      },
    });
    await expect(verifier.verify(testIdToken)).resolves.toEqual({
      subject: 'google-stable-subject',
      email: 'user@example.com',
      displayName: 'Google User',
    });
  });
});
