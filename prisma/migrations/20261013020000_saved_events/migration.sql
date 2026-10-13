ALTER TYPE "JobType" ADD VALUE 'SEND_EVENT_REMINDER';
ALTER TYPE "JobType" ADD VALUE 'REFRESH_EVENT_REMINDERS';
ALTER TABLE "Event" ADD COLUMN "reminderVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "SavedEvent" (
  "id" UUID PRIMARY KEY,
  "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "eventId" UUID NOT NULL REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "saleReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
  "eventReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
  "reminderVersion" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "SavedEvent_userId_eventId_key" ON "SavedEvent"("userId", "eventId");
CREATE INDEX "SavedEvent_userId_createdAt_id_idx" ON "SavedEvent"("userId", "createdAt", "id");
CREATE INDEX "SavedEvent_eventId_id_idx" ON "SavedEvent"("eventId", "id");
ALTER TABLE "Notification" ADD COLUMN "reminderJobId" UUID REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Notification_reminderJobId_idx" ON "Notification"("reminderJobId");
CREATE INDEX "Job_payload_eventId_idx" ON "Job" (("payload"->>'eventId'));
