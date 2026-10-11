import { Prisma } from '../generated/prisma/client.js';

// Every overlapping financial/admission operation follows this order. Reads
// before the locks discover identities only; eligibility is re-read afterwards.
export async function lockOrderGraph(tx: Prisma.TransactionClient, orderId: string) {
  const identity = await tx.order.findUnique({
    where: { id: orderId },
    select: { eventId: true, ticketTierId: true },
  });
  if (!identity) return false;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${identity.eventId}::uuid FOR UPDATE`,
  );
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`);
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "TicketTier" WHERE "id" = ${identity.ticketTierId}::uuid FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "Ticket" WHERE "orderId" = ${orderId}::uuid ORDER BY "id" FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "PaymentAttempt" WHERE "orderId" = ${orderId}::uuid ORDER BY "id" FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "Refund" WHERE "orderId" = ${orderId}::uuid ORDER BY "id" FOR UPDATE`,
  );
  return true;
}
