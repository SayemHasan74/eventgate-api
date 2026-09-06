import {
  EventStatus,
  JobStatus,
  JobType,
  OrderStatus,
  Prisma,
  type Job,
} from '../generated/prisma/client.js';
import { getPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { invalidatePublicDiscoveryCache } from '../modules/public-events/public-events.cache.js';

const leaseSeconds = 60;
const cancellationBatchSize = 100;

class RescheduleJob extends Error {
  public constructor(
    public readonly delayMilliseconds: number,
    message: string,
  ) {
    super(message);
  }
}

const retryDelayMilliseconds = (attempts: number): number =>
  Math.min(60_000 * 2 ** attempts, 15 * 60_000);

const jobPayloadId = (job: Job, key: string): string => {
  const value = job.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Job ${job.id} has an invalid ${key} payload.`);
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload[key] !== 'string')
    throw new Error(`Job ${job.id} has an invalid ${key} payload.`);
  return payload[key];
};

const claimNextJob = async (workerId: string): Promise<Job | undefined> => {
  const jobs = await getPrisma().$queryRaw<Job[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id"
      FROM "Job"
      WHERE (("status" = 'PENDING' AND "runAt" <= NOW())
         OR ("status" = 'RUNNING' AND "leaseExpiresAt" <= NOW()))
        AND "attempts" < "maxAttempts"
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job" AS job
    SET "status" = 'RUNNING',
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "leaseExpiresAt" = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        "attempts" = job."attempts" + 1,
        "lastError" = NULL
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job.*
  `);
  return jobs[0];
};

const finishJob = async (job: Job, workerId: string): Promise<void> => {
  await getPrisma().job.updateMany({
    where: { id: job.id, status: JobStatus.RUNNING, lockedBy: workerId },
    data: {
      status: JobStatus.SUCCEEDED,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
};

const retryOrFailJob = async (job: Job, workerId: string, error: unknown): Promise<void> => {
  const message =
    error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown maintenance job error.';
  const reschedule = error instanceof RescheduleJob;
  const shouldFail = !reschedule && job.attempts >= job.maxAttempts;
  await getPrisma().job.updateMany({
    where: { id: job.id, status: JobStatus.RUNNING, lockedBy: workerId },
    data: shouldFail
      ? {
          status: JobStatus.FAILED,
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          lastError: message,
        }
      : {
          status: JobStatus.PENDING,
          runAt: new Date(
            Date.now() +
              (reschedule ? error.delayMilliseconds : retryDelayMilliseconds(job.attempts)),
          ),
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          lastError: message,
        },
  });
};

const releasePendingOrder = async (orderId: string, status: 'EXPIRED' | 'CANCELLED') => {
  let released = false;
  await getPrisma().$transaction(
    async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT || order.reservationReleasedAt)
        return;
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING_PAYMENT, reservationReleasedAt: null },
        data: { status, reservationReleasedAt: new Date() },
      });
      if (updated.count !== 1) return;
      const inventoryUpdated = await tx.$executeRaw(Prisma.sql`
        UPDATE "TicketTier"
        SET "reservedQuantity" = "reservedQuantity" - ${order.quantity}
        WHERE "id" = ${order.ticketTierId}
          AND "reservedQuantity" >= ${order.quantity}
      `);
      if (inventoryUpdated !== 1)
        throw new Error(`Could not release inventory for order ${order.id}.`);
      await tx.auditLog.create({
        data: {
          action: status === OrderStatus.EXPIRED ? 'ORDER_EXPIRED' : 'ORDER_CANCELLED_FOR_EVENT',
          entityType: 'ORDER',
          entityId: order.id,
        },
      });
      released = true;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  if (released) await invalidatePublicDiscoveryCache();
};

const processCancellationBatch = async (eventId: string): Promise<void> => {
  const event = await getPrisma().event.findUnique({ where: { id: eventId } });
  if (!event || event.status !== EventStatus.CANCELLED) return;
  const orders = await getPrisma().order.findMany({
    where: { eventId, status: OrderStatus.PENDING_PAYMENT, reservationReleasedAt: null },
    select: { id: true },
    take: cancellationBatchSize,
    orderBy: { createdAt: 'asc' },
  });
  for (const order of orders) await releasePendingOrder(order.id, OrderStatus.CANCELLED);
  const remaining = await getPrisma().order.count({
    where: { eventId, status: OrderStatus.PENDING_PAYMENT, reservationReleasedAt: null },
  });
  if (remaining > 0)
    throw new RescheduleJob(0, `Cancellation batch has ${remaining} pending orders remaining.`);
};

const completeEvent = async (eventId: string): Promise<void> => {
  const updated = await getPrisma().event.updateMany({
    where: { id: eventId, status: EventStatus.PUBLISHED, endAt: { lte: new Date() } },
    data: { status: EventStatus.COMPLETED, completedAt: new Date() },
  });
  if (updated.count > 0) {
    await getPrisma().auditLog.create({
      data: { action: 'EVENT_COMPLETED', entityType: 'EVENT', entityId: eventId },
    });
    await invalidatePublicDiscoveryCache();
  }
};

const reconcileLater = async (job: Job): Promise<void> => {
  throw new RescheduleJob(
    5 * 60_000,
    `${job.type} is waiting for the provider reconciliation adapter implemented in a later payment/refund part.`,
  );
};

const processJob = async (job: Job): Promise<void> => {
  switch (job.type) {
    case JobType.EXPIRE_ORDER_RESERVATION:
      await releasePendingOrder(jobPayloadId(job, 'orderId'), OrderStatus.EXPIRED);
      return;
    case JobType.PROCESS_EVENT_CANCELLATION:
      await processCancellationBatch(jobPayloadId(job, 'eventId'));
      return;
    case JobType.COMPLETE_EVENT:
      await completeEvent(jobPayloadId(job, 'eventId'));
      return;
    case JobType.RECONCILE_PAYMENT:
    case JobType.RECONCILE_REFUND:
      await reconcileLater(job);
  }
};

const enqueueOnce = async (
  type: JobType,
  deduplicationKey: string,
  payload: Prisma.InputJsonValue,
) => {
  await getPrisma().job.upsert({
    where: { deduplicationKey },
    update: {},
    create: { type, deduplicationKey, payload, runAt: new Date() },
  });
};

export const scheduleMaintenanceJobs = async (): Promise<void> => {
  const database = getPrisma();
  const now = new Date();
  const [expiredOrders, completedEvents, uncertainPayments, uncertainRefunds] = await Promise.all([
    database.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        reservationExpiresAt: { lte: now },
        reservationReleasedAt: null,
      },
      select: { id: true },
      take: 1_000,
    }),
    database.event.findMany({
      where: { status: EventStatus.PUBLISHED, endAt: { lte: now } },
      select: { id: true },
      take: 1_000,
    }),
    database.paymentAttempt.findMany({
      where: { status: 'UNKNOWN' },
      select: { id: true },
      take: 1_000,
    }),
    database.refund.findMany({ where: { status: 'UNKNOWN' }, select: { id: true }, take: 1_000 }),
  ]);
  await Promise.all([
    ...expiredOrders.map((order) =>
      enqueueOnce(JobType.EXPIRE_ORDER_RESERVATION, `expire-order:${order.id}`, {
        orderId: order.id,
      }),
    ),
    ...completedEvents.map((event) =>
      enqueueOnce(JobType.COMPLETE_EVENT, `complete-event:${event.id}`, { eventId: event.id }),
    ),
    ...uncertainPayments.map((payment) =>
      enqueueOnce(JobType.RECONCILE_PAYMENT, `reconcile-payment:${payment.id}`, {
        paymentAttemptId: payment.id,
      }),
    ),
    ...uncertainRefunds.map((refund) =>
      enqueueOnce(JobType.RECONCILE_REFUND, `reconcile-refund:${refund.id}`, {
        refundId: refund.id,
      }),
    ),
  ]);
};

export const runMaintenance = async (
  workerId: string,
  maxJobs = 1_000,
): Promise<{ processed: number; failed: number }> => {
  await getPrisma().$executeRaw(Prisma.sql`
    UPDATE "Job"
    SET "status" = 'FAILED',
        "completedAt" = NOW(),
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = 'Job lease expired after maximum attempts.'
    WHERE "status" = 'RUNNING'
      AND "leaseExpiresAt" <= NOW()
      AND "attempts" >= "maxAttempts"
  `);
  await scheduleMaintenanceJobs();
  let processed = 0;
  let failed = 0;
  while (processed + failed < maxJobs) {
    const job = await claimNextJob(workerId);
    if (!job) break;
    try {
      await processJob(job);
      await finishJob(job, workerId);
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        { err: error, jobId: job.id, jobType: job.type },
        'Maintenance job did not complete',
      );
      await retryOrFailJob(job, workerId, error);
    }
  }
  return { processed, failed };
};
