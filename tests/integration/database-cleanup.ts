import type { PrismaClient } from '../../src/generated/prisma/client.js';

export const cleanDatabase = async (database: PrismaClient): Promise<void> => {
  await database.auditLog.deleteMany();
  await database.idempotencyRecord.deleteMany();
  await database.ticket.deleteMany();
  await database.refund.deleteMany();
  await database.paymentEvent.deleteMany();
  await database.paymentAttempt.deleteMany();
  await database.order.deleteMany();
  await database.ticketTier.deleteMany();
  await database.job.deleteMany();
  await database.event.deleteMany();
  await database.authIdentity.deleteMany();
  await database.refreshSession.deleteMany();
  await database.user.deleteMany();
};
