# EventGate demo walkthrough (7–9 minutes)

Use a local PostgreSQL/Redis setup and a local `.env` created from `.env.example`. Run migrations and seed data first. Never show real passwords, access tokens, QR tokens, gateway credentials, or a production environment file.

1. **Architecture — 45 seconds.** Show the repository and explain the flow: routes, middleware and Zod validation, controllers, services, and Prisma. Show the schema’s Event, TicketTier, Order, PaymentAttempt, Ticket, Refund, and AuditLog relationships.
2. **Roles and security — 60 seconds.** Log in as attendee, organizer, and admin using locally seeded credentials. Show an attendee receiving `403` on an organizer endpoint, then show the admin user-management/report view. Mention short-lived access tokens and rotating refresh tokens.
3. **Event lifecycle — 60 seconds.** As organizer, create a draft event and tiers, publish it, and show public search. Try to mutate a published tier or access another organizer’s event to demonstrate the protected workflow.
4. **Order concurrency — 60 seconds.** Create an attendee order with an `Idempotency-Key`. Repeat it with the same key, then show the response is replayed. Explain the conditional PostgreSQL inventory update that prevents overselling.
5. **Payment flow — 60 seconds.** Show the checkout session endpoint and callback routes. Explain that callback bodies are recorded but SSLCommerz validation controls fulfillment. If sandbox credentials are available, run a sandbox payment; otherwise state clearly that the real gateway demo is pending credentials.
6. **QR check-in — 60 seconds.** Show an attendee’s ticket and QR image, then scan/send the token as the organizer. Repeat the scan to show the duplicate rejection. Explain the atomic `ACTIVE → CHECKED_IN` transition.
7. **Refund and cancellation — 60 seconds.** Request a whole-order refund and show the admin approval path blocks ticket use. Explain that only provider-confirmed completion changes order/ticket/inventory state. Cancel an upcoming event and show the maintenance job creates recoverable refund work.
8. **Documentation and tests — 45 seconds.** Open `/docs`, import the Postman collection, and run `npm run check`. Show the ticket concurrency integration test and explain that it requires a real `TEST_DATABASE_URL`.

## Recording checklist

- [ ] Use a dedicated local/demo database.
- [ ] Hide `.env`, credential fields, tokens, and QR tokens.
- [ ] State whether SSLCommerz sandbox was actually run.
- [ ] Show one `403`, one validation error, and one duplicate check-in rejection.
- [ ] Record and upload the video manually; this repository does not contain a recording or submission link.
