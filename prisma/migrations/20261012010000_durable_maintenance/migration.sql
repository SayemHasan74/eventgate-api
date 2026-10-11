ALTER TYPE "JobType" ADD VALUE 'RECONCILE_PAYMENT_EVENT';
ALTER TABLE "Job" ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "failureAttempts" INTEGER NOT NULL DEFAULT 0;
UPDATE "Job" SET "failureAttempts" = "attempts" WHERE "status" IN ('PENDING', 'RUNNING', 'FAILED');
CREATE TABLE "MaintenanceState" (
  "id" VARCHAR(80) PRIMARY KEY,
  "runToken" UUID,
  "lastStartedAt" TIMESTAMPTZ(6),
  "lastCompletedAt" TIMESTAMPTZ(6),
  "heartbeatAt" TIMESTAMPTZ(6),
  "processed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "lastFailureAt" TIMESTAMPTZ(6),
  "lastFailure" VARCHAR(255)
);
