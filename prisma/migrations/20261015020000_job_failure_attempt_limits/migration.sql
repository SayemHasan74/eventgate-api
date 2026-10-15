-- Total claims include healthy reschedules and recurring reconciliation passes.
-- Only actual failures exhaust a job's retry budget.
ALTER TABLE "Job" DROP CONSTRAINT "Job_attempt_limits";
ALTER TABLE "Job" ADD CONSTRAINT "Job_attempt_limits" CHECK (
  "attempts" >= 0
  AND "maxAttempts" > 0
  AND "failureAttempts" >= 0
  AND "failureAttempts" <= "maxAttempts"
);
