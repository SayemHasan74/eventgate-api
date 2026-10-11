ALTER TABLE "Order" ADD COLUMN "fulfilledPaymentAttemptId" UUID,
  ADD COLUMN "financialReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PaymentAttempt" ADD COLUMN "checkoutUrl" TEXT,
  ADD COLUMN "checkoutExpiresAt" TIMESTAMPTZ(6), ADD COLUMN "replayOfAttemptId" UUID;
ALTER TABLE "PaymentEvent" ADD COLUMN "capturedPaymentAttemptId" UUID;
ALTER TABLE "Refund" ADD COLUMN "userMessage" VARCHAR(1000), ADD COLUMN "reviewerNote" VARCHAR(1000),
  ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "needsInvestigation" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "RefundActivity" (
  "id" UUID NOT NULL, "refundId" UUID NOT NULL, "actorId" UUID,
  "action" VARCHAR(80) NOT NULL, "note" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefundActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RefundActivity_refundId_createdAt_idx" ON "RefundActivity"("refundId", "createdAt");
ALTER TABLE "RefundActivity" ADD CONSTRAINT "RefundActivity_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only verified fulfillment audit evidence identifies the canonical purchase.
-- Never pick the most recent successful attempt (it may be an excess capture).
WITH evidence AS (
  SELECT o."id" AS order_id, MIN(p."id"::text)::uuid AS attempt_id
  FROM "Order" o JOIN "AuditLog" a ON a."entityId" = o."id"
    AND a."action" = 'PAYMENT_VERIFIED_AND_ORDER_FULFILLED'
    AND a."entityType" = 'ORDER'
  JOIN "PaymentAttempt" p ON p."id"::text = a."metadata"->>'paymentAttemptId'
    AND p."orderId" = o."id" AND p."status" = 'SUCCEEDED'
    AND p."providerTransactionId" IS NOT NULL
    AND p."providerTransactionId" = a."metadata"->>'providerTransactionId'
    AND p."amountPaisa" = o."totalAmountPaisaSnapshot" AND p."currency" = o."currency"
  WHERE o."status" IN ('PAID', 'REFUNDED')
  GROUP BY o."id" HAVING COUNT(DISTINCT p."id") = 1
    AND NOT EXISTS (SELECT 1 FROM "AuditLog" x WHERE x."entityId" = o."id"
      AND x."action" = 'PAYMENT_VERIFIED_AND_ORDER_FULFILLED'
      AND (x."metadata"->>'paymentAttemptId' IS DISTINCT FROM MIN(p."id"::text)
        OR x."metadata"->>'providerTransactionId' IS DISTINCT FROM MIN(p."providerTransactionId")))
)
UPDATE "Order" o SET "fulfilledPaymentAttemptId" = e.attempt_id FROM evidence e WHERE o."id" = e.order_id;
UPDATE "Order" SET "financialReviewRequired" = true
  WHERE "status" IN ('PAID', 'REFUNDED') AND "fulfilledPaymentAttemptId" IS NULL;
UPDATE "Refund" r SET "paymentAttemptId" = o."fulfilledPaymentAttemptId"
  FROM "Order" o WHERE r."orderId" = o."id" AND r."paymentAttemptId" IS NULL
    AND o."fulfilledPaymentAttemptId" IS NOT NULL AND NOT o."financialReviewRequired"
    AND r."amountPaisa" = o."totalAmountPaisaSnapshot"
    AND r."reason" IN ('ATTENDEE_REQUEST', 'EVENT_CANCELLATION', 'ADMIN_ACTION');
-- Preserve unsafe historical outcomes as review work, without rewriting money/inventory.
UPDATE "Order" o SET "financialReviewRequired" = true WHERE EXISTS (
  SELECT 1 FROM "Refund" r WHERE r."orderId" = o."id" AND r."status" = 'SUCCEEDED'
    AND r."paymentAttemptId" IS DISTINCT FROM o."fulfilledPaymentAttemptId"
    AND o."status" = 'REFUNDED'
);
UPDATE "Refund" r SET "needsInvestigation" = true WHERE r."paymentAttemptId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "PaymentAttempt" p WHERE p."id" = r."paymentAttemptId"
    AND p."orderId" = r."orderId" AND p."status" = 'SUCCEEDED'
    AND p."providerTransactionId" IS NOT NULL AND p."amountPaisa" = r."amountPaisa"
    AND p."currency" = r."currency"
);
UPDATE "Refund" r SET "needsInvestigation" = true WHERE EXISTS (
  SELECT 1 FROM "Refund" other WHERE other."id" <> r."id" AND other."paymentAttemptId" = r."paymentAttemptId"
    AND other."status" IN ('REQUESTED','APPROVED','PROCESSING','UNKNOWN','SUCCEEDED')
    AND r."status" IN ('REQUESTED','APPROVED','PROCESSING','UNKNOWN','SUCCEEDED')
);
UPDATE "Order" o SET "financialReviewRequired" = true WHERE EXISTS (
  SELECT 1 FROM "Refund" r WHERE r."orderId" = o."id" AND r."needsInvestigation"
);
INSERT INTO "RefundActivity" ("id", "refundId", "action", "note", "createdAt")
  SELECT "id", "id", 'MIGRATED_' || "status"::text,
    'Imported existing refund state. Earlier review activity was not recorded.',
    COALESCE("completedAt", "reviewedAt", "processedAt", "requestedAt") FROM "Refund";
DROP INDEX "Refund_orderId_reason_key";
-- Duplicate legacy reason rows cannot be guessed away: stop migration for manual review.
CREATE UNIQUE INDEX "Refund_paymentAttemptId_reason_key" ON "Refund"("paymentAttemptId", "reason");
CREATE UNIQUE INDEX "Refund_one_live_capture" ON "Refund"("paymentAttemptId")
  WHERE NOT "needsInvestigation" AND "status" IN ('REQUESTED','APPROVED','PROCESSING','UNKNOWN','SUCCEEDED');
CREATE UNIQUE INDEX "Order_fulfilledPaymentAttemptId_key" ON "Order"("fulfilledPaymentAttemptId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_fulfilledPaymentAttemptId_fkey" FOREIGN KEY ("fulfilledPaymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_replayOfAttemptId_fkey" FOREIGN KEY ("replayOfAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_requestCount_bound" CHECK ("requestCount" BETWEEN 1 AND 3);
-- Cancellation invalidates admission without erasing historical check-in evidence.
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_check_in_state";
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_check_in_state" CHECK (
  ("status" IN ('CHECKED_IN','VOIDED','REFUNDED') AND "checkedInAt" IS NOT NULL AND "checkedInById" IS NOT NULL)
  OR ("status" <> 'CHECKED_IN' AND "checkedInAt" IS NULL AND "checkedInById" IS NULL)
);
