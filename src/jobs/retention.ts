import { getPrisma } from '../lib/prisma.js';

// Retain a month of expired request/session records for incident diagnosis.
// A family remains intact while any token in it is still valid.
export async function cleanExpiredOperationalRecords() {
  const database = getPrisma();
  const sessions = await database.$executeRaw`
    DELETE FROM "RefreshSession" WHERE "id" IN (
      SELECT old."id" FROM "RefreshSession" old
      WHERE old."expiresAt" < NOW() - INTERVAL '30 days'
        AND NOT EXISTS (SELECT 1 FROM "RefreshSession" live
          WHERE live."familyId" = old."familyId" AND live."expiresAt" >= NOW())
      ORDER BY old."expiresAt" LIMIT 1000
    )`;
  const idempotency = await database.$executeRaw`
    DELETE FROM "IdempotencyRecord" WHERE "id" IN (
      SELECT "id" FROM "IdempotencyRecord"
      WHERE "expiresAt" < NOW() - INTERVAL '30 days'
      ORDER BY "expiresAt" LIMIT 1000
    )`;
  return { sessions, idempotency };
}
