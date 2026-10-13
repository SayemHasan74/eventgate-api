ALTER TYPE "JobType" ADD VALUE 'DISPATCH_WAITLIST_ALERTS';
ALTER TYPE "JobType" ADD VALUE 'CLOSE_TIER_WAITLIST';
ALTER TABLE "TicketTier" ADD COLUMN "availabilityWave" INTEGER NOT NULL DEFAULT 0;
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING','NOTIFIED','LEFT','FULFILLED','CLOSED');
CREATE TABLE "WaitlistEntry" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "ticketTierId" UUID NOT NULL REFERENCES "TicketTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING', "generation" INTEGER NOT NULL DEFAULT 0,
 "lastAlertWave" INTEGER, "joinedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lastNotifiedAt" TIMESTAMPTZ(6), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE UNIQUE INDEX "WaitlistEntry_userId_ticketTierId_key" ON "WaitlistEntry"("userId","ticketTierId");
CREATE INDEX "WaitlistEntry_userId_status_createdAt_id_idx" ON "WaitlistEntry"("userId","status","createdAt","id");
CREATE INDEX "WaitlistEntry_ticketTierId_status_joinedAt_id_idx" ON "WaitlistEntry"("ticketTierId","status","joinedAt","id");
