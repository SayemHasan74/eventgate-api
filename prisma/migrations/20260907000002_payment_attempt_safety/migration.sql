CREATE UNIQUE INDEX "PaymentAttempt_one_active_per_order"
  ON "PaymentAttempt" ("orderId")
  WHERE "status" IN ('INITIATING', 'PENDING', 'UNKNOWN');
