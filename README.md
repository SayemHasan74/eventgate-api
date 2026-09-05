# EventGate API

EventGate is a backend-only event ticketing and QR check-in platform. Organizers publish events with limited ticket tiers, attendees reserve and purchase tickets, verified SSLCommerz payments issue QR tickets, and organizers check each ticket in once.

## Current status

Part 1 is complete: strict TypeScript setup, starter Express API, safe environment template, linting/formatting, and requirement documentation. Database, authentication, payments, and product APIs are implemented in later planned parts.

## Architecture

```text
Routes -> Middleware and validation -> Controllers -> Services -> Prisma
```

The application is a modular monolith. It will not include a frontend, microservices, seat maps, ticket transfers, coupons, or partial refunds.

## Prerequisites

- Node.js 24
- npm

PostgreSQL and Redis are introduced in Part 2 through Docker Compose.

## Local setup

```bash
git clone https://github.com/SayemHasan74/eventgate-api.git
cd eventgate-api
npm install
cp .env.example .env
npm run dev
```

The starter API responds at `http://localhost:4000/`.

## Commands

```bash
npm run dev          # Run the development server
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled code
npm run lint         # Check code quality
npm run format:check # Check formatting
npm run typecheck    # Run strict TypeScript checks
npm run check        # Run all current local checks
```

## Documentation

- [Requirements](docs/requirements.md)
- [Permissions](docs/permissions.md)
- [Business rules](docs/business-rules.md)
- [Assignment acceptance checklist](docs/acceptance-checklist.md)

## Security note

Never commit `.env`, payment credentials, Google credentials, access tokens, refresh tokens, QR tokens, or real demo passwords.
