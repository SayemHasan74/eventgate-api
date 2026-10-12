import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../src/generated/prisma/client.js';
const db = vi.hoisted(() => ({
  event: { findUnique: vi.fn() },
  ticketTier: { findMany: vi.fn() },
  order: { findMany: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
const { eventSales, eventInventory, eventOrderCsv, csvCell } =
  await import('../src/modules/reports/event-report.service.js');
const actor = { id: 'organizer', role: UserRole.ORGANIZER };
const eventId = '123e4567-e89b-42d3-a456-426614174000';
beforeEach(() => {
  vi.resetAllMocks();
  db.event.findUnique.mockResolvedValue({ id: eventId, organizerId: actor.id });
});
describe('event financial reporting and export', () => {
  it('retains gross refunded sales and keeps pending/excess refunds separate', async () => {
    db.$queryRaw
      .mockResolvedValueOnce([
        {
          gross: 10000n,
          refunded: 10000n,
          pending: 0n,
          purchases: 1n,
          excess: 10000n,
          excessRefunds: 10000n,
          ambiguous: 0n,
        },
      ])
      .mockResolvedValueOnce([
        { day: '2026-10-12', gross: 10000n, refunded: 10000n, purchases: 1n },
      ]);
    db.$transaction.mockImplementation(async (operation) => operation(db));
    const result = await eventSales(actor, eventId, { status: 'REFUNDED' });
    expect(result).toMatchObject({
      grossTicketSalesPaisa: 10000,
      bookingRefundsPaisa: 10000,
      netTicketSalesPaisa: 0,
      fulfilledPurchaseCount: 1,
      excessCaptureRefundsPaisa: 10000,
    });
    expect(result.salesByDay[0]).toMatchObject({
      day: '2026-10-12',
      grossPaisa: 10000,
      netPaisa: 0,
    });
    const query = db.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain('p."id" = o."fulfilledPaymentAttemptId"');
    expect(query.values).toContain('REFUNDED');
    expect(query.sql).not.toContain('WHERE o."status" = \'PAID\'');
  });
  it('excludes deleted tier capacity but preserves historical issued facts', async () => {
    db.ticketTier.findMany.mockResolvedValue([
      {
        id: 'live',
        name: 'Live',
        deletedAt: null,
        capacity: 10,
        soldQuantity: 3,
        reservedQuantity: 2,
        _count: { tickets: 5, orders: 3 },
      },
      {
        id: 'old',
        name: 'Historical',
        deletedAt: new Date(),
        capacity: 100,
        soldQuantity: 2,
        reservedQuantity: 0,
        _count: { tickets: 2, orders: 1 },
      },
    ]);
    const report = await eventInventory(actor, eventId, {});
    expect(report.summary).toEqual({
      currentCapacity: 10,
      currentSold: 3,
      currentReserved: 2,
      currentAvailable: 5,
    });
    expect(report.tiers[1]).toMatchObject({ currentCapacity: 0, historicalIssuedPasses: 2 });
  });
  it('never exports another organizer event', async () => {
    db.event.findUnique.mockResolvedValue({ id: eventId, organizerId: 'foreign' });
    const rows = eventOrderCsv(
      actor,
      eventId,
      { page: 1, limit: 20 },
      new AbortController().signal,
    );
    await expect(rows.next()).rejects.toMatchObject({ statusCode: 404 });
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
  it('exports bounded cursor batches, respects filters and aborts further reads', async () => {
    const order = {
      id: 'order',
      quantity: 1,
      totalAmountPaisaSnapshot: 12345,
      status: 'PAID',
      createdAt: new Date(),
      paidAt: new Date(),
      refundedAt: null,
      ticketTierNameSnapshot: '=malicious',
      attendee: { displayName: '+formula', email: 'guest@example.com' },
    };
    db.order.findMany.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => ({ ...order, id: String(index) })),
    );
    const abort = new AbortController();
    const rows = eventOrderCsv(
      actor,
      eventId,
      { page: 4, limit: 20, status: 'PAID', tierId: eventId },
      abort.signal,
    );
    expect((await rows.next()).value).toContain('Reserved UTC');
    const batch = (await rows.next()).value;
    expect(batch).toContain('"\'+formula"');
    expect(batch).toContain('"\'=malicious"');
    expect(batch).toContain('"123.45"');
    expect(db.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({ eventId, status: 'PAID', ticketTierId: eventId }),
          ]),
        }),
      }),
    );
    abort.abort();
    expect((await rows.next()).done).toBe(true);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
  });
  it('neutralizes spreadsheet formulas and escapes quotes/newlines', () => {
    for (const value of ['=SUM(1,2)', ' +formula', '\t@formula', '-formula'])
      expect(csvCell(value)).toMatch(/^"'/);
    expect(csvCell('A "quoted", name')).toBe('"A ""quoted"", name"');
  });
});
