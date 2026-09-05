# Local database setup

EventGate uses PostgreSQL for durable data and Redis for public-event cache state and later operational coordination.

## Local infrastructure

```bash
cp .env.example .env
npm run infra:up
npm run db:generate
npm run db:migrate -- --name init
npm run db:seed
```

The compose file starts PostgreSQL 17 at `localhost:5432` and Redis 7 at `localhost:6379`, matching the example environment values.

## Seed data

`npm run db:seed` requires `SEED_ADMIN_PASSWORD`, `SEED_ORGANIZER_PASSWORD`, and `SEED_ATTENDEE_PASSWORD` in `.env`. It hashes each password using Argon2id and upserts one admin, one organizer, one attendee, a draft demo event, and General Admission/VIP tiers.

The seed script is idempotent: re-running it updates the same accounts, event, and tiers rather than creating duplicates. Keep real demo passwords in `.env`; never commit them.

## Constraints added in the initial migration

- Emails must be normalized lowercase.
- Events require `end_at > start_at`.
- Ticket tier prices/capacities/reserved/sold quantities are non-negative, reserved plus sold cannot exceed capacity, and the sales window ends after it starts.
- Orders require quantity 1-10, BDT currency, non-negative prices, and a total equal to unit price times quantity.
- Payment attempts and refunds require positive BDT amounts.
- Tickets marked `CHECKED_IN` require check-in time and actor; other ticket states must not retain check-in data.

Prisma models define foreign keys, indexes, unique identities, and lifecycle fields. The SQL migration adds these PostgreSQL checks because Prisma schema syntax cannot express all of them.
