import { beforeEach, describe, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({ ticket: { findFirst: vi.fn() } }));
vi.mock('../../src/lib/prisma.js', () => ({ getPrisma: () => database }));
import { getMyTicketQr } from '../../src/modules/tickets/tickets.service.js';
describe('private QR JSON contract', () => {
  beforeEach(() => vi.resetAllMocks());
  it('generates an actual PNG without returning a raw credential and queries owner/active status', async () => {
    database.ticket.findFirst.mockResolvedValue({
      qrToken: 'opaque-test-credential-not-a-real-ticket-0000000000',
    });
    const qr = await getMyTicketQr('owner-id', 'ticket-id');
    expect(database.ticket.findFirst).toHaveBeenCalledWith({
      where: { id: 'ticket-id', attendeeId: 'owner-id', status: 'ACTIVE' },
      select: { qrToken: true },
    });
    expect(qr.mimeType).toBe('image/png');
    expect(qr.ticketId).toBe('ticket-id');
    expect(qr).not.toHaveProperty('qrToken');
    const png = Buffer.from(qr.dataUrl.split(',')[1], 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(320);
  });
  it('returns not found for an absent or ineligible pass', async () => {
    database.ticket.findFirst.mockResolvedValue(null);
    await expect(getMyTicketQr('wrong-owner', 'ticket-id')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
