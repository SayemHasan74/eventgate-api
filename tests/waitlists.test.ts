import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, TicketTier } from '../src/generated/prisma/client.js';
import {
  waitlistEligibility,
  effectiveAvailability,
} from '../src/modules/waitlists/waitlist-policy.js';
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  ticketTier: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  order: { groupBy: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  waitlistEntry: {
    findUnique: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  job: { upsert: vi.fn(), updateMany: vi.fn() },
}));
const notice = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
vi.mock('../src/modules/notifications/notifications.service.js', () => ({
  writeNotification: notice,
  emailAvailable: () => false,
}));
const { recordInventoryRelease, dispatchWaitlistWave } =
  await import('../src/modules/waitlists/availability.service.js');
const { joinWaitlist, leaveWaitlist, listWaitlists } =
  await import('../src/modules/waitlists/waitlists.service.js');
const id = '123e4567-e89b-42d3-a456-426614174000',
  now = new Date('2026-10-14T10:00:00Z');
const event = {
  id,
  title: 'Example',
  slug: 'example',
  status: 'PUBLISHED',
  startAt: new Date('2026-10-20T10:00:00Z'),
  endAt: new Date('2026-10-20T12:00:00Z'),
  deletedAt: null,
} as Event;
const tier = {
  id,
  eventId: id,
  name: 'Admission',
  capacity: 10,
  reservedQuantity: 0,
  soldQuantity: 10,
  salesStartAt: new Date('2026-10-13T10:00:00Z'),
  salesEndAt: new Date('2026-10-20T09:00:00Z'),
  salesPaused: false,
  deletedAt: null,
  availabilityWave: 1,
  event,
} as TicketTier & { event: Event };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetAllMocks();
  db.$transaction.mockImplementation((fn) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({
    role: 'ATTENDEE',
    status: 'ACTIVE',
    deletedAt: null,
    notificationPreference: null,
  });
  db.ticketTier.findFirst.mockResolvedValue(tier);
  db.ticketTier.findUniqueOrThrow.mockResolvedValue(tier);
  db.ticketTier.update.mockResolvedValue({ ...tier, availabilityWave: 2 });
  db.waitlistEntry.findUnique.mockResolvedValue(null);
  db.order.count.mockResolvedValue(0);
  db.order.findFirst.mockResolvedValue(null);
  db.job.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());
describe('notify-only stock alerts', () => {
  it('allows only sold-out open windows without an existing entitlement', () => {
    expect(waitlistEligibility(event, tier, null, false, now).canJoin).toBe(true);
    for (const candidate of [
      { ...tier, salesPaused: true },
      { ...tier, salesStartAt: new Date('2026-10-15T10:00:00Z') },
      { ...tier, salesEndAt: new Date('2026-10-13T10:00:00Z') },
      { ...tier, soldQuantity: 9 },
    ])
      expect(waitlistEligibility(event, candidate, null, false, now).canJoin).toBe(false);
    expect(waitlistEligibility(event, tier, null, true, now).canJoin).toBe(false);
    expect(
      effectiveAvailability({ ...event, status: 'CANCELLED' }, { ...tier, soldQuantity: 9 }, now),
    ).toBe(0);
  });
  it('reads entitlements once for a whole waitlist page', async () => {
    db.waitlistEntry.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        ticketTierId: id,
        status: 'WAITING',
        lastNotifiedAt: null,
        ticketTier: tier,
      })),
    );
    db.waitlistEntry.count.mockResolvedValue(20);
    db.order.groupBy.mockResolvedValue([{ ticketTierId: id }]);
    const result = await listWaitlists('attendee', { page: 1, limit: 20 });
    expect(result.entries).toHaveLength(20);
    expect(db.order.groupBy).toHaveBeenCalledOnce();
    expect(db.order.count).not.toHaveBeenCalled();
    expect(result.entries[0]?.reason).toContain('already have a valid ticket');
  });
  it('retains cooldown when leaving and rejects early rejoining', async () => {
    db.waitlistEntry.findUnique.mockResolvedValue({
      id,
      ticketTierId: id,
      status: 'LEFT',
      lastNotifiedAt: new Date(now.getTime() - 30 * 60000),
    });
    await expect(joinWaitlist(id, id, id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'WAITLIST_NOT_ELIGIBLE',
    });
    expect(db.waitlistEntry.upsert).not.toHaveBeenCalled();
    await leaveWaitlist(id, id, id);
    const change = db.waitlistEntry.updateMany.mock.calls[0]![0];
    expect(change.where.userId).toBe(id);
    expect(change.data).not.toHaveProperty('lastNotifiedAt');
    expect(
      waitlistEligibility(
        event,
        tier,
        { status: 'LEFT', lastNotifiedAt: new Date(now.getTime() - 61 * 60000) },
        false,
        now,
      ).canJoin,
    ).toBe(true);
  });
  it('queues a versioned wave only for zero-to-positive eligible stock', async () => {
    db.ticketTier.findUniqueOrThrow.mockResolvedValue({ ...tier, soldQuantity: 9 });
    await recordInventoryRelease(db as never, id, 1);
    expect(db.job.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          type: 'DISPATCH_WAITLIST_ALERTS',
          deduplicationKey: `waitlist-wave:${id}:2`,
        }),
      }),
    );
    db.job.upsert.mockClear();
    db.ticketTier.findUniqueOrThrow.mockResolvedValue({ ...tier, soldQuantity: 8 });
    await recordInventoryRelease(db as never, id, 1);
    expect(db.job.upsert).not.toHaveBeenCalled();
    db.ticketTier.findUniqueOrThrow.mockResolvedValue({
      ...tier,
      soldQuantity: 9,
      salesPaused: true,
    });
    await recordInventoryRelease(db as never, id, 1);
    expect(db.job.upsert).not.toHaveBeenCalled();
  });
  it('dispatches once with stable ordering and a fenced checkpoint, never reserving stock', async () => {
    db.ticketTier.findFirst.mockResolvedValue({ ...tier, soldQuantity: 9 });
    db.waitlistEntry.findMany.mockResolvedValue([
      {
        id,
        userId: id,
        generation: 3,
        joinedAt: new Date(now.getTime() - 60000),
        lastNotifiedAt: null,
      },
    ]);
    const job = {
      id,
      leaseToken: id,
      payload: { eventId: id, tierId: id, wave: 1, openedAt: now.toISOString() },
    };
    expect(await dispatchWaitlistWave(job as never)).toBe(true);
    expect(db.waitlistEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }], take: 5 }),
    );
    expect(notice).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceKey: `waitlist:${id}:1:3`,
        actionPath: `/events/example/tickets?tierId=${id}`,
      }),
    );
    expect(db.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id, leaseToken: id, status: 'RUNNING' }),
      }),
    );
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.ticketTier.update).not.toHaveBeenCalled();
  });
  it('skips cooldowns and active reservations instead of marking a pending order fulfilled', async () => {
    db.ticketTier.findFirst.mockResolvedValue({ ...tier, soldQuantity: 9 });
    const job = {
      id,
      leaseToken: id,
      payload: { eventId: id, tierId: id, wave: 1, openedAt: now.toISOString() },
    };
    db.waitlistEntry.findMany.mockResolvedValue([
      {
        id,
        userId: id,
        generation: 0,
        joinedAt: now,
        lastNotifiedAt: new Date(now.getTime() - 1000),
      },
    ]);
    await dispatchWaitlistWave(job as never);
    expect(notice).not.toHaveBeenCalled();
    db.waitlistEntry.findMany.mockResolvedValue([
      { id, userId: id, generation: 0, joinedAt: now, lastNotifiedAt: null },
    ]);
    db.order.findFirst.mockResolvedValue({ status: 'PENDING_PAYMENT' });
    await dispatchWaitlistWave(job as never);
    expect(notice).not.toHaveBeenCalled();
    expect(db.waitlistEntry.update).not.toHaveBeenCalled();
  });
});
