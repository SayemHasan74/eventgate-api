# Tickets and event check-in

| Endpoint                                           | Access               | Purpose                                                                                                                                                               |
| -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/tickets`                              | Attendee             | Lists only the caller's tickets, without QR credentials.                                                                                                              |
| `GET /api/v1/tickets/:ticketId`                    | Attendee             | Reads one owned ticket.                                                                                                                                               |
| `GET /api/v1/tickets/:ticketId/qr`                 | Attendee             | Returns private,no-store JSON: {success,message,data:{ticketId,mimeType:"image/png",dataUrl}}. The PNG encodes the opaque credential; no raw token field is returned. |
| `POST /api/v1/organizer/events/:eventId/check-ins` | Event owner or admin | Checks in `{ "qrToken": "…" }`.                                                                                                                                       |
| `GET /api/v1/organizer/events/:eventId/check-ins`  | Event owner or admin | Reads paginated check-in history.                                                                                                                                     |

Check-in opens two hours before a published event and closes at its `endAt`. The check-in operation is a single conditional update from `ACTIVE` to `CHECKED_IN`, so two simultaneous scans cannot both succeed. Refunded, voided, and already checked-in tickets fail that condition. The endpoint verifies organizer ownership before inspecting a QR token, and successful scans write an audit record without storing the token in it.

The frontend and API QR contract must be deployed together. Provider IPN acknowledgements (plain text) and browser payment callbacks (303 redirects) are deliberate envelope exceptions.
