import { activeAdmissionSql } from '../tickets/ticket-admission.js';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { dateRange } from '../../shared/responses/read-contracts.js';
import type { EventReportOrdersQuery, EventReportQuery } from './reports.schemas.js';

type Actor = { id: string; role: UserRole };
export async function reportAccess(actor: Actor, eventId: string) {
  const event = await getPrisma().event.findUnique({
    where: { id: eventId },
    select: { id: true, organizerId: true },
  });
  if (!event || (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id))
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Event not found.' });
}
export function reportOrderWhere(eventId: string, query: EventReportQuery): Prisma.OrderWhereInput {
  return {
    eventId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.tierId ? { ticketTierId: query.tierId } : {}),
  };
}
const sqlOrderScope = (eventId: string | undefined, query: EventReportQuery) => Prisma.sql`
  ${eventId ? Prisma.sql`o."eventId" = ${eventId}::uuid` : Prisma.sql`TRUE`}
  ${query.status ? Prisma.sql`AND o."status"::text = ${query.status}` : Prisma.empty}
  ${query.tierId ? Prisma.sql`AND o."ticketTierId" = ${query.tierId}::uuid` : Prisma.empty}`;
const sqlDates = (column: Prisma.Sql, query: EventReportQuery) => Prisma.sql`
  ${query.startAfter ? Prisma.sql`AND ${column} >= ${query.startAfter}` : Prisma.empty}
  ${query.startBefore ? Prisma.sql`AND ${column} < ${query.startBefore}` : Prisma.empty}`;
// One row per canonical purchase. Refunds are aggregated before joining, so
// neither multiple refund records nor additional captured attempts multiply sales.
export const canonicalSalesSql = (
  eventId: string | undefined,
  query: EventReportQuery,
) => Prisma.sql`
  SELECT o."id", o."paidAt", o."totalAmountPaisaSnapshot" AS gross,
    COALESCE(r.confirmed, 0)::bigint AS refunded,
    COALESCE(r.pending, 0)::bigint AS pending
  FROM "Order" o JOIN "PaymentAttempt" p ON p."id" = o."fulfilledPaymentAttemptId"
  LEFT JOIN LATERAL (
    SELECT SUM("amountPaisa") FILTER (WHERE "status" = 'SUCCEEDED') AS confirmed,
      SUM("amountPaisa") FILTER (WHERE "status" IN ('REQUESTED','APPROVED','PROCESSING','UNKNOWN')
        OR ("status" = 'FAILED' AND "needsInvestigation")) AS pending
    FROM "Refund" WHERE "paymentAttemptId" = p."id"
  ) r ON TRUE
  WHERE ${sqlOrderScope(eventId, query)} AND o."paidAt" IS NOT NULL
    AND p."status" = 'SUCCEEDED' AND p."providerTransactionId" IS NOT NULL
    AND p."replayOfAttemptId" IS NULL ${sqlDates(Prisma.sql`o."paidAt"`, query)}`;

function safeNumber(value: bigint | number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new AppError({
      statusCode: 503,
      code: 'REPORT_RANGE_ERROR',
      message: 'Report totals exceed the supported numeric range.',
    });
  return number;
}
type Totals = {
  gross: bigint;
  refunded: bigint;
  pending: bigint;
  purchases: bigint;
  excess: bigint;
  excessRefunds: bigint;
  ambiguous: bigint;
};
export async function eventSales(actor: Actor, eventId: string, query: EventReportQuery) {
  await reportAccess(actor, eventId);
  const canonical = canonicalSalesSql(eventId, query);
  const [totals, days] = await getPrisma().$transaction(
    async (tx) => {
      const totals = await tx.$queryRaw<Totals[]>(Prisma.sql`
      WITH canonical AS (${canonical}), excess AS (
        SELECT p."id", p."amountPaisa", COALESCE(r.refunded, 0)::bigint AS refunded
        FROM "PaymentAttempt" p JOIN "Order" o ON o."id" = p."orderId"
        LEFT JOIN LATERAL (SELECT SUM("amountPaisa") AS refunded FROM "Refund"
          WHERE "paymentAttemptId" = p."id" AND "status" = 'SUCCEEDED') r ON TRUE
        WHERE ${sqlOrderScope(eventId, query)} AND p."status" = 'SUCCEEDED'
          AND p."providerTransactionId" IS NOT NULL AND p."replayOfAttemptId" IS NULL
          AND p."id" IS DISTINCT FROM o."fulfilledPaymentAttemptId"
          AND NOT (o."fulfilledPaymentAttemptId" IS NULL AND (o."paidAt" IS NOT NULL OR o."status" IN ('PAID','REFUNDED')))
          ${sqlDates(Prisma.sql`p."completedAt"`, query)}
      ) SELECT COALESCE(SUM(gross),0)::bigint AS gross, COALESCE(SUM(refunded),0)::bigint AS refunded,
        COALESCE(SUM(pending),0)::bigint AS pending, COUNT(*)::bigint AS purchases,
        (SELECT COALESCE(SUM("amountPaisa"),0)::bigint FROM excess) AS excess,
        (SELECT COALESCE(SUM(refunded),0)::bigint FROM excess) AS "excessRefunds",
        (SELECT COUNT(*) FROM "Order" o WHERE ${sqlOrderScope(eventId, query)}
          AND (o."paidAt" IS NOT NULL OR o."status" IN ('PAID','REFUNDED'))
          AND (o."fulfilledPaymentAttemptId" IS NULL OR o."paidAt" IS NULL) ${sqlDates(Prisma.sql`o."paidAt"`, query)})::bigint AS ambiguous
      FROM canonical`);
      const days = await tx.$queryRaw<
        Array<{ day: string; gross: bigint; refunded: bigint; purchases: bigint }>
      >(Prisma.sql`
      WITH canonical AS (${canonical}) SELECT TO_CHAR("paidAt" AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD') AS day,
        SUM(gross)::bigint AS gross, SUM(refunded)::bigint AS refunded, COUNT(*)::bigint AS purchases
      FROM canonical GROUP BY day ORDER BY day`);
      return [totals, days] as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const total = totals[0]!;
  return {
    grossTicketSalesPaisa: safeNumber(total.gross),
    bookingRefundsPaisa: safeNumber(total.refunded),
    netTicketSalesPaisa: safeNumber(total.gross - total.refunded),
    pendingBookingRefundsPaisa: safeNumber(total.pending),
    fulfilledPurchaseCount: safeNumber(total.purchases),
    excessCapturesPaisa: safeNumber(total.excess),
    excessCaptureRefundsPaisa: safeNumber(total.excessRefunds),
    ambiguousPurchaseCount: safeNumber(total.ambiguous),
    salesByDay: days.map((row) => ({
      day: row.day,
      grossPaisa: safeNumber(row.gross),
      bookingRefundsPaisa: safeNumber(row.refunded),
      netPaisa: safeNumber(row.gross - row.refunded),
      purchases: safeNumber(row.purchases),
    })),
    serverTime: new Date(),
  };
}

export async function eventInventory(actor: Actor, eventId: string, query: EventReportQuery) {
  await reportAccess(actor, eventId);
  const tiers = await getPrisma().ticketTier.findMany({
    where: {
      eventId,
      ...(query.tierId ? { id: query.tierId } : {}),
      OR: [{ deletedAt: null }, { orders: { some: {} } }],
    },
    select: {
      id: true,
      name: true,
      deletedAt: true,
      capacity: true,
      soldQuantity: true,
      reservedQuantity: true,
      _count: { select: { tickets: true, orders: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const rows = tiers.map(({ _count, ...tier }) => ({
    ...tier,
    currentCapacity: tier.deletedAt ? 0 : tier.capacity,
    currentSold: tier.deletedAt ? 0 : tier.soldQuantity,
    currentReserved: tier.deletedAt ? 0 : tier.reservedQuantity,
    currentAvailable: tier.deletedAt
      ? 0
      : Math.max(0, tier.capacity - tier.soldQuantity - tier.reservedQuantity),
    historicalIssuedPasses: _count.tickets,
    historicalOrderCount: _count.orders,
  }));
  const summary = { currentCapacity: 0, currentSold: 0, currentReserved: 0, currentAvailable: 0 };
  for (const key of Object.keys(summary) as Array<keyof typeof summary>)
    summary[key] = safeNumber(rows.reduce((total, tier) => total + BigInt(tier[key]), 0n));
  return { tiers: rows, summary, serverTime: new Date() };
}

export async function eventAttendance(actor: Actor, eventId: string, query: EventReportQuery) {
  await reportAccess(actor, eventId);
  // Compare refund identity in SQL: an excess-capture refund must not invalidate the canonical passes.
  const [row] = await getPrisma().$queryRaw<
    Array<{ issued: bigint; checkedIn: bigint; valid: bigint }>
  >(Prisma.sql`
    SELECT COUNT(*)::bigint AS issued,
      COUNT(*) FILTER (WHERE t."checkedInAt" IS NOT NULL ${sqlDates(Prisma.sql`t."checkedInAt"`, query)})::bigint AS "checkedIn",
      COUNT(*) FILTER (WHERE ${activeAdmissionSql(new Date())})::bigint AS valid
    FROM "Ticket" t JOIN "Order" o ON o."id" = t."orderId" JOIN "Event" e ON e."id" = t."eventId"
      LEFT JOIN "PaymentAttempt" p ON p."id" = o."fulfilledPaymentAttemptId"
    WHERE ${sqlOrderScope(eventId, query)}`);
  return {
    historicalIssuedPasses: safeNumber(row!.issued),
    checkedInPasses: safeNumber(row!.checkedIn),
    validUnusedPasses: safeNumber(row!.valid),
    serverTime: new Date(),
  };
}

const orderSelect = {
  id: true,
  quantity: true,
  totalAmountPaisaSnapshot: true,
  currency: true,
  status: true,
  createdAt: true,
  paidAt: true,
  refundedAt: true,
  ticketTierNameSnapshot: true,
  attendee: { select: { displayName: true, email: true } },
  ticketTier: { select: { name: true } },
} satisfies Prisma.OrderSelect;
function ledgerWhere(eventId: string, query: EventReportOrdersQuery): Prisma.OrderWhereInput {
  return {
    ...reportOrderWhere(eventId, query),
    ...(query.startAfter || query.startBefore ? { createdAt: dateRange(query) } : {}),
    ...(query.search
      ? {
          OR: [
            { attendee: { displayName: { contains: query.search, mode: 'insensitive' } } },
            { attendee: { email: { contains: query.search, mode: 'insensitive' } } },
            { ticketTierNameSnapshot: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}
export async function filteredEventOrders(
  actor: Actor,
  eventId: string,
  query: EventReportOrdersQuery,
) {
  await reportAccess(actor, eventId);
  const database = getPrisma();
  const where = ledgerWhere(eventId, query);
  const [orders, total] = await database.$transaction([
    database.order.findMany({
      where,
      select: orderSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.order.count({ where }),
  ]);
  return { orders, total };
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  const first = [...text].find(
    (character) => character.charCodeAt(0) > 31 && !/\s/.test(character),
  );
  if (/^[=+@-]$/.test(first ?? '') || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export async function* eventOrderCsv(
  actor: Actor,
  eventId: string,
  query: EventReportOrdersQuery,
  signal: AbortSignal,
) {
  await reportAccess(actor, eventId);
  const database = getPrisma();
  const cutoff = new Date();
  const where = { AND: [ledgerWhere(eventId, query), { createdAt: { lte: cutoff } }] };
  yield '\uFEFFOrder ID,Attendee,Email,Tier,Quantity,Total BDT,Status,Reserved UTC,Paid UTC,Refunded UTC\r\n';
  let cursor: string | undefined;
  while (!signal.aborted) {
    // Recheck event ownership between batches of a long export.
    await reportAccess(actor, eventId);
    const orders = await database.order.findMany({
      where,
      select: orderSelect,
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!orders.length || signal.aborted) return;
    yield orders
      .map((order) =>
        [
          order.id,
          order.attendee.displayName,
          order.attendee.email,
          order.ticketTierNameSnapshot,
          order.quantity,
          (order.totalAmountPaisaSnapshot / 100).toFixed(2),
          order.status,
          order.createdAt.toISOString(),
          order.paidAt?.toISOString(),
          order.refundedAt?.toISOString(),
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\r\n') + '\r\n';
    cursor = orders.at(-1)!.id;
    if (orders.length < 500) return;
  }
}
