# EventGate API

EventGate is a full-stack event ticketing platform. This repository contains the Node.js, TypeScript, Express and Prisma API for attendee, organizer and admin workflows. The companion Next.js frontend is maintained in [eventgate-frontend](https://github.com/SayemHasan74/eventgate-frontend).

## Current status

The API provides password and Google authentication, role-restricted event and ticket-tier management, atomic reservations, SSLCommerz callbacks and refund recovery, private QR passes, check-in, durable jobs, reports, notifications, saved events, waitlists and personalized discovery. The source includes database-backed integration suites and API documentation. See the acceptance checklist for evidence and external blockers; a live URL or configured credentials alone do not prove provider or deployed-flow verification.

## Architecture

```text
Routes -> Middleware and validation -> Controllers -> Services -> Prisma
```

The API is a modular monolith. The Next.js frontend is a separate repository and deployment.

## Prerequisites

- Node.js 24
- npm

PostgreSQL and Redis are configured in `docker-compose.yml`. It starts the ordinary development database on port 5432, an isolated test database named `eventgate_test` on port 5433, and Redis on port 6379. Database suites require `TEST_DATABASE_URL` and refuse cleanup if it resolves to the ordinary database.

## Local setup

```bash
git clone https://github.com/SayemHasan74/eventgate-api.git
cd eventgate-api
npm install
cp .env.example .env
npm run infra:up
npm run db:generate
npm run db:migrate
npm run dev
```

The API responds at `http://localhost:4000/`. Operational endpoints are `GET /api/v1/health/live` and `GET /api/v1/health/ready`. The readiness endpoint requires a reachable PostgreSQL database.

## Commands

```bash
npm run dev          # Run the development server
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled code
npm run lint         # Check code quality
npm run format:check # Check formatting
npm run typecheck    # Run strict TypeScript checks
npm run check        # Run all current local checks
npm run infra:up     # Start PostgreSQL and Redis with Docker Compose
npm run db:generate  # Generate Prisma Client
npm run db:migrate   # Apply Prisma migrations
npm run db:seed      # Seed configured development users and demo data
npm test             # All suites; integration tests skip and report skipped without TEST_DATABASE_URL
npm run test:integration # Destructive suites; TEST_DATABASE_URL must target eventgate_test
```

Set `TEST_DATABASE_URL=postgresql://eventgate:eventgate@localhost:5433/eventgate_test?schema=public` for integration tests. Apply migrations to that database with `DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy`, then run `npm run test:integration`. Never target a production or ordinary development database. CI provisions an isolated PostgreSQL database and Redis and applies migrations before running the suites.

## Documentation

- [Requirements](docs/requirements.md)
- [Permissions](docs/permissions.md)
- [Access control and user administration](docs/access-control.md)
- [Event lifecycle](docs/event-lifecycle.md)
- [Ticket-tier rules](docs/ticket-tiers.md)
- [Public event discovery and cache](docs/public-discovery.md)
- [Orders and inventory reservations](docs/orders.md)
- [Durable maintenance jobs](docs/maintenance.md)
- [SSLCommerz checkout initiation](docs/payments.md)
- [Business rules](docs/business-rules.md)
- [Database and seed setup](docs/database.md)
- [Entity relationship design](docs/erd.md)
- [HTTP security and validation](docs/security.md)
- [Password authentication and session lifecycle](docs/authentication.md)
- [Google authentication setup and verification](docs/google-authentication.md)
- [Deployment setup and current verification status](docs/deployment.md)
- [Assignment acceptance checklist](docs/acceptance-checklist.md)
- [Tickets and QR check-in](docs/tickets.md)
- [Refunds and cancellation recovery](docs/refunds.md)
- [API documentation, Postman, and verification record](docs/api.md)
- [Demo walkthrough script](docs/demo-walkthrough.md)
- [Submission fields](docs/submission.md)
- [Mother-document audit](docs/mother-document-audit.md)

## Security note

Never commit `.env`, payment credentials, Google credentials, access tokens, refresh tokens, QR tokens, or real demo passwords.
