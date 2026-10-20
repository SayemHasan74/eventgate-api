import { cleanExpiredOperationalRecords } from './retention.js';
import {
  EventStatus,
  JobStatus,
  JobType,
  OrderStatus,
  Prisma,
  type Job,
} from '../generated/prisma/client.js';
import { getPrisma } from '../lib/prisma.js';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { maintenanceFailureSummary } from './maintenance-diagnostics.js';
import { invalidatePublicDiscoveryCache } from '../modules/public-events/public-events.cache.js';
import {
  reconcilePaymentAttempt,
  processPaymentEvent,
} from '../modules/payments/payments.service.js';
import { reconcileRefund } from '../modules/refunds/refunds.service.js';
import { ensureCaptureRefund } from '../modules/refunds/capture-refund.js';
import { serializableTransaction } from '../lib/transaction.js';
import {
  recordInventoryRelease,
  dispatchWaitlistWave,
  closeTierWaitlist,
  scheduleWaitlistMaintenance,
} from '../modules/waitlists/availability.service.js';
import {
  bootstrapReminderJobs,
  refreshReminderBatch,
  sendEventReminder,
} from '../modules/saved-events/reminders.service.js';
import { lockOrderGraph } from '../lib/financial-locks.js';
import {
  deliverNotification,
  notifyCancellation,
} from '../modules/notifications/notification-delivery.js';

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
  const leaseToken = randomUUID();
  const jobs = await getPrisma().$queryRaw<Job[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id"
      FROM "Job"
      WHERE (("status" = 'PENDING' AND "runAt" <= NOW())
         OR ("status" = 'RUNNING' AND "leaseExpiresAt" <= NOW()))
        AND "failureAttempts" < "maxAttempts"
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job" AS job
    SET "status" = 'RUNNING',
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "leaseToken" = ${leaseToken}::uuid,
        "leaseExpiresAt" = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        "attempts" = job."attempts" + 1
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job.*
  `);
  return jobs[0];
};

const ownedLease = (job: Job, workerId: string) => ({
  id: job.id,
  status: JobStatus.RUNNING,
  lockedBy: workerId,
  leaseToken: job.leaseToken,
  leaseExpiresAt: { gt: new Date() },
});

const finishJob = async (job: Job, workerId: string): Promise<void> => {
  const finished = await getPrisma().job.updateMany({
    where: ownedLease(job, workerId),
    data: {
      status: JobStatus.SUCCEEDED,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      leaseToken: null,
    },
  });
  if (!finished.count) throw new Error('Maintenance lease expired before completion.');
};

const retryOrFailJob = async (job: Job, workerId: string, error: unknown): Promise<void> => {
  const reschedule = error instanceof RescheduleJob;
  const message = reschedule
    ? error.message
    : 'Maintenance work failed; inspect the related payment/refund or configuration.';
  const shouldFail = !reschedule && job.failureAttempts + 1 >= job.maxAttempts;
  await getPrisma().job.updateMany({
    where: ownedLease(job, workerId),
    data: shouldFail
      ? {
          status: JobStatus.FAILED,
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          leaseToken: null,
          failureAttempts: { increment: 1 },
          lastError: message,
        }
      : {
          status: JobStatus.PENDING,
          runAt: new Date(
            Date.now() +
              (reschedule ? error.delayMilliseconds : retryDelayMilliseconds(job.failureAttempts)),
          ),
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          leaseToken: null,
          ...(!reschedule ? { failureAttempts: { increment: 1 }, lastError: message } : {}),
        },
  });
};

const releasePendingOrder = async (orderId: string, status: 'EXPIRED' | 'CANCELLED') => {
  let released = false;
  await serializableTransaction(async (tx) => {
    await lockOrderGraph(tx, orderId);
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
    await recordInventoryRelease(tx, order.ticketTierId, order.quantity);
    await tx.auditLog.create({
      data: {
        action: status === OrderStatus.EXPIRED ? 'ORDER_EXPIRED' : 'ORDER_CANCELLED_FOR_EVENT',
        entityType: 'ORDER',
        entityId: order.id,
      },
    });
    released = true;
  });
  if (released) await invalidatePublicDiscoveryCache();
};

type WorkContext = { stopped: () => boolean; stage?: (value: string) => void };
const processCancellationBatch = async (eventId: string, context: WorkContext): Promise<void> => {
  const event = await getPrisma().event.findUnique({ where: { id: eventId } });
  if (!event || event.status !== EventStatus.CANCELLED) return;
  const orders = await getPrisma().order.findMany({
    where: { eventId, status: OrderStatus.PENDING_PAYMENT, reservationReleasedAt: null },
    select: { id: true },
    take: cancellationBatchSize,
    orderBy: { createdAt: 'asc' },
  });
  for (const order of orders) {
    if (context.stopped())
      throw new RescheduleJob(1000, 'Cancellation dispatch paused at its run budget.');
    await releasePendingOrder(order.id, OrderStatus.CANCELLED);
  }
  // Dispatch by canonical capture, excluding already-dispatched work rather
  // than waiting for the first 100 paid orders to settle financially.
  const pendingCaptures = () =>
    getPrisma().$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT o."id" FROM "Order" o
    WHERE o."eventId" = ${eventId}::uuid AND o."status" = 'PAID'
      AND o."fulfilledPaymentAttemptId" IS NOT NULL AND NOT o."financialReviewRequired"
      AND NOT EXISTS (SELECT 1 FROM "Refund" r
        WHERE r."paymentAttemptId" = o."fulfilledPaymentAttemptId"
          AND r."status" IN ('APPROVED','PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))
    ORDER BY o."id" LIMIT ${cancellationBatchSize}
  `);
  const paidOrders = await pendingCaptures();
  for (const order of paidOrders) {
    if (context.stopped())
      throw new RescheduleJob(1000, 'Cancellation dispatch paused at its run budget.');
    await serializableTransaction(async (tx) => {
      await lockOrderGraph(tx, order.id);
      const current = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { event: true },
      });
      if (
        current.event.status !== 'CANCELLED' ||
        current.status !== 'PAID' ||
        !current.fulfilledPaymentAttemptId
      )
        return null;
      return ensureCaptureRefund(
        tx,
        current.id,
        current.fulfilledPaymentAttemptId,
        'EVENT_CANCELLATION',
        current.totalAmountPaisaSnapshot,
      );
    });
  }
  const remainingPending = await getPrisma().order.count({
    where: { eventId, status: OrderStatus.PENDING_PAYMENT, reservationReleasedAt: null },
  });
  if (remainingPending || (await pendingCaptures()).length)
    throw new RescheduleJob(1000, 'Cancellation dispatch has another batch to process.');
  if (
    await getPrisma().order.count({
      where: {
        eventId,
        status: 'PAID',
        OR: [{ financialReviewRequired: true }, { fulfilledPaymentAttemptId: null }],
      },
    })
  )
    throw new Error(
      'Cancellation includes historical purchases requiring financial investigation.',
    );
};

const completeEvent = async (eventId: string): Promise<void> => {
  const updated = await getPrisma().event.updateManyAndReturn({
    where: { id: eventId, status: EventStatus.PUBLISHED, endAt: { lte: new Date() } },
    data: { status: EventStatus.COMPLETED, completedAt: new Date() },
    select: { slug: true },
  });
  if (updated.length > 0) {
    await getPrisma().auditLog.create({
      data: { action: 'EVENT_COMPLETED', entityType: 'EVENT', entityId: eventId },
    });
    await invalidatePublicDiscoveryCache(true, updated[0]!.slug);
  }
};

const processJob = async (job: Job, context: WorkContext): Promise<void> => {
  switch (job.type) {
    case JobType.DISPATCH_WAITLIST_ALERTS:
      if (!(await dispatchWaitlistWave(job)))
        throw new RescheduleJob(1000, 'Waitlist alerts have another bounded batch.');
      return;
    case JobType.CLOSE_TIER_WAITLIST:
      if (!(await closeTierWaitlist(job)))
        throw new RescheduleJob(1000, 'Waitlist closure has another bounded batch.');
      return;
    case JobType.SEND_EVENT_REMINDER:
      await sendEventReminder(job);
      return;
    case JobType.REFRESH_EVENT_REMINDERS:
      if (!(await refreshReminderBatch(job)))
        throw new RescheduleJob(1000, 'Reminder scheduling has another bounded batch.');
      return;
    case JobType.DELIVER_NOTIFICATION: {
      const result = await deliverNotification(jobPayloadId(job, 'deliveryId'));
      if (
        result &&
        ['PENDING', 'UNKNOWN', 'SENDING'].includes(result.state) &&
        result.nextAttemptAt
      )
        throw new RescheduleJob(
          Math.max(1000, result.nextAttemptAt.getTime() - Date.now()),
          'Email delivery awaits its persisted retry.',
        );
      if (result && ['UNKNOWN', 'FAILED'].includes(result.state))
        throw new Error(
          'Email delivery requires admin review; its provider outcome is not confirmed sent.',
        );
      return;
    }
    case JobType.NOTIFY_EVENT_CANCELLATION:
      if (!(await notifyCancellation(job)))
        throw new RescheduleJob(1000, 'Cancellation notifications have another bounded batch.');
      return;
    case JobType.EXPIRE_ORDER_RESERVATION:
      await releasePendingOrder(jobPayloadId(job, 'orderId'), OrderStatus.EXPIRED);
      return;
    case JobType.PROCESS_EVENT_CANCELLATION:
      await processCancellationBatch(jobPayloadId(job, 'eventId'), context);
      return;
    case JobType.COMPLETE_EVENT:
      await completeEvent(jobPayloadId(job, 'eventId'));
      return;
    case JobType.RECONCILE_PAYMENT:
      await reconcilePaymentAttempt(jobPayloadId(job, 'paymentAttemptId'));
      if (
        await getPrisma().paymentAttempt.count({
          where: {
            id: jobPayloadId(job, 'paymentAttemptId'),
            status: { in: ['INITIATING', 'PENDING', 'UNKNOWN'] },
          },
        })
      )
        throw new RescheduleJob(60000, 'Payment is still awaiting provider confirmation.');
      return;
    case JobType.RECONCILE_PAYMENT_EVENT:
      await processPaymentEvent(jobPayloadId(job, 'paymentEventId'));
      return;
    case JobType.RECONCILE_REFUND:
      await reconcileRefund(jobPayloadId(job, 'refundId'));
      if (
        await getPrisma().refund.count({
          where: {
            id: jobPayloadId(job, 'refundId'),
            status: { in: ['APPROVED', 'PROCESSING', 'UNKNOWN'] },
          },
        })
      )
        throw new RescheduleJob(60000, 'Refund is still awaiting provider confirmation.');
      return;
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
    create: {
      type,
      deduplicationKey,
      payload,
      runAt: new Date(),
      ...(type === JobType.DELIVER_NOTIFICATION ? { maxAttempts: 5 } : {}),
    },
  });
  // Only completed, still-needed reconciliation is eligible for another pass.
  // Never steal a lease, erase failure history, or shorten an existing backoff.
  if (
    [
      JobType.RECONCILE_PAYMENT,
      JobType.RECONCILE_REFUND,
      JobType.RECONCILE_PAYMENT_EVENT,
      JobType.DELIVER_NOTIFICATION,
    ].some((value) => value === type)
  )
    await getPrisma().job.updateMany({
      where: {
        deduplicationKey,
        status: JobStatus.SUCCEEDED,
        completedAt: { lte: new Date(Date.now() - 60000) },
      },
      data: { status: JobStatus.PENDING, runAt: new Date(), completedAt: null },
    });
};

export const scheduleMaintenanceJobs = async (context?: WorkContext): Promise<void> => {
  context?.stage?.('schedule-waitlists');
  await scheduleWaitlistMaintenance(() => !!context?.stopped());
  context?.stage?.('schedule-reminders');
  await bootstrapReminderJobs(() => !!context?.stopped());
  const database = getPrisma();
  // Exclude already scheduled/failed work BEFORE limiting, so old unresolved
  // records cannot starve new payments or later cancellation batches.
  const groups = [
    {
      type: JobType.DELIVER_NOTIFICATION,
      prefix: 'notification-delivery:',
      key: 'deliveryId',
      query: Prisma.sql`SELECT "id" FROM "NotificationDelivery" WHERE "channel" = 'EMAIL' AND (("state" IN ('PENDING','UNKNOWN') AND "nextAttemptAt" <= NOW()) OR ("state" = 'SENDING' AND "leaseExpiresAt" <= NOW()))`,
    },
    {
      type: JobType.EXPIRE_ORDER_RESERVATION,
      prefix: 'expire-order:',
      key: 'orderId',
      query: Prisma.sql`SELECT "id" FROM "Order" WHERE "status" = 'PENDING_PAYMENT' AND "reservationExpiresAt" <= NOW() AND "reservationReleasedAt" IS NULL`,
    },
    {
      type: JobType.COMPLETE_EVENT,
      prefix: 'complete-event:',
      key: 'eventId',
      query: Prisma.sql`SELECT "id" FROM "Event" WHERE "status" = 'PUBLISHED' AND "endAt" <= NOW()`,
    },
    {
      type: JobType.PROCESS_EVENT_CANCELLATION,
      prefix: 'event-cancellation:',
      key: 'eventId',
      query: Prisma.sql`SELECT "id" FROM "Event" WHERE "status" = 'CANCELLED'`,
    },
    {
      type: JobType.RECONCILE_PAYMENT,
      prefix: 'reconcile-payment:',
      key: 'paymentAttemptId',
      query: Prisma.sql`SELECT "id" FROM "PaymentAttempt" WHERE "status" IN ('INITIATING','PENDING','UNKNOWN') AND "initiatedAt" <= NOW() - (${env.PAYMENT_STALE_AFTER_MS} * INTERVAL '1 millisecond')`,
    },
    {
      type: JobType.RECONCILE_REFUND,
      prefix: 'reconcile-refund:',
      key: 'refundId',
      query: Prisma.sql`SELECT "id" FROM "Refund" WHERE "status" IN ('APPROVED','UNKNOWN','PROCESSING')`,
    },
    {
      type: JobType.RECONCILE_PAYMENT_EVENT,
      prefix: 'payment-event:',
      key: 'paymentEventId',
      query: Prisma.sql`SELECT "id" FROM "PaymentEvent" WHERE "processedAt" IS NULL`,
    },
  ];
  for (const group of groups) {
    if (context?.stopped()) return;
    context?.stage?.(`schedule-${group.type}`);
    const recurring = [
      JobType.DELIVER_NOTIFICATION,
      JobType.RECONCILE_PAYMENT,
      JobType.RECONCILE_REFUND,
      JobType.RECONCILE_PAYMENT_EVENT,
    ].some((type) => type === group.type);
    const candidates = await database.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT work."id" FROM (${group.query}) work
      LEFT JOIN "Job" j ON j."deduplicationKey" = ${group.prefix} || work."id"::text
      WHERE j."id" IS NULL OR (${recurring} AND j."status" = 'SUCCEEDED' AND j."completedAt" <= NOW() - INTERVAL '1 minute')
      ORDER BY work."id" LIMIT 100
    `);
    for (const candidate of candidates) {
      if (context?.stopped()) return;
      await enqueueOnce(group.type, `${group.prefix}${candidate.id}`, {
        [group.key]: candidate.id,
      });
    }
  }
};

export const maintenanceStatus = async () => {
  const database = getPrisma();
  const now = new Date();
  const [
    state,
    pending,
    running,
    failed,
    expiredLeases,
    oldest,
    unresolvedPayments,
    investigationRefunds,
  ] = await Promise.all([
    database.maintenanceState.findUnique({
      where: { id: 'embedded-maintenance' },
      select: {
        lastStartedAt: true,
        lastCompletedAt: true,
        heartbeatAt: true,
        processed: true,
        failed: true,
        lastFailureAt: true,
        lastFailure: true,
      },
    }),
    database.job.count({ where: { status: 'PENDING' } }),
    database.job.count({ where: { status: 'RUNNING' } }),
    database.job.count({ where: { status: 'FAILED' } }),
    database.job.count({ where: { status: 'RUNNING', leaseExpiresAt: { lte: now } } }),
    database.job.findFirst({
      where: { status: 'PENDING', runAt: { lte: now } },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    }),
    database.paymentAttempt.count({ where: { status: 'UNKNOWN' } }),
    database.refund.count({ where: { needsInvestigation: true } }),
  ]);
  const backlogAgeSeconds = oldest
    ? Math.max(0, Math.floor((now.getTime() - oldest.runAt.getTime()) / 1000))
    : 0;
  const heartbeatOverdue =
    !state?.heartbeatAt || now.getTime() - state.heartbeatAt.getTime() > 180000;
  return {
    mode: 'embedded',
    intervalSeconds: 60,
    state,
    pending,
    running,
    failed,
    expiredLeases,
    backlogAgeSeconds,
    unresolvedPayments,
    investigationRefunds,
    warnings: [
      ...(heartbeatOverdue ? ['MAINTENANCE_HEARTBEAT_OVERDUE'] : []),
      ...(backlogAgeSeconds > 120 ? ['MAINTENANCE_BACKLOG_OVERDUE'] : []),
      ...(expiredLeases ? ['MAINTENANCE_LEASES_EXPIRED'] : []),
      ...(failed ? ['MAINTENANCE_FAILED_WORK'] : []),
      ...(investigationRefunds ? ['REFUNDS_REQUIRE_INVESTIGATION'] : []),
    ],
    timingNotice:
      'Embedded maintenance runs while this web service is awake. Free-service sleep or restart delays cleanup and reminders; minute-accurate execution is not guaranteed. Financial APIs enforce timestamps independently.',
  };
};

export const runMaintenance = async (
  workerId: string,
  maxJobs = env.MAINTENANCE_MAX_JOBS,
  signal?: AbortSignal,
): Promise<{ processed: number; failed: number }> => {
  const deadline = Date.now() + env.MAINTENANCE_RUN_BUDGET_MS;
  const runToken = randomUUID();
  const stateWhere = { id: 'embedded-maintenance', runToken };
  let processed = 0;
  let failed = 0;
  let completed = false;
  let stage = 'record-start';
  try {
    await getPrisma().maintenanceState.upsert({
      where: { id: stateWhere.id },
      create: { ...stateWhere, lastStartedAt: new Date(), heartbeatAt: new Date() },
      update: {
        runToken,
        lastStartedAt: new Date(),
        heartbeatAt: new Date(),
        processed: 0,
        failed: 0,
      },
    });
    stage = 'clean-expired-operational-records';
    await cleanExpiredOperationalRecords();
    stage = 'recover-expired-leases';
    await getPrisma().$executeRaw(Prisma.sql`
    UPDATE "Job"
    SET "status" = CASE WHEN "failureAttempts" + 1 >= "maxAttempts" THEN 'FAILED'::"JobStatus" ELSE 'PENDING'::"JobStatus" END,
        "completedAt" = CASE WHEN "failureAttempts" + 1 >= "maxAttempts" THEN NOW() ELSE NULL END,
        "failureAttempts" = "failureAttempts" + 1,
        "runAt" = NOW() + INTERVAL '1 minute',
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = 'Job lease expired before completion.'
    WHERE "status" = 'RUNNING'
      AND "leaseExpiresAt" <= NOW()
  `);
    await scheduleMaintenanceJobs({
      stopped: () => !!signal?.aborted || Date.now() >= deadline,
      stage: (value) => {
        stage = value;
      },
    });
    let handled = 0;
    while (
      handled < Math.min(maxJobs, env.MAINTENANCE_MAX_JOBS) &&
      !signal?.aborted &&
      Date.now() < deadline
    ) {
      stage = 'claim-job';
      const job = await claimNextJob(workerId);
      if (!job) break;
      handled++;
      let lostLease = false;
      let renewal: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (renewal) return;
        renewal = (async () => {
          const renewed = await getPrisma().job.updateMany({
            where: ownedLease(job, workerId),
            data: { leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000) },
          });
          if (!renewed.count) lostLease = true;
          await getPrisma().maintenanceState.updateMany({
            where: stateWhere,
            data: { heartbeatAt: new Date(), processed, failed },
          });
        })()
          .catch((error: unknown) => {
            logger.error({ err: error, workerId, jobId: job.id }, 'Maintenance heartbeat failed');
            lostLease = true;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, 20000);
      heartbeat.unref();
      try {
        stage = `process-${job.type}`;
        await processJob(job, {
          stopped: () => lostLease || !!signal?.aborted || Date.now() >= deadline,
        });
        if (lostLease) throw new Error('Maintenance lease ownership lost.');
        await finishJob(job, workerId);
        processed += 1;
      } catch (error) {
        if (!(error instanceof RescheduleJob)) {
          failed += 1;
          logger.error(
            { err: error, workerId, jobId: job.id, jobType: job.type },
            'Maintenance job did not complete',
          );
          await getPrisma().maintenanceState.updateMany({
            where: stateWhere,
            data: {
              lastFailureAt: new Date(),
              lastFailure: maintenanceFailureSummary(stage, error),
            },
          });
        }
        stage = `record-retry-${job.type}`;
        await retryOrFailJob(job, workerId, error);
      } finally {
        clearInterval(heartbeat);
        await renewal;
      }
    }
    completed = true;
    return { processed, failed };
  } catch (error) {
    failed = Math.max(failed, 1);
    logger.error({ err: error, workerId, runToken, stage }, 'Maintenance pass failed');
    await getPrisma()
      .maintenanceState.updateMany({
        where: stateWhere,
        data: {
          lastFailureAt: new Date(),
          lastFailure: maintenanceFailureSummary(stage, error),
        },
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await getPrisma()
      .maintenanceState.updateMany({
        where: stateWhere,
        data: {
          ...(completed ? { lastCompletedAt: new Date() } : {}),
          heartbeatAt: new Date(),
          processed,
          failed,
        },
      })
      .catch((error: unknown) => {
        logger.error({ err: error, workerId, runToken }, 'Maintenance final status update failed');
        if (completed) throw error;
      });
  }
};
