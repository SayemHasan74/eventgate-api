# Tickets and event check-in

| Endpoint                                           | Access               | Purpose                                                                       |
| -------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `GET /api/v1/tickets`                              | Attendee             | Lists only the caller's tickets, without QR credentials.                      |
| `GET /api/v1/tickets/:ticketId`                    | Attendee             | Reads one owned ticket.                                                       |
| `GET /api/v1/tickets/:ticketId/qr`                 | Attendee             | Returns a non-cacheable SVG QR code containing only its opaque 256-bit token. |
| `POST /api/v1/organizer/events/:eventId/check-ins` | Event owner or admin | Checks in `{ "qrToken": "…" }`.                                               |
| `GET /api/v1/organizer/events/:eventId/check-ins`  | Event owner or admin | Reads paginated check-in history.                                             |

Check-in opens two hours before a published event and closes at its `endAt`. The check-in operation is a single conditional update from `ACTIVE` to `CHECKED_IN`, so two simultaneous scans cannot both succeed. Refunded, voided, and already checked-in tickets fail that condition. The endpoint verifies organizer ownership before inspecting a QR token, and successful scans write an audit record without storing the token in it.
