# Public event discovery and cache

Public endpoints do not require authentication:

| Endpoint                   | Purpose                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/events`       | Lists published events. Supports `page`, `limit`, `search`, `category`, `city`, `startAfter`, `startBefore`, and `sort` (`soonest`, `latest`, `newest`, or `title`). |
| `GET /api/v1/events/:slug` | Returns one published event and its active ticket tiers.                                                                                                             |

Both responses calculate `availableQuantity` as `capacity - reservedQuantity - soldQuantity`. This value is for browsing only. It is never used to authorize a purchase; Part 11 will reserve inventory directly in PostgreSQL.

Redis caches public list and detail responses for 60 seconds. Keys contain a single cache-version value. Successful event and ticket-tier mutations increment that version after their transaction commits, making prior entries unreachable without needing a risky wildcard deletion. If Redis is missing, unreachable, or returns an error, the API logs the condition and reads PostgreSQL normally.

`tests/unit/public-events.cache.test.ts` verifies version invalidation. `tests/integration/public-events.integration.test.ts` verifies public filtering, pagination, availability, and the no-Redis PostgreSQL fallback with a real `TEST_DATABASE_URL`.
