import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  env: { API_RATE_LIMIT_MAX: 2, AUTH_RATE_LIMIT_MAX: 1 },
}));
vi.mock('../../src/modules/auth/token.service.js', () => ({
  verifyAccessToken: vi.fn(async (token: string) => {
    if (!['signed-alice', 'signed-bob'].includes(token)) throw new Error('Invalid signature');
    return { userId: token, role: 'ATTENDEE' };
  }),
}));
const { apiRateLimiter, authRateLimiter } = await import('../../src/shared/security/rate-limit.js');

describe('rate limits behind a shared frontend server', () => {
  it('separates verified users and keeps fabricated tokens in the anonymous IP budget', async () => {
    const app = express();
    app.use(apiRateLimiter);
    app.get('/', (_req, res) => res.sendStatus(200));
    for (const token of ['signed-alice', 'signed-bob']) {
      for (let i = 0; i < 2; i++)
        expect((await request(app).get('/').set('Authorization', `Bearer ${token}`)).status).toBe(
          200,
        );
      expect((await request(app).get('/').set('Authorization', `Bearer ${token}`)).status).toBe(
        429,
      );
    }
    expect((await request(app).get('/').set('Authorization', 'Bearer fake-one')).status).toBe(200);
    expect((await request(app).get('/').set('Authorization', 'Bearer fake-two')).status).toBe(200);
    expect((await request(app).get('/').set('Authorization', 'Bearer fake-three')).status).toBe(
      429,
    );
  });

  it('allows successful sign-ins without consuming the failed-credential budget', async () => {
    const app = express();
    app.use(authRateLimiter);
    app.post('/success', (_req, res) => res.sendStatus(200));
    app.post('/failure', (_req, res) => res.sendStatus(401));
    expect((await request(app).post('/success')).status).toBe(200);
    expect((await request(app).post('/success')).status).toBe(200);
    expect((await request(app).post('/failure')).status).toBe(401);
    expect((await request(app).post('/failure')).status).toBe(429);
  });
});
