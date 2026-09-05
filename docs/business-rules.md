# EventGate business rules

## Lifecycle states

- Event: `DRAFT -> PUBLISHED -> COMPLETED`; draft or published events may become `CANCELLED` before start.
- Order: `PENDING_PAYMENT -> PAID`, `EXPIRED`, or `CANCELLED`; paid orders may become `REFUNDED`.
- Ticket: `ACTIVE -> CHECKED_IN` or `VOIDED`; active or voided tickets may become `REFUNDED`.
- Payment attempt: `INITIATING -> PENDING -> SUCCEEDED`; active attempts can become `FAILED`, `CANCELLED`, or `UNKNOWN`.
- Refund: `REQUESTED -> APPROVED -> PROCESSING -> SUCCEEDED`; refunds can be rejected, fail and retry, or require reconciliation.

## Inventory and orders

Ticket tier prices are stored in integer paisa; currency is always BDT. For every tier, reserved and sold quantities remain non-negative and their sum cannot exceed capacity. Availability is capacity minus reserved minus sold.

Orders contain one tier from one event, quantity 1-10, and immutable snapshots of the event/tier names, unit price, total, and currency. Creating an order reserves inventory for 15 minutes through a conditional update inside a database transaction. Cancellation and expiry release inventory exactly once.

## Payments and fulfillment

Only a provider-verified SSLCommerz success can fulfill an order. Verification checks merchant transaction association, amount, currency, provider status, and unique provider transaction identity. Fulfillment atomically records payment, marks the order paid, converts reservation to sales, creates individual tickets, and writes an audit entry. Duplicate callbacks cannot repeat it.

## Check-in and refunds

Each ticket has a random 256-bit QR token and may be checked in once by the event organizer or an admin from two hours before the event through its end. Check-in is an atomic conditional transition.

Refunds apply to the entire order only. An attendee can request one only for a paid order with no checked-in ticket, at least 24 hours before start. Approval blocks ticket use immediately. Only provider-confirmed refund success changes order and ticket states.

## Security and data retention

Protected endpoints re-check current user role/status. Suspended or deleted accounts cannot use prior access tokens. Users, eligible unused tiers, and eligible draft events are soft deleted; financial and audit records are retained. Secret values and QR credentials are never logged.
