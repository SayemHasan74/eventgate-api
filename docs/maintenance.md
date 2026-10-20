# Durable maintenance jobs

Run one maintenance pass with `npm run jobs:run`. By default the API runs the same durable scheduler once a minute in-process (`EMBEDDED_MAINTENANCE=true`), as configured by the web-only `render.yaml`.

For a separate persistent worker, use the same build command and server secrets as the API, start it with `npm run jobs:worker`, and set `DATABASE_POOL_MAX=2` on the worker. Confirm its heartbeat before setting `EMBEDDED_MAINTENANCE=false` on the API. The worker and embedded modes use one shared runner implementation and database leases; enabling the worker during transition does not permit duplicate claims. No worker is provisioned automatically and the embedded default keeps jobs running until one exists. Region and billing changes require deployment-account access.

Jobs live in PostgreSQL. A worker atomically claims one due job with `FOR UPDATE SKIP LOCKED`, records a 60-second lease, and increments its attempt count. Other workers skip the leased job. Completed jobs are marked `SUCCEEDED`; retryable errors are rescheduled with bounded backoff; exhausted leases and failures become visible as `FAILED` records with `lastError`.

The runner schedules and processes expired pending orders, event-cancellation batches, and published events whose end time passed. It also creates durable jobs for uncertain and in-progress payment/refund outcomes. Payment and refund reconciliation use the SSLCommerz adapters; external provider verification still requires configured merchant credentials.

No job claims a provider payment or refund outcome without provider verification. Cancellation batches release pending reservations, block active tickets for paid orders, and create recoverable provider refund work.

`tests/integration/maintenance.integration.test.ts` covers expiry, cancellation, completion, and overlapping worker claims against a real PostgreSQL `TEST_DATABASE_URL`.
