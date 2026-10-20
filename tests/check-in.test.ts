import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../src/generated/prisma/client.js';
import { checkInSchema } from '../src/modules/tickets/tickets.schemas.js';
import type { AdmissionInput } from '../src/modules/tickets/ticket-admission.js';

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
const { checkInTicket } = await import('../src/modules/tickets/tickets.service.js');
const eventId = 'c4fb190c-0ec0-4444-8444-555555555555';
const actor = { id: 'operator', role: UserRole.ORGANIZER };
const input = { qrToken: 'a'.repeat(43) };

function fixture() {
  const event = {
    id: eventId,
    organizerId: actor.id,
    status: 'PUBLISHED',
    deletedAt: null,
    startAt: new Date(Date.now() + 3600000),
    endAt: new Date(Date.now() + 7200000),
  };
  const ticket: AdmissionInput & {
    id: string;
    sequence: number;
    checkedInAt: Date | null;
    ticketTier: { name: string };
    attendee: { displayName: string };
  } = {
    id: 'pass',
    sequence: 1,
    checkedInAt: null,
    status: 'ACTIVE',
    event,
    ticketTier: { name: 'Admission' },
    attendee: { displayName: 'Guest' },
    order: {
      status: 'PAID',
      financialReviewRequired: false,
      fulfilledPaymentAttemptId: 'capture',
      fulfilledPaymentAttempt: {
        status: 'SUCCEEDED',
        providerTransactionId: 'verified',
        replayOfAttemptId: null,
      },
      refunds: [],
    },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    event: { findUnique: vi.fn().mockResolvedValue(event) },
    order: { findUnique: vi.fn().mockResolvedValue({ eventId, ticketTierId: 'tier' }) },
    ticket: {
      findUnique: vi.fn().mockResolvedValue({ eventId, orderId: 'order' }),
      findFirst: vi.fn().mockResolvedValue(ticket),
      updateMany: vi.fn().mockImplementation(async ({ data }: { data: { checkedInAt: Date } }) => {
        ticket.status = 'CHECKED_IN';
        ticket.checkedInAt = data.checkedInAt;
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  db.$transaction.mockImplementation(async (operation: (value: typeof tx) => unknown) =>
    operation(tx),
  );
  return { event, ticket, tx };
}
beforeEach(() => vi.clearAllMocks());
describe('authoritative check-in decision', () => {
  it('admits once, records the operator and produces a stable duplicate result', async () => {
    const { tx } = fixture();
    expect(await checkInTicket(actor, eventId, input)).toMatchObject({ resultCode: 'ACCEPTED' });
    expect(await checkInTicket(actor, eventId, input)).toMatchObject({
      resultCode: 'ALREADY_CHECKED_IN',
    });
    expect(tx.ticket.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', eventId }),
        data: expect.objectContaining({ checkedInById: actor.id }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('shares event state locks and does not lock tier inventory for admission', async () => {
    const { tx } = fixture();
    await checkInTicket(actor, eventId, input);
    const statements = tx.$queryRaw.mock.calls.map(([query]) => query.sql as string);
    expect(statements.filter((sql) => sql.includes('FROM "Event"'))).toHaveLength(1);
    expect(statements.find((sql) => sql.includes('FROM "Event"'))).toContain('FOR SHARE');
    expect(statements.some((sql) => sql.includes('FROM "TicketTier"'))).toBe(false);
  });
  it('does not load foreign order or attendee details', async () => {
    const { tx } = fixture();
    tx.ticket.findUnique.mockResolvedValue({ eventId: 'foreign', orderId: 'foreign-order' });
    expect(await checkInTicket(actor, eventId, input)).toEqual({ resultCode: 'WRONG_EVENT' });
    expect(tx.order.findUnique).not.toHaveBeenCalled();
    expect(tx.ticket.findFirst).not.toHaveBeenCalled();
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
  });
  it('blocks original-capture refund requests', async () => {
    const { ticket, tx } = fixture();
    ticket.order.refunds = [
      { paymentAttemptId: 'capture', status: 'REQUESTED', needsInvestigation: false },
    ];
    expect(await checkInTicket(actor, eventId, input)).toMatchObject({
      resultCode: 'ADMISSION_BLOCKED',
      admissionState: 'REFUND_PENDING',
    });
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
  });
  it('rejects closed windows and unauthorized operators before admission', async () => {
    const { event, tx } = fixture();
    event.endAt = new Date(Date.now() - 1000);
    expect(await checkInTicket(actor, eventId, input)).toEqual({ resultCode: 'WINDOW_CLOSED' });
    event.organizerId = 'another-operator';
    await expect(checkInTicket(actor, eventId, input)).rejects.toMatchObject({ statusCode: 404 });
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
  });
  it('rejects URLs and oversized content at the request boundary', () => {
    expect(checkInSchema.safeParse(input).success).toBe(true);
    for (const qrToken of ['https://example.com', 'a'.repeat(44), '!'.repeat(43)])
      expect(checkInSchema.safeParse({ qrToken }).success).toBe(false);
  });
});
