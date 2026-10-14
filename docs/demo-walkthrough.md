# EventGate walkthrough (about 7 minutes)

Use a dedicated demo account and database. Do not record credentials, cookies, access or refresh tokens, QR contents, payment secrets, or attendee personal data. Use one already-published demo event; avoid deleting production or shared demo records.

## 1. Architecture and access (45 seconds)

Show the API and frontend repositories. Explain the request path: route, authentication/validation middleware, controller, service, Prisma/PostgreSQL. Identify attendee, organizer, and admin access. Sign in as each only if authorized demo accounts are available.

## 2. Organizer event lifecycle (60 seconds)

As an organizer, show an event draft, its ticket tiers, readiness/publish state, and the public event listing. Show an invalid request or a forbidden cross-role request and its error response. Use a disposable draft for any create/edit/cancel action.

## 3. Attendee discovery and booking (60 seconds)

Browse and filter events, open event details, and show sale timing and availability. If demonstrating recommendations, open the preference controls and explain the displayed category/city/saved-event reason. Save an event and show the attendee account reflects it. Create a reservation only in the demo environment.

## 4. Payment and ticket fulfillment (60–90 seconds)

Show the checkout handoff and explain that only a verified provider callback fulfills the order. If a real sandbox transaction and callback were completed for this recording, show its resulting paid order and ticket. If not, explicitly say the provider flow is pending; a redirect or query parameter is not proof of payment.

## 5. QR admission and duplicate protection (60 seconds)

Show the attendee's private PNG ticket QR without revealing its contents. As the organizer, scan or manually submit it once, then repeat the scan to demonstrate that duplicate admission is rejected. Explain the atomic one-time state transition.

## 6. Refund and admin operations (60 seconds)

Show an attendee refund request and its current state, then show the admin review/reconciliation queue. Distinguish requested, processing, and provider-confirmed completion. Do not call a pending refund successful. Show one admin report or audit entry.

## 7. Reliability and close (45 seconds)

Show the test database is isolated from development/production, point out CI and the migration history, and explain one inventory/idempotency guarantee. State any provider or hosted checks that remain pending.

## Before recording

- Use disposable local/demo data and verify the accounts' roles.
- Do not expose secrets, session cookies, tokens, QR payloads, or personal data.
- Keep a refund and payment marked pending until the provider confirms its terminal result.
- Only claim Google, camera, payment, refund, and hosted deployment behavior that was actually demonstrated.
