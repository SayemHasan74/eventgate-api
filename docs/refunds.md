# Refunds and cancellation recovery

Attendees create a whole-order refund request with `POST /api/v1/orders/:orderId/refund-requests`. The order must be paid, have no checked-in tickets, and begin at least 24 hours later. Administrators list, approve, reject, or retry requests at `/api/v1/admin/refunds`.

Approval immediately changes active tickets to `VOIDED`, so check-in's conditional `ACTIVE` transition cannot admit a ticket while a refund is in progress. SSLCommerz refund initiation and status queries use the documented merchant transaction validation endpoint. Only the provider's `refunded` status changes an order to `REFUNDED`, changes tickets to `REFUNDED`, and decrements sold inventory once. Failed and network-uncertain requests remain retryable or reconcilable; they never claim money was returned.

Event cancellation jobs release unpaid reservations, create approved cancellation refunds for paid orders, void their tickets, and begin provider refunds. Refunds for late or duplicate unfulfilled payments never alter tickets or inventory because their orders are not paid.
