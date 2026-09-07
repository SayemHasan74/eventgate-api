# EventGate API

EventGate is a backend-only event ticketing and QR check-in platform. Organizers publish events with limited ticket tiers, attendees reserve and purchase tickets, verified SSLCommerz payments issue QR tickets, and organizers check each ticket in once.

## Current status

Parts 1-20 are implemented and the API is deployed at https://eventgate-api.onrender.com. The API includes authentication, event and ticket-tier management, inventory reservations, verified SSLCommerz payment/refund workflows, QR admission, maintenance jobs, reports, tests, API documentation, and submission materials. Google OAuth is configured; a real Google ID-token smoke test and SSLCommerz sandbox payment remain to be demonstrated.

## Architecture

```text
Routes -> Middleware and validation -> Controllers -> Services -> Prisma
```

The application is a modular monolith. It will not include a frontend, microservices, seat maps, ticket transfers, coupons, or partial refunds.

## Prerequisites

- Node.js 24
- npm

PostgreSQL and Redis are configured in `docker-compose.yml`.

## Local setup

```bash
git clone https://github.com/SayemHasan74/eventgate-api.git
cd eventgate-api
npm install
cp .env.example .env
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
npm test             # Unit tests; integration tests require TEST_DATABASE_URL
```

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
