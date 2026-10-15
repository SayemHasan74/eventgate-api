import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
vi.mock('../../src/config/env.js', () => ({
  env: {
    BFF_PROXY_SECRET: 'fixture-shared-proxy-secret-32-characters',
    AUTH_RATE_LIMIT_MAX: 2,
    API_RATE_LIMIT_MAX: 1200,
  },
}));
const { quickAccessRateLimiter } = await import('../../src/shared/security/rate-limit.js');
const { verifiedVisitorIp } = await import('../../src/shared/security/proxy-identity.js');
it('authenticates proxy identity, rejects spoofed/stale/path-replayed headers, and separates visitors', async () => {
  const app = express();
  app.post('/demo', quickAccessRateLimiter, (r, s) => s.json({ visitor: verifiedVisitorIp(r) }));
  function headers(ip: string, time = String(Date.now()), path = '/demo') {
    return {
      'x-eventgate-client-ip': ip,
      'x-eventgate-proxy-time': time,
      'x-eventgate-proxy-signature': createHmac(
        'sha256',
        'fixture-shared-proxy-secret-32-characters',
      )
        .update(`${time}\nPOST\n${path}\n${ip}`)
        .digest('hex'),
    };
  }
  for (const ip of ['203.0.113.1', '203.0.113.2']) {
    for (let i = 0; i < 2; i++)
      expect((await request(app).post('/demo').set(headers(ip))).body.visitor).toBe(ip);
    expect((await request(app).post('/demo').set(headers(ip))).status).toBe(429);
  }
  for (const h of [
    headers('203.0.113.3', String(Date.now() - 60000)),
    headers('203.0.113.3', undefined, '/other'),
    { ...headers('203.0.113.3'), 'x-eventgate-proxy-signature': '0'.repeat(64) },
  ]) {
    expect((await request(app).post('/demo').set(h)).body.visitor).toBeNull();
  }
});
