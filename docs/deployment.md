# Deployment

## Current verification status

The Render Blueprint is committed in [`render.yaml`](../render.yaml), but no Render account, PostgreSQL service, Redis service, custom domain, Google OAuth credentials, or SSLCommerz merchant credentials have been provided. A live deployment has therefore **not** been created or verified.

## Render setup

1. Create a PostgreSQL database and Redis instance. Use private connection URLs where the services share a Render private network.
2. In Render, create a Blueprint from this repository. It reads `render.yaml` and creates the EventGate web service.
3. Set every environment variable marked `sync: false` in the service settings. Use strong generated values for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`; never commit them.
4. Set `DATABASE_URL` to the PostgreSQL connection URL and `REDIS_URL` to the Redis URL.
5. Before enabling public traffic, apply migrations from a trusted deployment environment with `npm run db:migrate` and create the demo accounts with the configured seed variables and `npm run db:seed`.
6. Set `CORS_ORIGINS` to the actual allowed client origins. Do not use a wildcard for authenticated browser clients.
7. Update the SSLCommerz callback URLs and Google OAuth settings only after the Render URL is known.

Render probes `GET /api/v1/health/ready`. That endpoint runs a database query and returns `503` if the database cannot be reached, so the web service should not be considered ready until its database configuration is valid. `GET /api/v1/health/live` only confirms that the HTTP process is running.

Render documents `healthCheckPath` for web-service HTTP health checks and recommends operation-critical checks such as a simple database query. See [Render health checks](https://render.com/docs/health-checks) and the [Blueprint specification](https://render.com/docs/blueprint-spec).

## Production follow-up

Part 12 adds the Render cron job for maintenance. Part 19 verifies the deployed API, migration run, cron execution, and any available SSLCommerz sandbox flow. Those steps remain pending until the required external accounts and credentials are available.
