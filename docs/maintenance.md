# Durable maintenance jobs

Run maintenance locally with `npm run jobs:run`. The Render Blueprint declares a cron service that invokes the same command every minute; deployment has not been verified because this workspace has no Render credentials.

Jobs live in PostgreSQL. A worker atomically claims one due job with `FOR UPDATE SKIP LOCKED`, records a 60-second lease, and increments its attempt count. Other workers skip the leased job. Completed jobs are marked `SUCCEEDED`; retryable errors are rescheduled with bounded backoff; exhausted leases and failures become visible as `FAILED` records with `lastError`.

The runner schedules and processes expired pending orders, event-cancellation batches, and published events whose end time passed. It also creates durable jobs for uncertain and in-progress payment/refund outcomes. Payment and refund reconciliation use the SSLCommerz adapters; external provider verification still requires configured merchant credentials.

No job claims a provider payment or refund outcome without provider verification. Cancellation batches release pending reservations, block active tickets for paid orders, and create recoverable provider refund work.

`tests/integration/maintenance.integration.test.ts` covers expiry, cancellation, completion, and overlapping worker claims against a real PostgreSQL `TEST_DATABASE_URL`.
