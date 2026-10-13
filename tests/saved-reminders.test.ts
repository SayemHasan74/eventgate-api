import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, SavedEvent, TicketTier } from '../src/generated/prisma/client.js';
import {
  bookingReminderPlan,
  savedReminderPlan,
  sourceDigest,
} from '../src/modules/saved-events/reminder-plan.js';
const db = vi.hoisted(() => ({
  event: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  savedEvent: { findFirst: vi.fn() },
  order: { count: vi.fn(), findFirst: vi.fn() },
  ticketTier: { findFirst: vi.fn() },
}));
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
vi.mock('../src/config/env.js', () => ({ env: {} }));
const { reminderStillRelevant } = await import('../src/modules/saved-events/reminders.service.js');
const id = '123e4567-e89b-42d3-a456-426614174000';
const now = new Date('2026-10-13T10:00:00Z');
const event = {
  id,
  title: 'Example event',
  slug: 'example-event',
  status: 'PUBLISHED',
  deletedAt: null,
  startAt: new Date('2026-10-16T10:00:00Z'),
  endAt: new Date('2026-10-16T12:00:00Z'),
  reminderVersion: 2,
} as Event;
const saved = {
  id,
  userId: id,
  eventId: id,
  createdAt: now,
  saleReminderEnabled: true,
  eventReminderEnabled: true,
  reminderVersion: 0,
} as SavedEvent;
const tier = {
  id,
  eventId: id,
  name: 'Admission',
  salesStartAt: new Date('2026-10-14T10:00:00Z'),
  salesEndAt: new Date('2026-10-16T09:00:00Z'),
  salesPaused: false,
  deletedAt: null,
  capacity: 10,
  reservedQuantity: 0,
  soldQuantity: 0,
} as TicketTier;
beforeEach(() => {
  vi.resetAllMocks();
  db.event.findUnique.mockResolvedValue(event);
  db.user.findUnique.mockResolvedValue({ role: 'ATTENDEE', status: 'ACTIVE', deletedAt: null });
  db.savedEvent.findFirst.mockResolvedValue(saved);
  db.ticketTier.findFirst.mockResolvedValue(tier);
  db.order.count.mockResolvedValue(0);
});
describe('timestamp-derived saved and booking reminders', () => {
  it('schedules real future windows and omits stale 24-hour reminders', () => {
    const plan = savedReminderPlan(saved, event, [tier], now);
    expect(plan.map((row) => [row.kind, row.runAt])).toEqual([
      ['SAVED_EVENT', '2026-10-15T10:00:00.000Z'],
      ['SAVED_SALE', '2026-10-14T10:00:00.000Z'],
    ]);
    expect(
      savedReminderPlan(
        { ...saved, createdAt: new Date('2026-10-16T00:00:00Z') },
        event,
        [tier],
        new Date('2026-10-16T00:00:00Z'),
      ),
    ).toEqual([]);
    expect(
      savedReminderPlan(saved, event, [{ ...tier, salesPaused: true }], now).map((row) => row.kind),
    ).toEqual(['SAVED_EVENT']);
    expect(savedReminderPlan(saved, { ...event, status: 'CANCELLED' }, [tier], now)).toEqual([]);
  });
  it('versions jobs without changing the once-per-window notification identity', () => {
    const before = savedReminderPlan(saved, event, [tier], now)[1]!;
    const after = savedReminderPlan(
      { ...saved, reminderVersion: 1 },
      { ...event, reminderVersion: 3 },
      [tier],
      now,
    )[1]!;
    expect(sourceDigest(before)).not.toBe(sourceDigest(after));
    expect(before.sourceKey).toBe(after.sourceKey);
    expect(
      savedReminderPlan(
        saved,
        event,
        [{ ...tier, salesEndAt: new Date('2026-10-16T08:00:00Z') }],
        now,
      )[1]!.sourceKey,
    ).not.toBe(before.sourceKey);
  });
  it('keeps paid booking reminders separate and never backfills a missed interval', () => {
    const order = {
      id,
      attendeeId: id,
      status: 'PAID' as const,
      paidAt: now,
      financialReviewRequired: false,
    };
    expect(bookingReminderPlan(order, event, now).map((row) => row.kind)).toEqual([
      'BOOKING_24H',
      'BOOKING_2H',
    ]);
    const late = new Date('2026-10-16T00:00:00Z');
    expect(
      bookingReminderPlan({ ...order, paidAt: late }, event, late).map((row) => row.kind),
    ).toEqual(['BOOKING_2H']);
    expect(bookingReminderPlan({ ...order, status: 'REFUNDED' }, event, now)).toEqual([]);
  });
  it('rechecks ownership, removal and generation before dispatch', async () => {
    const payload = savedReminderPlan(saved, event, [tier], now)[1]!;
    const at = new Date('2026-10-14T10:05:00Z');
    expect(
      await reminderStillRelevant(
        db as never,
        { payload },
        '00000000-0000-0000-0000-000000000000',
        at,
      ),
    ).toBeNull();
    db.savedEvent.findFirst.mockResolvedValue(null);
    expect(await reminderStillRelevant(db as never, { payload }, id, at)).toBeNull();
    db.savedEvent.findFirst.mockResolvedValue(saved);
    db.event.findUnique.mockResolvedValue({ ...event, reminderVersion: 3 });
    expect(await reminderStillRelevant(db as never, { payload }, id, at)).toBeNull();
  });
  it('suppresses unavailable sales and paid entitlements', async () => {
    const payload = savedReminderPlan(saved, event, [tier], now)[1]!;
    const at = new Date('2026-10-14T10:05:00Z');
    expect((await reminderStillRelevant(db as never, { payload }, id, at))?.actionPath).toBe(
      '/events/example-event',
    );
    db.ticketTier.findFirst.mockResolvedValue({ ...tier, soldQuantity: 10 });
    expect(await reminderStillRelevant(db as never, { payload }, id, at)).toBeNull();
    db.ticketTier.findFirst.mockResolvedValue(tier);
    db.order.count.mockResolvedValue(1);
    expect(await reminderStillRelevant(db as never, { payload }, id, at)).toBeNull();
  });
});
