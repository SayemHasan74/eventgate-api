# Access control and user administration

Part 7 implements the user-facing and administrator access rules for EventGate.

| Endpoint                                   | Allowed roles                     | Rule                                                                                                      |
| ------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/users/me`                     | Active attendee, organizer, admin | Reads the current account from the database.                                                              |
| `PATCH /api/v1/users/me`                   | Active attendee, organizer, admin | Only accepts `displayName`; unknown fields such as `role` are rejected.                                   |
| `GET /api/v1/admin/users`                  | Active admin                      | Supports `page`, `limit`, `role`, `status`, and `search`.                                                 |
| `PATCH /api/v1/admin/users/:userId/role`   | Active admin                      | Only changes attendee and organizer roles. An organizer with draft or published events cannot be demoted. |
| `PATCH /api/v1/admin/users/:userId/status` | Active admin                      | Suspends or reactivates an account and records an audit event.                                            |
| `DELETE /api/v1/admin/users/:userId`       | Active admin                      | Soft-deletes the account, revokes refresh sessions, and records an audit event.                           |

Every protected request verifies the Bearer token and then reloads the account’s current status and role from PostgreSQL. A previously issued token cannot access protected endpoints after suspension or soft deletion.

Administrator accounts are created only by secure seeding. The API cannot create, promote, or demote an `ADMIN` role. Suspending or deleting the last active administrator returns `409 LAST_ACTIVE_ADMIN`. These checks run in serializable transactions with the matching audit write.

`tests/integration/users.integration.test.ts` covers all three roles, profile privilege injection, promotion auditing, organizer ownership rules, immediate suspension enforcement, and last-admin protection. It intentionally runs only with a real dedicated PostgreSQL database named through `TEST_DATABASE_URL` containing `eventgate_test`.
