# API documentation and verification

Open `https://eventgate-api.onrender.com/docs/` for Swagger UI (or `http://localhost:4000/docs/` locally). The machine-readable specification is at `GET /openapi.json`. It covers authentication, public discovery, attendee preferences/recommendations, orders, payments, tickets, check-in, refunds, and reports. Common responses include `400` validation, `401` authentication, `403` authorization, `404` not found, `409` workflow conflict, `429` rate limit, and `503` unavailable dependencies where the route defines it.

Import the [full Postman collection](postman/EventGate.full.postman_collection.json) and [local environment](postman/EventGate.local.postman_environment.json). The full collection covers the deployed health, auth, attendee, organizer, admin, payment, ticket, check-in, and refund flows. The environment contains no credentials; enter only locally issued tokens.

## Verification record

Part 24 checks and their dates are recorded in `acceptance-checklist.md`. On 2026-10-14 the repository's pushed source SHA was `9a5f0bd9997e8237ac787ced485a86090362a990`. A live readiness request returned HTTP 200 once; subsequent docs/OpenAPI requests returned HTTP 503, so a stable deployed revision and docs availability are not confirmed. Do not present the earlier September prose below as current evidence.

The test suite distinguishes unit/provider-adapter tests from PostgreSQL integration tests. Integration tests require `TEST_DATABASE_URL` pointing at the separate `eventgate_test` database; when unavailable, Vitest reports them skipped. A successful source test run does not establish a real Google login, SSLCommerz settlement/refund, or hosted account-flow result.

Render's configured start command runs `prisma migrate deploy` before starting the API. Verify the deployed commit, migration startup logs, `/api/v1/health/ready`, and `/openapi.json` after deployment. Never run `migrate dev` or reset against production. Complete a real sandbox purchase and provider-confirmed refund before claiming those provider outcomes.
