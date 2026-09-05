# EventGate requirements

EventGate is a backend-only event ticketing and check-in platform. It is built for the B7A6 backend assignment and follows the EventGate mother prompt as the product authority.

## Problem

Event organizers need a dependable way to publish events, sell a limited number of ticket tiers, verify payments, issue tickets, and admit each ticket only once. Attendees need a safe way to buy tickets, view them, and request eligible whole-order refunds.

## Scope

The core path is: organizer creates event and tiers, publishes it, attendee reserves inventory through an order, attendee pays through SSLCommerz, verified payment creates QR tickets, and the organizer checks each ticket in once.

The platform also includes event cancellation, whole-order refunds, user suspension, reports, audit logs, Redis-backed public discovery caching, and durable recovery work.

## Assignment commitments

- Node.js, TypeScript, Express, PostgreSQL, Prisma, Redis, and Zod.
- Exactly three roles: `ATTENDEE`, `ORGANIZER`, and `ADMIN`.
- Email/password and Google ID-token login, JWT bearer access, rotating refresh sessions, and object-level authorization.
- At least 20 documented `/api/v1` endpoints with standard response envelopes.
- Validation, pagination, filtering, sorting, relevant search, soft deletion, and audit history.
- SSLCommerz hosted checkout and provider-side verification; no fake application payment success.
- Helmet, configured CORS, rate limits, secret redaction, tests, OpenAPI/Swagger, Postman, Docker Compose, Render configuration, CI, deployment evidence, demo credentials, and a 5-10 minute walkthrough.

## Deliberate exclusions

No frontend, seat maps, ticket resale or transfer, coupons, multi-event carts, partial refunds, organizer payouts, recurring events, email delivery, file uploads, WebSockets, or microservices.
