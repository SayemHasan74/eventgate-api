# Event lifecycle

An organizer owns every event they create. An organizer sees and changes only their own active events; an administrator may manage any active event. Cross-organizer access returns `404` so event existence is not disclosed.

| Endpoint                                         | Rule                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/organizer/events`                  | Creates a future draft event and an `EVENT_CREATED` audit record.                                                    |
| `GET /api/v1/organizer/events`                   | Lists active events owned by the organizer, or all active events for an admin.                                       |
| `PATCH /api/v1/organizer/events/:eventId`        | Drafts can be edited. Published events permit only title, description, and image edits.                              |
| `POST /api/v1/organizer/events/:eventId/publish` | Requires a future draft and at least one active ticket tier.                                                         |
| `POST /api/v1/organizer/events/:eventId/cancel`  | Cancels an upcoming draft or published event and creates a `PROCESS_EVENT_CANCELLATION` job in the same transaction. |
| `DELETE /api/v1/organizer/events/:eventId`       | Soft-deletes only a draft with no order history.                                                                     |

Valid state transitions are `DRAFT → PUBLISHED → COMPLETED`, `DRAFT → CANCELLED`, and `PUBLISHED → CANCELLED`. Completion is a later maintenance-job responsibility. Cancellation jobs are recorded now and will be processed by Part 12.

Every create, update, publish, cancellation, and soft deletion writes an event audit record in the same database transaction as the state mutation. `tests/integration/events.integration.test.ts` uses a dedicated real PostgreSQL database when `TEST_DATABASE_URL` is configured.
