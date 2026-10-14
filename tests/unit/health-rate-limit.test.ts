import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const queryRaw = vi.hoisted(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'fatal');
  vi.stubEnv('API_RATE_LIMIT_MAX', '2');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:fixture@localhost:5432/health_test');
  return vi.fn().mockResolvedValue([{ '?column?': 1 }]);
});

vi.mock('../../src/lib/prisma.js', () => ({
  getPrisma: () => ({ $queryRaw: queryRaw }),
}));

const { app } = await import('../../src/app.js');
vi.unstubAllEnvs();

describe('health probes and the public API rate budget', () => {
  it('exempts GET/HEAD probes while retaining limits on other routes', async () => {
    const probe = async () => {
      for (const path of ['/api/v1/health/live', '/api/v1/health/ready']) {
        for (const method of ['get', 'head'] as const) {
          const response = await request(app)[method](path);
          expect(response.status).toBe(200);
          expect(response.headers).not.toHaveProperty('ratelimit');
        }
      }
    };

    await probe();
    await probe();
    expect((await request(app).get('/api/v1/orders')).status).toBe(401);
    expect((await request(app).get('/api/v1/health/unknown')).status).toBe(404);
    const blocked = await request(app).get('/api/v1/orders');
    expect(blocked.status).toBe(429);
    expect(blocked.headers).toHaveProperty('ratelimit');
    await probe();
  });

  it('still reports database failure as unready after the API budget is exhausted', async () => {
    queryRaw.mockRejectedValueOnce(new Error('Fixture database unavailable'));
    const response = await request(app).get('/api/v1/health/ready');
    expect(response.status).toBe(503);
    expect(response.headers).not.toHaveProperty('ratelimit');
    expect((await request(app).get('/api/v1/health/live')).status).toBe(200);
  });
});
