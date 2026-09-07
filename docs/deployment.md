# Deployment

## Current verification status

The EventGate web service is live at https://eventgate-api.onrender.com. It uses Neon PostgreSQL and Upstash Redis, and Render health checks return `200` from `GET /api/v1/health/ready`.

The committed [`render.yaml`](../render.yaml) still describes both the web service and maintenance cron job. Render required billing information to create the cron job, so only the free web service was deployed manually. Google OAuth is configured; SSLCommerz sandbox checkout still needs a real transaction verification.

## Render setup

1. Create a PostgreSQL database and Redis instance. Use private connection URLs where the services share a Render private network.
2. Create a Render web service from this repository, or use the Blueprint when a paid cron job is acceptable.
3. Set the service environment variables, including `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`, and a specific `CORS_ORIGINS` value.
4. Use `npm ci --include=dev && npm run db:generate && npm run build` as the build command. The explicit `--include=dev` lets TypeScript build with `NODE_ENV=production`.
5. Use `npm run start` as the start command and `/api/v1/health/ready` as the health-check path.
6. Before enabling public traffic, apply migrations from a trusted deployment environment with `npm run db:migrate` and create the demo accounts with the configured seed variables and `npm run db:seed`.
7. Update the SSLCommerz callback URLs and Google OAuth settings only after the Render URL is known.

Render probes `GET /api/v1/health/ready`. That endpoint runs a database query and returns `503` if the database cannot be reached, so the web service should not be considered ready until its database configuration is valid. `GET /api/v1/health/live` only confirms that the HTTP process is running.

Render documents `healthCheckPath` for web-service HTTP health checks and recommends operation-critical checks such as a simple database query. See [Render health checks](https://render.com/docs/health-checks) and the [Blueprint specification](https://render.com/docs/blueprint-spec).

## Production follow-up

The deployed web API, database readiness, public discovery endpoint, and Google client configuration are verified. The Render cron job remains undeployed because of the paid-plan requirement, and the SSLCommerz sandbox flow still needs a real transaction test.
