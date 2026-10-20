# Deployment

## Current source verification (2026-10-20)

The performance changes have been tested locally against disposable PostgreSQL and Redis instances. This does not establish that the deployed services contain these changes. Deploy the backend first: the frontend now uses lightweight notification-count and check-in-status endpoints. Production start still applies migrations before serving requests.

`render.yaml` describes the API web service. `EMBEDDED_MAINTENANCE=true` keeps maintenance running there by default; see [maintenance](maintenance.md) for a dedicated worker transition. An always-on API, Singapore placement for API/Redis/database, and worker provisioning must be verified in the relevant hosting accounts. The frontend `vercel.json` selects Singapore (`sin1`) for its next deployment.

The new migration adds a check-in history index and partial trigram search indexes (`pg_trgm`). It was applied successfully to a disposable PostgreSQL instance. Index creation takes locks while building; schedule production rollout appropriately for the actual dataset. No production migration or hosting change was performed by the local checks.

## Render setup

1. Create a PostgreSQL database and Redis instance. Use private connection URLs where the services share a Render private network.
2. Create a Render web service from this repository, or use the web-service Blueprint.
3. Set the service environment variables, including `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`, and a specific `CORS_ORIGINS` value.
4. Use `npm ci --include=dev && npm run db:generate && npm run build` as the build command. The explicit `--include=dev` lets TypeScript build with `NODE_ENV=production`.
5. Use `npm run start` as the start command and `/api/v1/health/ready` as the health-check path.
6. Confirm startup logs show `prisma migrate deploy` completed before the service became ready. Create demo accounts only through the intended seed configuration in an appropriate environment; never seed production destructively.
7. Update the SSLCommerz callback URLs and Google OAuth settings only after the Render URL is known.

Render probes `GET /api/v1/health/ready`. That endpoint runs a database query and returns `503` if the database cannot be reached, so the web service should not be considered ready until its database configuration is valid. `GET /api/v1/health/live` only confirms that the HTTP process is running.

Render documents `healthCheckPath` for web-service HTTP health checks and recommends operation-critical checks such as a simple database query. See [Render health checks](https://render.com/docs/health-checks) and the [Blueprint specification](https://render.com/docs/blueprint-spec).

## Production follow-up

The deployed web API, database readiness, public discovery endpoint, and Google client configuration are verified. The Render cron job remains undeployed because of the paid-plan requirement, and the SSLCommerz sandbox flow still needs a real transaction test.
