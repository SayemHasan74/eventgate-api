import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/middleware/authenticate.js', () => ({
  authenticate: ((req, res, next) => {
    if (!req.headers.authorization) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    req.auth = { id: 'fixture-owner', role: 'ATTENDEE' } as typeof req.auth;
    next();
  }) satisfies RequestHandler,
}));
vi.mock('../../src/modules/tickets/tickets.service.js', () => ({
  getMyTicketQr: vi.fn().mockResolvedValue({
    ticketId: '123e4567-e89b-42d3-a456-426614174000',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,fixture',
  }),
}));
const { ticketsRouter } = await import('../../src/modules/tickets/tickets.router.js');
const app = express();
app.use('/tickets', ticketsRouter);
app.use(((error, _req, res, _next) => {
  void _next; // Express identifies error middleware by its four-argument signature.
  res.status(error.statusCode ?? 500).json({ success: false, message: 'Request rejected' });
}) satisfies ErrorRequestHandler);

describe('Express private ticket transport', () => {
  it('marks authentication and validation failures private/no-store too', async () => {
    for (const response of [
      await request(app).get('/tickets/123e4567-e89b-42d3-a456-426614174000/qr'),
      await request(app).get('/tickets/not-a-uuid/qr').set('Authorization', 'Bearer fixture'),
    ]) {
      expect([400, 401]).toContain(response.status);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body.success).toBe(false);
    }
  });
  it('returns the QR JSON envelope without exposing a token field', async () => {
    const response = await request(app)
      .get('/tickets/123e4567-e89b-42d3-a456-426614174000/qr')
      .set('Authorization', 'Bearer fixture');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({ success: true, data: { mimeType: 'image/png' } });
    expect(response.body.data).not.toHaveProperty('qrToken');
  });
});
