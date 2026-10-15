import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { assertSafeTestDatabaseUrl } from '../test-database-safety.js';

export const cleanDatabase = async (database: PrismaClient): Promise<void> => {
  assertSafeTestDatabaseUrl();
  await database.auditLog.deleteMany();
  await database.idempotencyRecord.deleteMany();
  await database.notificationDelivery.deleteMany();
  await database.notification.deleteMany();
  await database.emailVerification.deleteMany();
  await database.passwordReset.deleteMany();
  await database.notificationPreference.deleteMany();
  await database.savedEvent.deleteMany();
  await database.waitlistEntry.deleteMany();
  await database.ticket.deleteMany();
  await database.refundActivity.deleteMany();
  await database.refund.deleteMany();
  await database.paymentEvent.deleteMany();
  await database.order.updateMany({ data: { fulfilledPaymentAttemptId: null } });
  await database.paymentAttempt.updateMany({ data: { replayOfAttemptId: null } });
  await database.paymentAttempt.deleteMany();
  await database.order.deleteMany();
  await database.ticketTier.deleteMany();
  await database.job.deleteMany();
  await database.event.deleteMany();
  await database.authIdentity.deleteMany();
  await database.refreshSession.deleteMany();
  await database.user.deleteMany();
};
