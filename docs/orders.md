# Orders and inventory reservations

| Endpoint                              | Rule                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/orders`                 | Requires an `Idempotency-Key` header and accepts only `ticketTierId` and quantity `1–10`. It reserves stock for 15 minutes. |
| `GET /api/v1/orders`                  | Lists the caller’s orders with `page`, `limit`, and optional `status`.                                                      |
| `GET /api/v1/orders/:orderId`         | Returns only the caller’s order.                                                                                            |
| `POST /api/v1/orders/:orderId/cancel` | Cancels a pending order and releases its reservation exactly once.                                                          |

The server calculates BDT price snapshots and uses a conditional PostgreSQL update that reserves stock only while the event is published, on sale, and has enough capacity. Cached availability is never used to authorize a purchase.

Order creation runs in a serializable transaction with bounded retries. The reservation, order, idempotency record, and audit record commit together. Repeating an idempotency key with the same body returns the original order; changing the body returns `409`.

Cancellation transitions only an active `PENDING_PAYMENT` order and records `reservationReleasedAt` in the same transaction as its inventory decrement. That timestamp prevents double release. Expiry is Part 12’s maintenance-job responsibility.

`tests/integration/orders.integration.test.ts` covers snapshots, idempotency, ownership, cancellation, and concurrent final-ticket requests with a real PostgreSQL `TEST_DATABASE_URL`.
