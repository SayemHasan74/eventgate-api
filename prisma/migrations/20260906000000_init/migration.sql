-- EventGate initial schema. Generated from prisma/schema.prisma and extended
-- with PostgreSQL constraints that Prisma Schema Language cannot represent.

CREATE TYPE "UserRole" AS ENUM ('ATTENDEE', 'ORGANIZER', 'ADMIN');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE');
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');
CREATE TYPE "PaymentProvider" AS ENUM ('SSLCOMMERZ');
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATING', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN');
CREATE TYPE "TicketStatus" AS ENUM ('ACTIVE', 'CHECKED_IN', 'VOIDED', 'REFUNDED');
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'REJECTED', 'FAILED', 'UNKNOWN');
CREATE TYPE "RefundReason" AS ENUM ('ATTENDEE_REQUEST', 'EVENT_CANCELLATION', 'LATE_PAYMENT', 'DUPLICATE_PAYMENT', 'ADMIN_ACTION');
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "JobType" AS ENUM ('EXPIRE_ORDER_RESERVATION', 'RECONCILE_PAYMENT', 'RECONCILE_REFUND', 'PROCESS_EVENT_CANCELLATION', 'COMPLETE_EVENT');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "User" (
  "id" UUID NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "passwordHash" VARCHAR(255),
  "role" "UserRole" NOT NULL DEFAULT 'ATTENDEE',
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "User_email_normalized" CHECK ("email" = lower("email"))
);

CREATE TABLE "AuthIdentity" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "AuthProvider" NOT NULL,
  "providerSubject" VARCHAR(255) NOT NULL,
  "providerEmail" VARCHAR(320),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefreshSession" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "familyId" UUID NOT NULL,
  "tokenHash" VARCHAR(255) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "replacedBySessionId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "id" UUID NOT NULL,
  "organizerId" UUID NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "slug" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL,
  "category" VARCHAR(80) NOT NULL,
  "venue" VARCHAR(160) NOT NULL,
  "city" VARCHAR(100) NOT NULL,
  "address" TEXT NOT NULL,
  "startAt" TIMESTAMPTZ(6) NOT NULL,
  "endAt" TIMESTAMPTZ(6) NOT NULL,
  "imageUrl" TEXT,
  "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Event_end_after_start" CHECK ("endAt" > "startAt")
);

CREATE TABLE "TicketTier" (
  "id" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "pricePaisa" INTEGER NOT NULL,
  "capacity" INTEGER NOT NULL,
  "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
  "soldQuantity" INTEGER NOT NULL DEFAULT 0,
  "salesStartAt" TIMESTAMPTZ(6) NOT NULL,
  "salesEndAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TicketTier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketTier_inventory_non_negative" CHECK (
    "pricePaisa" >= 0 AND "capacity" >= 0 AND "reservedQuantity" >= 0 AND "soldQuantity" >= 0
  ),
  CONSTRAINT "TicketTier_inventory_within_capacity" CHECK ("reservedQuantity" + "soldQuantity" <= "capacity"),
  CONSTRAINT "TicketTier_sales_window" CHECK ("salesEndAt" > "salesStartAt")
);

CREATE TABLE "Order" (
  "id" UUID NOT NULL,
  "attendeeId" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "ticketTierId" UUID NOT NULL,
  "eventNameSnapshot" VARCHAR(180) NOT NULL,
  "ticketTierNameSnapshot" VARCHAR(100) NOT NULL,
  "unitPricePaisaSnapshot" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "totalAmountPaisaSnapshot" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "reservationExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "reservationReleasedAt" TIMESTAMPTZ(6),
  "paidAt" TIMESTAMPTZ(6),
  "refundedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Order_quantity_range" CHECK ("quantity" BETWEEN 1 AND 10),
  CONSTRAINT "Order_currency_bdt" CHECK ("currency" = 'BDT'),
  CONSTRAINT "Order_amount_snapshot" CHECK (
    "unitPricePaisaSnapshot" >= 0 AND "totalAmountPaisaSnapshot" = "unitPricePaisaSnapshot" * "quantity"
  )
);

CREATE TABLE "PaymentAttempt" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "provider" "PaymentProvider" NOT NULL DEFAULT 'SSLCOMMERZ',
  "merchantTransactionId" VARCHAR(100) NOT NULL,
  "providerSessionKey" VARCHAR(255),
  "providerTransactionId" VARCHAR(255),
  "providerValidationId" VARCHAR(255),
  "amountPaisa" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
  "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATING',
  "initiatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(120),
  "failureMessage" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_amount_bdt" CHECK ("amountPaisa" > 0 AND "currency" = 'BDT'),
  CONSTRAINT "PaymentAttempt_sequence_positive" CHECK ("sequence" > 0)
);

CREATE TABLE "PaymentEvent" (
  "id" UUID NOT NULL,
  "paymentAttemptId" UUID,
  "provider" "PaymentProvider" NOT NULL DEFAULT 'SSLCOMMERZ',
  "providerEventKey" VARCHAR(255) NOT NULL,
  "eventType" VARCHAR(80) NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(6),
  "processingError" TEXT,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ticket" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "ticketTierId" UUID NOT NULL,
  "attendeeId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "qrToken" VARCHAR(128) NOT NULL,
  "status" "TicketStatus" NOT NULL DEFAULT 'ACTIVE',
  "checkedInAt" TIMESTAMPTZ(6),
  "checkedInById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Ticket_sequence_positive" CHECK ("sequence" > 0),
  CONSTRAINT "Ticket_check_in_state" CHECK (
    ("status" = 'CHECKED_IN' AND "checkedInAt" IS NOT NULL AND "checkedInById" IS NOT NULL)
    OR
    ("status" <> 'CHECKED_IN' AND "checkedInAt" IS NULL AND "checkedInById" IS NULL)
  )
);

CREATE TABLE "Refund" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "paymentAttemptId" UUID,
  "requestedById" UUID,
  "reviewedById" UUID,
  "reason" "RefundReason" NOT NULL,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "providerRefundId" VARCHAR(255),
  "amountPaisa" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
  "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMPTZ(6),
  "processedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(120),
  "failureMessage" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Refund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Refund_amount_bdt" CHECK ("amountPaisa" > 0 AND "currency" = 'BDT')
);

CREATE TABLE "AuditLog" (
  "id" UUID NOT NULL,
  "actorId" UUID,
  "action" VARCHAR(160) NOT NULL,
  "entityType" VARCHAR(80) NOT NULL,
  "entityId" UUID NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdempotencyRecord" (
  "id" UUID NOT NULL,
  "userId" UUID,
  "scope" VARCHAR(120) NOT NULL,
  "key" VARCHAR(255) NOT NULL,
  "requestHash" VARCHAR(128) NOT NULL,
  "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "resourceId" UUID,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
  "id" UUID NOT NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "deduplicationKey" VARCHAR(255) NOT NULL,
  "payload" JSONB NOT NULL,
  "runAt" TIMESTAMPTZ(6) NOT NULL,
  "lockedAt" TIMESTAMPTZ(6),
  "lockedBy" VARCHAR(120),
  "leaseExpiresAt" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 10,
  "lastError" TEXT,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Job_attempt_limits" CHECK ("attempts" >= 0 AND "maxAttempts" > 0 AND "attempts" <= "maxAttempts")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");
CREATE INDEX "User_status_deletedAt_idx" ON "User"("status", "deletedAt");
CREATE UNIQUE INDEX "AuthIdentity_provider_providerSubject_key" ON "AuthIdentity"("provider", "providerSubject");
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");
CREATE INDEX "RefreshSession_userId_familyId_idx" ON "RefreshSession"("userId", "familyId");
CREATE INDEX "RefreshSession_expiresAt_idx" ON "RefreshSession"("expiresAt");
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
CREATE INDEX "Event_organizerId_status_deletedAt_idx" ON "Event"("organizerId", "status", "deletedAt");
CREATE INDEX "Event_status_startAt_idx" ON "Event"("status", "startAt");
CREATE INDEX "Event_city_startAt_idx" ON "Event"("city", "startAt");
CREATE INDEX "Event_category_startAt_idx" ON "Event"("category", "startAt");
CREATE UNIQUE INDEX "TicketTier_eventId_name_key" ON "TicketTier"("eventId", "name");
CREATE INDEX "TicketTier_eventId_deletedAt_idx" ON "TicketTier"("eventId", "deletedAt");
CREATE INDEX "TicketTier_eventId_salesStartAt_salesEndAt_idx" ON "TicketTier"("eventId", "salesStartAt", "salesEndAt");
CREATE INDEX "Order_attendeeId_createdAt_idx" ON "Order"("attendeeId", "createdAt");
CREATE INDEX "Order_eventId_status_idx" ON "Order"("eventId", "status");
CREATE INDEX "Order_ticketTierId_status_idx" ON "Order"("ticketTierId", "status");
CREATE INDEX "Order_status_reservationExpiresAt_idx" ON "Order"("status", "reservationExpiresAt");
CREATE UNIQUE INDEX "PaymentAttempt_orderId_sequence_key" ON "PaymentAttempt"("orderId", "sequence");
CREATE UNIQUE INDEX "PaymentAttempt_merchantTransactionId_key" ON "PaymentAttempt"("merchantTransactionId");
CREATE UNIQUE INDEX "PaymentAttempt_providerSessionKey_key" ON "PaymentAttempt"("providerSessionKey");
CREATE UNIQUE INDEX "PaymentAttempt_providerTransactionId_key" ON "PaymentAttempt"("providerTransactionId");
CREATE UNIQUE INDEX "PaymentAttempt_providerValidationId_key" ON "PaymentAttempt"("providerValidationId");
CREATE INDEX "PaymentAttempt_orderId_status_idx" ON "PaymentAttempt"("orderId", "status");
CREATE INDEX "PaymentAttempt_status_initiatedAt_idx" ON "PaymentAttempt"("status", "initiatedAt");
CREATE UNIQUE INDEX "PaymentEvent_providerEventKey_key" ON "PaymentEvent"("providerEventKey");
CREATE INDEX "PaymentEvent_paymentAttemptId_idx" ON "PaymentEvent"("paymentAttemptId");
CREATE INDEX "PaymentEvent_processedAt_idx" ON "PaymentEvent"("processedAt");
CREATE UNIQUE INDEX "Ticket_orderId_sequence_key" ON "Ticket"("orderId", "sequence");
CREATE UNIQUE INDEX "Ticket_qrToken_key" ON "Ticket"("qrToken");
CREATE INDEX "Ticket_eventId_status_idx" ON "Ticket"("eventId", "status");
CREATE INDEX "Ticket_attendeeId_createdAt_idx" ON "Ticket"("attendeeId", "createdAt");
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");
CREATE UNIQUE INDEX "Refund_orderId_reason_key" ON "Refund"("orderId", "reason");
CREATE INDEX "Refund_orderId_status_idx" ON "Refund"("orderId", "status");
CREATE INDEX "Refund_status_requestedAt_idx" ON "Refund"("status", "requestedAt");
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");
CREATE INDEX "IdempotencyRecord_userId_createdAt_idx" ON "IdempotencyRecord"("userId", "createdAt");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
CREATE UNIQUE INDEX "Job_deduplicationKey_key" ON "Job"("deduplicationKey");
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");
CREATE INDEX "Job_leaseExpiresAt_idx" ON "Job"("leaseExpiresAt");

ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketTier" ADD CONSTRAINT "TicketTier_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_ticketTierId_fkey" FOREIGN KEY ("ticketTierId") REFERENCES "TicketTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ticketTierId_fkey" FOREIGN KEY ("ticketTierId") REFERENCES "TicketTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
