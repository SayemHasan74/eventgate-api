# EventGate Swagger recording script (7–9 minutes)

Open `https://eventgate-api.onrender.com/docs/` after the documentation deploy finishes. Keep Swagger in its default order and use the numbered tags. You can explain the response without submitting every request; for protected requests, paste the appropriate bearer token using the **Authorize** button.

## Say and show in this order

1. **01 Health — service status.** “This is the EventGate OpenAPI documentation. I start with the liveness check to show the process is running, then the readiness check to show PostgreSQL is connected.” Open `GET /health/live`, then `GET /health/ready`.
2. **02 Authentication — identity and sessions.** “The API supports attendee registration, password login, Google ID-token login, refresh-token rotation, and logout.” Show the request bodies on `POST /auth/register`, `POST /auth/login`, `POST /auth/google`, `POST /auth/refresh`, and `POST /auth/logout`. Mention that passwords and tokens are never shown in the recording.
3. **03 Public discovery — no token required.** “Published events are searchable and each event has a public detail page with its available ticket tiers.” Show `GET /events` with `search=launch`, then `GET /events/{slug}` with `eventgate-launch-demo`.
4. **04 Organizer lifecycle — protected management.** “Organizers create a draft event, add ticket tiers, publish or cancel the event, and can edit or soft-delete their own resources.” Show the populated bodies and path fields for the organizer event and ticket-tier operations. Explain that object-level authorization prevents editing another organizer’s event.
5. **05 Orders and payment — reservation to gateway.** “An attendee reserves a tier with quantity and an Idempotency-Key. Repeating the same key safely replays the same reservation instead of overselling.” Show `POST /orders` with the example body and header, then the order list/detail, cancel, and the SSLCommerz checkout operation. Explain that checkout returns a hosted gateway URL and provider callbacks control fulfillment.
6. **06 Tickets and check-in — one-time admission.** “After verified payment, the attendee can list a ticket and retrieve its QR SVG. The organizer submits the QR token for check-in, and a second scan is rejected.” Show the ticket and QR path fields, then the check-in body and history query. Keep the real QR token hidden.
7. **07 Refunds — controlled review.** “The attendee requests a whole-order refund. An admin reviews it, and the provider refund can be retried if recovery work is needed.” Show the populated `orderId`, `refundId`, and `{ "decision": "approve" }` body, plus the attendee/admin refund list operations.
8. **08 Reports — role-restricted visibility.** “Organizers see reports for their own event, while admins see platform statistics, operations, and audit logs.” Show the three report groups. Finish by pointing out that every protected operation displays the bearer lock and every operation documents success and error responses.
9. **Closing.** “This demonstrates the complete EventGate flow: health, authentication, public discovery, organizer lifecycle, safe ticket reservation, verified payment, QR admission, refunds, and reporting. The repository also includes the Postman collection and automated checks.”

## Recording rules

- Hide `.env`, passwords, access tokens, refresh tokens, Google secrets, SSLCommerz credentials, and QR tokens.
- The dark Swagger theme follows the browser/OS theme and is normal. The green/blue endpoint colors indicate HTTP methods, not errors.
- “No parameters” should only appear on endpoints that genuinely take no input, such as the health checks. The updated page should show fields for login, orders, checkout IDs/headers, check-in, and refunds.
- Use the real deployed URL in the recording, but do not submit destructive organizer actions unless you intend to change the demo data.

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
