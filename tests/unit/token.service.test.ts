import { describe, expect, it } from 'vitest';

process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-thirty-two-characters';

const { signAccessToken, verifyAccessToken } =
  await import('../../src/modules/auth/token.service.js');

describe('access tokens', () => {
  it('signs and verifies a short-lived EventGate access token', async () => {
    const token = await signAccessToken({
      userId: 'cd5643eb-9c30-4c91-8f98-dcbd23f1453e',
      role: 'ATTENDEE',
    });

    await expect(verifyAccessToken(token)).resolves.toEqual({
      userId: 'cd5643eb-9c30-4c91-8f98-dcbd23f1453e',
      role: 'ATTENDEE',
    });
  });
});
