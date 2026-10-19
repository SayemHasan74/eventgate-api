import { describe, it, expect, vi } from 'vitest';
const db = vi.hoisted(() => ({ savedEvent: { findMany: vi.fn() }, event: { findMany: vi.fn() } }));
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
vi.mock('../src/config/env.js', () => ({ env: {} }));
const { savedMemberships, membershipBatchQuery } =
  await import('../src/modules/saved-events/saved-events.service.js');
const ids = ['123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174001'];
describe('bounded attendee saved-state batching', () => {
  it('scopes saved records to the authenticated attendee and handles missing events with two reads', async () => {
    db.savedEvent.findMany.mockResolvedValue([{ id: ids[1], eventId: ids[0] }]);
    db.event.findMany.mockResolvedValue([
      {
        id: ids[0],
        status: 'PUBLISHED',
        deletedAt: null,
        startAt: new Date(Date.now() + 86400000),
      },
    ]);
    const rows = await savedMemberships('attendee-a', [...ids, ids[0]!]);
    expect(db.savedEvent.findMany).toHaveBeenCalledTimes(1);
    expect(db.event.findMany).toHaveBeenCalledTimes(1);
    expect(db.savedEvent.findMany.mock.calls[0]?.[0].where).toEqual({
      userId: 'attendee-a',
      eventId: { in: ids },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.saved).not.toBeNull();
    expect(rows[0]?.canSave).toBe(true);
    expect(rows[1]?.saved).toBeNull();
    expect(rows[1]?.canSave).toBe(false);
  });
  it('validates UUIDs, rejects oversized or extra query inputs, and supports middleware reparsing', () => {
    const parsed = membershipBatchQuery.parse({ eventIds: ids.join(',') });
    expect(membershipBatchQuery.parse(parsed)).toEqual(parsed);
    for (const query of [
      { eventIds: '' },
      { eventIds: 'invalid' },
      { eventIds: Array(101).fill(ids[0]) },
      { eventIds: ids.join(','), userId: 'someone-else' },
    ])
      expect(membershipBatchQuery.safeParse(query).success).toBe(false);
  });
});
