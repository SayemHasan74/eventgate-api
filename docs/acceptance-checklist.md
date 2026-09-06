# B7A6 acceptance checklist

This checklist tracks planned evidence. Items are checked only after actual implementation and verification.

| Requirement                            | Planned evidence                                                                 | Status                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Node.js, TypeScript, Express           | `package.json`, strict `tsconfig.json`, consistent HTTP API foundation           | Implemented locally; deployment verification remains pending                      |
| PostgreSQL and Prisma                  | Complete schema, initial SQL migration, idempotent Argon2id seed, Docker Compose | Configured in Part 2; applying migration and seeding require a PostgreSQL runtime |
| Three roles and RBAC                   | Permission matrix, middleware, authorization tests                               | Implemented in Part 7; database-backed tests await PostgreSQL                     |
| Password and Google authentication     | Password APIs, rotating session tests, verified Google ID-token flow             | Implemented in Parts 5-6; real GCP smoke test awaits credentials                  |
| 20+ meaningful APIs                    | OpenAPI and Postman collection                                                   | Planned through Parts 8-19                                                        |
| Zod validation and standard responses  | Response helpers plus reusable Zod validation middleware                         | Implemented in Part 4; endpoint schemas are added with each API module            |
| Search, filter, sort, pagination       | Public event discovery API                                                       | Planned in Part 10                                                                |
| Soft deletion and audit logs           | Lifecycle services and audit module                                              | Planned in Parts 7-17                                                             |
| Transactions, constraints, and indexes | Prisma migration and concurrency tests                                           | Planned in Parts 2, 11, 14-16, 18                                                 |
| Redis caching                          | Public discovery cache with failure fallback                                     | Planned in Part 10                                                                |
| Real payment flow                      | SSLCommerz session, callback validation, reconciliation evidence                 | Planned in Parts 13-16                                                            |
| Security protection                    | Request IDs, redacted Pino logging, Helmet, CORS, rate limits                    | Implemented in Part 4; security verification expands with API modules             |
| API documentation                      | Swagger and Postman collection                                                   | Planned in Part 19                                                                |
| Deployment                             | Render Blueprint, deployment guide, and verified live API                        | Blueprint and guide added; external deployment pending credentials                |
| Demo admin credentials                 | Secure seed environment configuration                                            | Planned in Part 2 and final verification                                          |
| 20 meaningful commits                  | One coherent commit per implementation part                                      | In progress                                                                       |
| 5-10 minute video                      | Walkthrough script and recording checklist                                       | Planned in Part 20                                                                |
