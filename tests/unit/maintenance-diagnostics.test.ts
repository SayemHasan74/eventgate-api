import { beforeEach, describe, expect, it, vi } from 'vitest';

const { database, log } = vi.hoisted(() => ({
  database: {
    maintenanceState: { upsert: vi.fn(), updateMany: vi.fn() },
    job: { upsert: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
  log: { error: vi.fn() },
}));
vi.mock('../../src/lib/prisma.js', () => ({ getPrisma: () => database }));
vi.mock('../../src/lib/logger.js', () => ({ logger: log }));
vi.mock('../../src/config/env.js', () => ({
  env: {
    MAINTENANCE_MAX_JOBS: 10,
    MAINTENANCE_RUN_BUDGET_MS: 45000,
    PAYMENT_STALE_AFTER_MS: 120000,
  },
}));

const { runMaintenance } = await import('../../src/jobs/maintenance.service.js');
const { maintenanceFailureSummary } = await import('../../src/jobs/maintenance-diagnostics.js');

beforeEach(() => {
  vi.resetAllMocks();
  database.maintenanceState.upsert.mockResolvedValue({});
  database.maintenanceState.updateMany.mockResolvedValue({ count: 1 });
  database.$executeRaw.mockResolvedValue(0);
  database.$queryRaw.mockResolvedValue([]);
});

describe('maintenance failure diagnostics', () => {
  it('preserves the failure stage and exception without marking a failed pass completed', async () => {
    const error = Object.assign(new Error('Sensitive provider payload'), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '42804' } } },
    });
    database.$queryRaw.mockRejectedValueOnce(error);
    await expect(runMaintenance('fixture')).rejects.toBe(error);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error, stage: 'schedule-waitlists' }),
      'Maintenance pass failed',
    );
    expect(database.maintenanceState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastFailure: 'Maintenance failed during schedule-waitlists (Error/P2010/42804).',
        }),
      }),
    );
    const final = database.maintenanceState.updateMany.mock.calls.at(-1)?.[0].data;
    expect(final).toMatchObject({ failed: 1, processed: 0 });
    expect(final).not.toHaveProperty('lastCompletedAt');
  });

  it('does not let failed status writes replace the original exception', async () => {
    const original = new Error('Lease recovery failed');
    database.$executeRaw.mockRejectedValueOnce(original);
    database.maintenanceState.updateMany.mockRejectedValue(
      new Error('Status database unavailable'),
    );
    await expect(runMaintenance('fixture')).rejects.toBe(original);
  });

  it('captures initialization failures and job-claim failures', async () => {
    const initialization = new Error('Cannot record start');
    database.maintenanceState.upsert.mockRejectedValueOnce(initialization);
    await expect(runMaintenance('fixture')).rejects.toBe(initialization);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'record-start', err: initialization }),
      'Maintenance pass failed',
    );
    const claim = new Error('Claim failed');
    database.$queryRaw.mockImplementation(async (sql: { sql: string }) => {
      if (/WITH candidate/.test(sql.sql)) throw claim;
      return [];
    });
    await expect(runMaintenance('fixture')).rejects.toBe(claim);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'claim-job', err: claim }),
      'Maintenance pass failed',
    );
  });

  it('records a completed timestamp for a successful pass', async () => {
    await expect(runMaintenance('fixture')).resolves.toEqual({ processed: 0, failed: 0 });
    expect(database.maintenanceState.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastCompletedAt: expect.any(Date), failed: 0 }),
      }),
    );
  });

  it('keeps messages, credentials and payloads out of persisted diagnostics', () => {
    expect(
      maintenanceFailureSummary('claim-job', {
        name: 'Error',
        code: 'postgresql://user:secret@host/db',
        message: 'secret payment details',
        meta: { code: '40001' },
      }),
    ).toBe('Maintenance failed during claim-job (Error/40001).');
    expect(maintenanceFailureSummary('claim-job', null)).toContain('unknown error');
  });
});
