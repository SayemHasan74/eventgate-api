import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  order: { findUnique: vi.fn() },
  paymentAttempt: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  refund: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  job: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
vi.mock('../src/config/env.js', () => ({ env: { PAYMENT_STALE_AFTER_MS: 60000 } }));
const {
  scheduleAdminReconciliation,
  retryRecoveryJob,
  jobReference,
  adminReasonSchema,
  safeAuditMetadata,
} = await import('../src/modules/reports/admin-operations.service.js');
const id = '123e4567-e89b-42d3-a456-426614174000';
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (operation) => operation(db));
  db.order.findUnique.mockResolvedValue({ eventId: id, ticketTierId: id });
  db.$queryRaw.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  db.paymentAttempt.findUnique.mockResolvedValue({ id, orderId: id, status: 'UNKNOWN' });
  db.paymentAttempt.findUniqueOrThrow.mockResolvedValue({ id, orderId: id, status: 'UNKNOWN' });
});
describe('admin recovery authority', () => {
  it('deduplicates an existing pending verification without erasing its backoff', async () => {
    db.job.upsert.mockResolvedValue({ id, status: 'PENDING', runAt: new Date(Date.now() + 60000) });
    expect(
      await scheduleAdminReconciliation('admin', 'payment', id, 'Investigate provider timeout'),
    ).toEqual({ jobId: id, status: 'PENDING' });
    expect(db.job.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        where: { deduplicationKey: `reconcile-payment:${id}` },
      }),
    );
    expect(db.job.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'RECONCILIATION_REQUESTED',
          metadata: expect.objectContaining({ reason: 'Investigate provider timeout' }),
        }),
      }),
    );
  });
  it('cannot queue verification of a terminal captured payment', async () => {
    db.paymentAttempt.findUniqueOrThrow.mockResolvedValue({ id, orderId: id, status: 'SUCCEEDED' });
    await expect(
      scheduleAdminReconciliation('admin', 'payment', id, 'Inspect captured payment'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.job.upsert).not.toHaveBeenCalled();
  });
  it('does not reinitiate an unknown refund without a provider reference', async () => {
    const refund = {
      id,
      orderId: id,
      status: 'UNKNOWN',
      needsInvestigation: false,
      providerRefundId: null,
    };
    db.refund.findUnique.mockResolvedValue(refund);
    db.refund.findUniqueOrThrow.mockResolvedValue(refund);
    await expect(
      scheduleAdminReconciliation('admin', 'refund', id, 'Investigate missing reference'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.job.upsert).not.toHaveBeenCalled();
  });
  it('blocks active leases and all non-failed jobs', async () => {
    for (const job of [
      { status: 'RUNNING', leaseExpiresAt: null },
      { status: 'SUCCEEDED', leaseExpiresAt: null },
      { status: 'FAILED', leaseExpiresAt: new Date(Date.now() + 60000) },
    ]) {
      db.job.findUnique.mockResolvedValue({ id, ...job });
      await expect(
        retryRecoveryJob('admin', id, 'Retry after investigation'),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });
  it('requeues only the same failed job and records its prior failure history', async () => {
    db.job.findUnique.mockResolvedValue({
      id,
      type: 'RECONCILE_PAYMENT',
      status: 'FAILED',
      leaseExpiresAt: null,
      payload: { paymentAttemptId: id },
      failureAttempts: 10,
      attempts: 15,
    });
    db.job.updateMany.mockResolvedValue({ count: 1 });
    expect(await retryRecoveryJob('admin', id, 'Provider outage is resolved')).toEqual({
      jobId: id,
      status: 'PENDING',
    });
    expect(db.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id, status: 'FAILED' }),
        data: expect.objectContaining({ status: 'PENDING', failureAttempts: 0 }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ previousFailureAttempts: 10, totalAttempts: 15 }),
        }),
      }),
    );
  });
  it('requires audit reasons and exposes only safe source references', () => {
    expect(adminReasonSchema.safeParse({ reason: ' ' }).success).toBe(false);
    expect(
      jobReference('RECONCILE_PAYMENT', {
        paymentAttemptId: id,
        qrToken: 'secret',
        checkoutUrl: 'secret',
      }),
    ).toEqual({ entityId: id, entityType: 'PAYMENT_ATTEMPT' });
    expect(jobReference('RECONCILE_PAYMENT', { paymentAttemptId: 'https://evil.test' })).toBeNull();
  });
  it('redacts audit credentials, raw payloads, QR content and checkout addresses', () => {
    const safe = safeAuditMetadata({
      from: 'ATTENDEE',
      to: 'ORGANIZER',
      qrToken: 'hidden',
      callback: { secret: 'hidden' },
      checkoutUrl: 'https://provider.test?secret=hidden',
      reason: `Inspect https://provider.test?token=hidden qrToken=hidden ${'a'.repeat(43)}`,
    });
    expect(safe).toMatchObject({ from: 'ATTENDEE', to: 'ORGANIZER' });
    expect(JSON.stringify(safe)).not.toContain('hidden');
    expect(JSON.stringify(safe)).not.toContain('a'.repeat(43));
  });
});
