CREATE TYPE "PaymentEnvironment" AS ENUM ('LIVE', 'DEMO');

ALTER TABLE "User"
ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Event"
ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PaymentAttempt"
ADD COLUMN "paymentEnvironment" "PaymentEnvironment" NOT NULL DEFAULT 'LIVE',
ADD COLUMN "merchantIdentity" VARCHAR(255);

CREATE INDEX "User_isDemo_role_status_idx" ON "User"("isDemo", "role", "status");
CREATE INDEX "Event_isDemo_status_startAt_idx" ON "Event"("isDemo", "status", "startAt");
