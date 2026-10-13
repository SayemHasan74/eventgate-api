import { z } from 'zod';
import { JobType, JobStatus, Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { lockOrderGraph } from '../../lib/financial-locks.js';
import { AppError } from '../../shared/errors/app-error.js';
import { dateFields, dateRange, validDateRange } from '../../shared/responses/read-contracts.js';
import { canonicalSalesSql } from './event-report.service.js';
import { env } from '../../config/env.js';
export const adminReasonSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
export const jobQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    id: z.string().uuid().optional(),
    status: z.nativeEnum(JobStatus).optional(),
    type: z.nativeEnum(JobType).optional(),
    ...dateFields,
  })
  .strict()
  .refine(validDateRange);
const conflict = (message: string) =>
  new AppError({ statusCode: 409, code: 'RECOVERY_NOT_ELIGIBLE', message });
const missing = () =>
  new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Recovery record not found.' });
const references = {
  SEND_EVENT_REMINDER: ['eventId', 'EVENT'],
  REFRESH_EVENT_REMINDERS: ['eventId', 'EVENT'],
  DELIVER_NOTIFICATION: ['deliveryId', 'NOTIFICATION_DELIVERY'],
  NOTIFY_EVENT_CANCELLATION: ['eventId', 'EVENT'],
  EXPIRE_ORDER_RESERVATION: ['orderId', 'ORDER'],
  COMPLETE_EVENT: ['eventId', 'EVENT'],
  PROCESS_EVENT_CANCELLATION: ['eventId', 'EVENT'],
  RECONCILE_PAYMENT: ['paymentAttemptId', 'PAYMENT_ATTEMPT'],
  RECONCILE_REFUND: ['refundId', 'REFUND'],
  RECONCILE_PAYMENT_EVENT: ['paymentEventId', 'PAYMENT_EVENT'],
} as const;
export function safeAuditMetadata(metadata: Prisma.JsonValue) {
  const allowed = [
    'from',
    'to',
    'reason',
    'orderId',
    'eventId',
    'jobId',
    'previousStatus',
    'previousFailureAttempts',
    'totalAttempts',
  ];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(
        ([key, value]) =>
          allowed.includes(key) && ['string', 'number', 'boolean'].includes(typeof value),
      )
      .map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value
              .replace(/https?:\/\/[^\s]+/gi, '[redacted address]')
              .replace(
                /\b(?:password|store_passwd|accessToken|refreshToken|qrToken|idToken|clientSecret)\s*[:=]\s*\S+/gi,
                '[redacted credential]',
              )
              .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
              .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted token]')
              .slice(0, 1000)
          : value,
      ]),
  );
}
export function jobReference(type: JobType, payload: Prisma.JsonValue) {
  const [key, entityType] = references[type];
  const value =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload[key] : null;
  return typeof value === 'string' && z.string().uuid().safeParse(value).success
    ? { entityId: value, entityType }
    : null;
}
export async function adminSummary(panel: string) {
  const db = getPrisma();
  if (panel === 'users') return { count: await db.user.count({ where: { deletedAt: null } }) };
  if (panel === 'events')
    return { count: await db.event.count({ where: { status: 'PUBLISHED', deletedAt: null } }) };
  if (panel === 'refunds')
    return { count: await db.refund.count({ where: { status: 'REQUESTED' } }) };
  if (panel === 'incidents') {
    const [payments, refunds] = await Promise.all([
      db.paymentAttempt.count({
        where: {
          OR: [
            { status: 'UNKNOWN' },
            {
              status: { in: ['INITIATING', 'PENDING'] },
              initiatedAt: { lte: new Date(Date.now() - env.PAYMENT_STALE_AFTER_MS) },
            },
          ],
        },
      }),
      db.refund.count({ where: { OR: [{ status: 'UNKNOWN' }, { needsInvestigation: true }] } }),
    ]);
    return { payments, refunds };
  }
  const [row] = await db.$queryRaw<Array<{ gross: bigint; refunded: bigint }>>(
    Prisma.sql`WITH canonical AS (${canonicalSalesSql(undefined, {})}) SELECT COALESCE(SUM(gross),0)::bigint AS gross,COALESCE(SUM(refunded),0)::bigint AS refunded FROM canonical`,
  );
  const gross = Number(row!.gross),
    refunds = Number(row!.refunded),
    net = gross - refunds;
  if (![gross, refunds, net].every(Number.isSafeInteger))
    throw new AppError({
      statusCode: 503,
      code: 'REPORT_RANGE_ERROR',
      message: 'Financial totals exceed supported range.',
    });
  return { grossTicketSalesPaisa: gross, bookingRefundsPaisa: refunds, netTicketSalesPaisa: net };
}
export async function listRecoveryJobs(query: z.infer<typeof jobQuerySchema>) {
  const db = getPrisma();
  const where = {
    ...(query.id ? { id: query.id } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.startAfter || query.startBefore ? { createdAt: dateRange(query) } : {}),
  };
  const [jobs, total] = await db.$transaction([
    db.job.findMany({
      where,
      select: {
        id: true,
        type: true,
        status: true,
        payload: true,
        runAt: true,
        attempts: true,
        failureAttempts: true,
        maxAttempts: true,
        leaseExpiresAt: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.job.count({ where }),
  ]);
  const safeJobs = jobs.map(({ payload, ...job }) => ({
    ...job,
    reference: jobReference(job.type, payload),
  }));
  const callbackIds = safeJobs
    .filter((job) => job.reference?.entityType === 'PAYMENT_EVENT')
    .map((job) => job.reference!.entityId);
  const callbacks = callbackIds.length
    ? await db.paymentEvent.findMany({
        where: { id: { in: callbackIds } },
        select: { id: true, paymentAttemptId: true },
      })
    : [];
  return {
    jobs: safeJobs.map((job) => {
      const callback = callbacks.find((row) => row.id === job.reference?.entityId);
      return {
        ...job,
        reference: callback?.paymentAttemptId
          ? { entityType: 'PAYMENT_ATTEMPT', entityId: callback.paymentAttemptId }
          : job.reference,
      };
    }),
    total,
  };
}
async function sourceEligible(
  tx: Prisma.TransactionClient,
  type: JobType,
  id: string,
  allowApproved = false,
) {
  if (type === 'DELIVER_NOTIFICATION')
    throw conflict(
      'Email retry limits and provider idempotency are enforced by the delivery worker. Inspect email incidents; do not reset an uncertain delivery.',
    );
  if (type === 'SEND_EVENT_REMINDER' || type === 'REFRESH_EVENT_REMINDERS') {
    const event = await tx.event.findUnique({ where: { id } });
    if (!event || event.deletedAt || event.status !== 'PUBLISHED' || event.startAt <= new Date())
      throw conflict('This reminder source is no longer upcoming and published.');
    return;
  }
  if (type === 'RECONCILE_PAYMENT') {
    const payment = await tx.paymentAttempt.findUnique({ where: { id } });
    if (!payment) throw missing();
    await lockOrderGraph(tx, payment.orderId);
    const current = await tx.paymentAttempt.findUniqueOrThrow({ where: { id } });
    if (!['INITIATING', 'PENDING', 'UNKNOWN'].includes(current.status))
      throw conflict('This payment has a terminal outcome; it cannot be manually reconciled.');
    return;
  }
  if (type === 'RECONCILE_REFUND') {
    const refund = await tx.refund.findUnique({ where: { id } });
    if (!refund) throw missing();
    await lockOrderGraph(tx, refund.orderId);
    const current = await tx.refund.findUniqueOrThrow({ where: { id } });
    if (
      allowApproved &&
      current.status === 'APPROVED' &&
      !current.needsInvestigation &&
      current.paymentAttemptId
    )
      return;
    if (
      !['PROCESSING', 'UNKNOWN'].includes(current.status) ||
      current.needsInvestigation ||
      !current.providerRefundId
    )
      throw conflict(
        'Only uncertain refunds with a confirmed provider reference can be reconciled. Missing-reference/history cases require merchant-portal investigation, not another refund.',
      );
    return;
  }
  if (type === 'RECONCILE_PAYMENT_EVENT') {
    const event = await tx.paymentEvent.findUnique({
      where: { id },
      select: { processedAt: true },
    });
    if (!event || event.processedAt)
      throw conflict('Callback processing is already complete or unavailable.');
    return;
  }
  if (type === 'EXPIRE_ORDER_RESERVATION') {
    await lockOrderGraph(tx, id);
    const order = await tx.order.findUnique({ where: { id } });
    if (
      !order ||
      order.status !== 'PENDING_PAYMENT' ||
      order.reservationReleasedAt ||
      order.reservationExpiresAt > new Date()
    )
      throw conflict('This reservation no longer needs expiry work.');
    return;
  }
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${id}::uuid FOR UPDATE`);
  const event = await tx.event.findUnique({ where: { id } });
  if (
    !event ||
    (type === 'COMPLETE_EVENT'
      ? event.status !== 'PUBLISHED' || event.endAt > new Date()
      : event.status !== 'CANCELLED')
  )
    throw conflict('The event no longer needs this maintenance operation.');
}
export async function scheduleAdminReconciliation(
  actorId: string,
  kind: 'payment' | 'refund',
  id: string,
  reason: string,
) {
  return serializableTransaction(async (tx) => {
    const type = kind === 'payment' ? JobType.RECONCILE_PAYMENT : JobType.RECONCILE_REFUND;
    await sourceEligible(tx, type, id);
    const key = `reconcile-${kind}:${id}`;
    let job = await tx.job.upsert({
      where: { deduplicationKey: key },
      update: {},
      create: {
        type,
        deduplicationKey: key,
        payload: { [kind === 'payment' ? 'paymentAttemptId' : 'refundId']: id },
        runAt: new Date(),
      },
    });
    if (job.status === 'FAILED')
      throw conflict(
        'Recovery job has failed. Inspect and retry that job explicitly in Operations.',
      );
    if (job.status === 'SUCCEEDED') {
      const updated = await tx.job.updateMany({
        where: {
          id: job.id,
          status: 'SUCCEEDED',
          completedAt: { lte: new Date(Date.now() - 60000) },
        },
        data: { status: 'PENDING', runAt: new Date(), completedAt: null },
      });
      if (!updated.count)
        throw conflict(
          'Reconciliation was recently completed. Allow provider state to settle before requesting another pass.',
        );
      job = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'RECONCILIATION_REQUESTED',
        entityType: kind === 'payment' ? 'PAYMENT_ATTEMPT' : 'REFUND',
        entityId: id,
        metadata: { reason, jobId: job.id },
      },
    });
    return { jobId: job.id, status: job.status };
  });
}
export async function retryRecoveryJob(actorId: string, jobId: string, reason: string) {
  return serializableTransaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job) throw missing();
    if (job.status !== 'FAILED' || (job.leaseExpiresAt && job.leaseExpiresAt > new Date()))
      throw conflict(
        'Only failed, unleased jobs can be retried. Pending/running/completed work is not reset.',
      );
    const ref = jobReference(job.type, job.payload);
    if (!ref) throw conflict('Job source is invalid; arbitrary payload execution is forbidden.');
    await sourceEligible(tx, job.type, ref.entityId, true);
    const result = await tx.job.updateMany({
      where: {
        id: jobId,
        status: 'FAILED',
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
      },
      data: {
        status: 'PENDING',
        runAt: new Date(),
        completedAt: null,
        failureAttempts: 0,
        lockedAt: null,
        lockedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (result.count !== 1) throw conflict('Job state changed. Reload Operations before retrying.');
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'MAINTENANCE_JOB_RETRIED',
        entityType: 'JOB',
        entityId: jobId,
        metadata: {
          reason,
          previousFailureAttempts: job.failureAttempts,
          totalAttempts: job.attempts,
        },
      },
    });
    return { jobId, status: 'PENDING' as const };
  });
}
