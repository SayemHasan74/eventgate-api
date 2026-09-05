# EventGate entity relationship design

```mermaid
erDiagram
  USER ||--o{ AUTH_IDENTITY : owns
  USER ||--o{ REFRESH_SESSION : has
  USER ||--o{ EVENT : organizes
  USER ||--o{ ORDER : places
  USER ||--o{ TICKET : owns
  USER ||--o{ AUDIT_LOG : acts_in
  USER ||--o{ IDEMPOTENCY_RECORD : sends
  USER ||--o{ REFUND : requests_or_reviews
  EVENT ||--o{ TICKET_TIER : has
  EVENT ||--o{ ORDER : receives
  EVENT ||--o{ TICKET : admits
  TICKET_TIER ||--o{ ORDER : selected_by
  TICKET_TIER ||--o{ TICKET : classifies
  ORDER ||--o{ PAYMENT_ATTEMPT : has
  ORDER ||--o{ TICKET : issues
  ORDER ||--o{ REFUND : may_have
  PAYMENT_ATTEMPT ||--o{ PAYMENT_EVENT : receives
  PAYMENT_ATTEMPT ||--o{ REFUND : may_refund
```

## Core relationships

- A user organizes zero or more events and places zero or more orders.
- An event has ticket tiers. An order selects exactly one tier from one event and stores immutable price/name snapshots.
- A paid order issues one ticket per requested unit. Every ticket has one owner, one tier, one event, and a unique QR token.
- Payment attempts are sequential for an order. Provider callback records are retained separately from the attempt so duplicate or malformed callbacks remain auditable.
- A refund always concerns one order and may target one payment attempt when resolving a late or duplicate payment.
- Audit logs, idempotency records, and durable jobs preserve operational evidence without deleting financial history.

## Lock order

Future inventory, payment, refund, and check-in services must lock resources in this order: `Event -> TicketTier -> Order -> PaymentAttempt/Refund -> Ticket`. This single order is documented now to reduce avoidable deadlocks when concurrent workflow services are added.
