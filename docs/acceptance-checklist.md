# B7A6 acceptance checklist

This checklist tracks planned evidence. Items are checked only after actual implementation and verification.

| Requirement                            | Planned evidence                                                                 | Status                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Node.js, TypeScript, Express           | `package.json`, strict `tsconfig.json`, consistent HTTP API foundation           | Implemented locally; deployment verification remains pending                      |
| PostgreSQL and Prisma                  | Complete schema, initial SQL migration, idempotent Argon2id seed, Docker Compose | Configured in Part 2; applying migration and seeding require a PostgreSQL runtime |
| Three roles and RBAC                   | Permission matrix, middleware, authorization tests                               | Implemented in Part 7; database-backed tests await PostgreSQL                     |
| Password and Google authentication     | Password APIs, rotating session tests, verified Google ID-token flow             | Implemented in Parts 5-6; real GCP smoke test awaits credentials                  |
| 20+ meaningful APIs                    | OpenAPI, Swagger UI, and Postman collection                                      | Implemented; served locally at `/docs`                                            |
| Zod validation and standard responses  | Response helpers plus reusable Zod validation middleware                         | Implemented in Part 4; endpoint schemas are added with each API module            |
| Search, filter, sort, pagination       | Public event discovery API                                                       | Implemented; PostgreSQL integration verification needs `TEST_DATABASE_URL`        |
| Soft deletion and audit logs           | Lifecycle services and audit module                                              | Implemented; historical records are retained                                      |
| Transactions, constraints, and indexes | Prisma migration and concurrency tests                                           | Implemented; real PostgreSQL run awaits `TEST_DATABASE_URL`                       |
| Redis caching                          | Public discovery cache with failure fallback                                     | Implemented; local Redis verification is pending because Docker is unavailable    |
| Atomic orders and inventory            | Idempotent order API and 15-minute PostgreSQL reservations                       | Implemented; PostgreSQL concurrency verification needs `TEST_DATABASE_URL`        |
| Durable maintenance                    | Leased PostgreSQL jobs, local command, and Render cron declaration               | Implemented; PostgreSQL and Render cron verification are pending                  |
| SSLCommerz checkout                    | Hosted-session adapter and persisted payment attempts                            | Implemented; real sandbox credentials and public callbacks are required           |
| Real payment flow                      | SSLCommerz session, callback validation, reconciliation evidence                 | Implemented; real sandbox run awaits merchant credentials                         |
| Security protection                    | Request IDs, redacted Pino logging, Helmet, CORS, rate limits                    | Implemented in Part 4; security verification expands with API modules             |
| API documentation                      | Swagger UI at `/docs`, `/openapi.json`, Postman collection                       | Implemented and locally smoke-tested                                              |
| Deployment                             | Render Blueprint, deployment guide, and verified live API                        | Blueprint and guide added; external deployment pending credentials                |
| Demo admin credentials                 | Secure seed environment configuration                                            | Implemented; values remain only in local environment                              |
| 20 meaningful commits                  | One coherent commit per implementation part                                      | Verified: 22 commits before the Part 20 documentation commit                      |
| 5-10 minute video                      | Walkthrough script and recording checklist                                       | Script prepared; recording/upload remains manual                                  |
