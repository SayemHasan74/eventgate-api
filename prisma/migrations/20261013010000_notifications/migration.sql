ALTER TYPE "JobType" ADD VALUE 'DELIVER_NOTIFICATION';
ALTER TYPE "JobType" ADD VALUE 'NOTIFY_EVENT_CANCELLATION';
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(6);
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP','EMAIL');
CREATE TYPE "NotificationDeliveryState" AS ENUM ('PENDING','SENDING','SENT','FAILED','UNKNOWN','CANCELLED');
CREATE TABLE "Notification" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "type" VARCHAR(80) NOT NULL, "title" VARCHAR(180) NOT NULL, "body" VARCHAR(1000) NOT NULL,
 "actionPath" VARCHAR(300) NOT NULL, "sourceKey" VARCHAR(255) NOT NULL,
 "readAt" TIMESTAMPTZ(6), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Notification_userId_sourceKey_key" ON "Notification"("userId","sourceKey");
CREATE INDEX "Notification_userId_createdAt_id_idx" ON "Notification"("userId","createdAt","id");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId","readAt");
CREATE TABLE "NotificationPreference" (
 "userId" UUID PRIMARY KEY REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "inAppEnabled" BOOLEAN NOT NULL DEFAULT true, "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
 "bookingUpdates" BOOLEAN NOT NULL DEFAULT true, "savedEventReminders" BOOLEAN NOT NULL DEFAULT true,
 "waitlistAlerts" BOOLEAN NOT NULL DEFAULT true, "marketingEmail" BOOLEAN NOT NULL DEFAULT false,
 "personalizedEmail" BOOLEAN NOT NULL DEFAULT false, "updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE TABLE "EmailVerification" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "email" VARCHAR(320) NOT NULL, "tokenHash" VARCHAR(64) NOT NULL UNIQUE,
 "expiresAt" TIMESTAMPTZ(6) NOT NULL, "consumedAt" TIMESTAMPTZ(6), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "EmailVerification_userId_createdAt_idx" ON "EmailVerification"("userId","createdAt");
CREATE TABLE "NotificationDelivery" (
 "id" UUID PRIMARY KEY, "notificationId" UUID NOT NULL REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "channel" "NotificationChannel" NOT NULL, "state" "NotificationDeliveryState" NOT NULL DEFAULT 'PENDING',
 "providerMessageId" VARCHAR(255), "idempotencyKey" VARCHAR(255) NOT NULL UNIQUE, "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP, "firstAttemptAt" TIMESTAMPTZ(6),
 "leaseToken" UUID, "leaseExpiresAt" TIMESTAMPTZ(6), "error" VARCHAR(160), "recipient" VARCHAR(320), "sender" VARCHAR(320), "baseUrl" VARCHAR(500),
 "verificationId" UUID REFERENCES "EmailVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId","channel");
CREATE INDEX "NotificationDelivery_state_nextAttemptAt_idx" ON "NotificationDelivery"("state","nextAttemptAt");
