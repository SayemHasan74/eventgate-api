# API documentation and verification

Open `https://eventgate-api.onrender.com/docs` for the deployed Swagger UI (or `http://localhost:4000/docs` locally). The machine-readable specification is at `GET /openapi.json`. It covers authentication, public discovery, orders, payments, tickets, check-in, refunds, and reports. Common errors are `400` validation, `401` authentication, `403` authorization, `404` not found, and `409` workflow conflict.

Import the [full Postman collection](postman/EventGate.full.postman_collection.json) and [local environment](postman/EventGate.local.postman_environment.json). The full collection covers the deployed health, auth, attendee, organizer, admin, payment, ticket, check-in, and refund flows. The environment contains no credentials; enter only locally issued tokens.

## Verification record

`npm run check` and runnable tests passed on 2026-09-07. Swagger UI and `/openapi.json` were started locally and returned HTTP 200. The repository contains Prisma migrations, a Render Blueprint, readiness checks, and a maintenance cron declaration.

The deployed API, Neon PostgreSQL connection, Upstash Redis connection, Google OAuth client configuration, and public API behavior are verified. A real SSLCommerz sandbox checkout was completed successfully and created a paid order and ticket. A refund request was approved and is currently `PROCESSING`; final provider reconciliation remains pending. The dedicated destructive integration suite and Render cron remain unverified because the suite requires a separate test database and the cron plan requires paid billing.

For a fresh deployment: set every `.env.example` value, apply `npm run db:migrate`, deploy `render.yaml`, verify `/api/v1/health/ready`, configure public HTTPS callback URLs, then test a sandbox purchase and refund before enabling live payments.
