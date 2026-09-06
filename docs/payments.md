# SSLCommerz checkout initiation

An attendee starts hosted checkout with `POST /api/v1/payments/orders/:orderId/checkout`. The order must be the attendee’s own active `PENDING_PAYMENT` order and its 15-minute reservation must not have expired.

Before any network request, EventGate writes a `PaymentAttempt` with a unique merchant transaction ID and `INITIATING` status. PostgreSQL permits only one `INITIATING` or `PENDING` attempt for an order, and application logic also blocks a new attempt while an earlier result is `UNKNOWN`. A definitive rejected session becomes `FAILED`, allowing a later sequential retry. A network or malformed-provider response becomes `UNKNOWN` and is queued for reconciliation; the application never blindly retries an uncertain provider request.

The adapter uses SSLCommerz’s documented v4 hosted-session endpoint, sends the order amount in BDT, and returns only the provider-hosted gateway URL. Callback URLs and credentials are read from environment configuration. The attendee must first add phone, address, city, postal code, and country through `PATCH /api/v1/users/me`.

Real checkout is blocked until valid SSLCommerz sandbox or live credentials and publicly reachable callback/IPN URLs are configured. The adapter has mocked unit coverage, but no real provider session has been claimed or recorded.
