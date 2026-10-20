import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ user: { findUnique: vi.fn(), count: vi.fn() } }));
vi.mock('../../src/lib/prisma.js', () => ({ getPrisma: () => db }));
vi.mock('../../src/modules/auth/token.service.js', () => ({
  verifyAccessToken: async () => ({ userId: 'user', role: 'ADMIN', tokenVersion: 0 }),
}));
const { app } = await import('../../src/app.js');
beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue({
    id: 'user',
    role: 'ADMIN',
    status: 'ACTIVE',
    deletedAt: null,
    tokenVersion: 0,
  });
  db.user.count.mockResolvedValue(5);
});
describe('admin request authentication', () => {
  it('reads the current account once across mounted admin routers', async () => {
    const result = await request(app)
      .get('/api/v1/admin/reports/summary/users')
      .set('Authorization', 'Bearer test');
    expect(result.status).toBe(200);
    expect(result.body.data.count).toBe(5);
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
  });
  it('still denies inactive and non-admin accounts', async () => {
    db.user.findUnique.mockResolvedValueOnce({
      id: 'user',
      role: 'ADMIN',
      status: 'SUSPENDED',
      tokenVersion: 0,
    });
    expect(
      (
        await request(app)
          .get('/api/v1/admin/reports/summary/users')
          .set('Authorization', 'Bearer test')
      ).status,
    ).toBe(401);
    db.user.findUnique.mockResolvedValueOnce({
      id: 'user',
      role: 'ATTENDEE',
      status: 'ACTIVE',
      tokenVersion: 0,
    });
    expect(
      (
        await request(app)
          .get('/api/v1/admin/reports/summary/users')
          .set('Authorization', 'Bearer test')
      ).status,
    ).toBe(403);
    expect(db.user.count).not.toHaveBeenCalled();
  });
});
