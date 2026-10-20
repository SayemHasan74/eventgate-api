# Performance changes — 20 October 2026

These changes address the combined audit and owner findings in both local repositories. They are not deployed. No production database, Redis settings, service plan or hosting region was changed.

## Changes and status

| Problem                                                              | Local implementation                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Homepage hidden until session restoration                            | Removed the old HomeEntry component. The hero renders immediately; session redirection, city options and programme stream independently.                                                                                                                                  |
| Repeated admin authentication                                        | One authentication/role boundary replaces four router-wide authentication passes. Current account status and token version remain checked on each private request.                                                                                                        |
| Repeated protected-layout entry                                      | Existing routes moved under one `(workspace)` layout without changing URLs. Session/identity work is memoized only within a server render; section role checks remain.                                                                                                    |
| Initial dashboard data starts after hydration                        | Attendee and organizer summaries load server-side and hydrate request-local, user-scoped React Query data. Other record/list queries continue using their existing client adapters.                                                                                       |
| Public requests always hit Render                                    | Public discovery reads use bounded Next caching; details have per-slug tags. Visitor identity headers are excluded from shared public cache keys. Availability and all private requests remain uncached.                                                                  |
| Serial cache reads and awaited optional writes                       | One Redis script reads version + payload. A fill writes only under its observed version using an atomic comparison. Cache persistence runs outside the response's critical path. Identical concurrent misses share one database read.                                     |
| Overbroad invalidation                                               | Inventory changes leave facets intact; event details have individual namespaces. Event/tier client invalidations target the affected event plus lists. Financial operations and scans no longer purge the public page cache.                                              |
| Saves and scans await unrelated refetches                            | Confirmed mutations mark queries stale synchronously and release the UI without awaiting background reads. Removed redundant form route refreshes. Authentication route refreshes remain necessary.                                                                       |
| Organizer reports duplicate access checks and wait for event details | Combined statistics authorize once. Independent report panels start in parallel with their header query; financial snapshot consistency remains intact.                                                                                                                   |
| Full managed-event reads polled by scanner                           | A lean check-in-status endpoint replaces readiness/tier/order aggregate reads on the five-second poll. History rows/counts use independent parallel reads.                                                                                                                |
| Notification count requires a full list and two counts               | Dedicated unread-count endpoint. The history screen supplies its authoritative count to the shared badge cache.                                                                                                                                                           |
| Pass polls hide QR media and refetch its immutable image             | Background pass refresh no longer hides an already validated QR or repeatedly re-enables a stale image query. Refreshed admission state still removes blocked media, and server admission remains authoritative.                                                          |
| Event write lock serializes unrelated reservations/scans             | Shared event-state locks permit concurrent operations while excluding cancellation/edit transitions. Admission/QR reads omit inventory-tier locks. Order/ticket/payment/refund coordination remains.                                                                      |
| Search/history query scaling                                         | Applied and verified a new migration locally: check-in ordering index plus partial pg_trgm indexes matching the public substring search. Budget prefilter now scopes candidate events before checking tier stock.                                                         |
| Unbounded database resource waits                                    | Explicit pool-acquisition and per-statement timeouts, configurable pool maximum. Private upstream requests preserve caller cancellation as well as their own timeout.                                                                                                     |
| Optional JavaScript and images                                       | AI chat loads on first use; report charts have a separate lazy module. Above-fold event cover is eager/high priority; catalogue covers remain lazy.                                                                                                                       |
| Extra query per stock-alert row, discovered during implementation    | Replaced per-row entitlement counts with one grouped query for the page.                                                                                                                                                                                                  |
| Geographic placement                                                 | Frontend `vercel.json` selects Singapore (`sin1`) on its next deployment. Render/Redis/Neon placement must still be inspected in the actual accounts.                                                                                                                     |
| Free API sleep and background contention                             | One maintenance runner supports both embedded and persistent worker modes. Added `npm run jobs:worker` and bounded worker-pool guidance. The default remains embedded until an actual worker exists; always-on hosting and worker provisioning remain account-level work. |

## Verification

- Backend: format check, lint, TypeScript and build pass. All **189 tests in 38 suites** pass with a disposable local PostgreSQL database and Redis; no integration suites skipped in the final run.
- Frontend: production build and lint pass; **35 contract tests + 2 upstream transport tests**, **10 session tests**, and **1 production proxy test** pass.
- Database races covered include simultaneous reservations, simultaneous scans of one ticket, scan versus cancellation, payment callbacks, and refund reconciliation. Session tests cover distributed refresh, logout races and failed persistence.
- Actual Redis script check: eight concurrent identical misses invoked the loader once; an old fill following version invalidation was rejected.
- Delayed-backend production render: fixture replies took two seconds. The first homepage hero streamed in **0.205 s** while the full response completed in 2.217 s. The repeat hero arrived in **0.007 s**; full response 0.008 s. The two page requests caused only one catalogue request and one facets request in total.
- Local browser checks: public hero, organizer sign-in/summary, navigation to profile with retained shell, and organizer denial on `/admin`.
- Disposable 10,000-event search comparison, same SQL/data: sequential scan **13.317 ms**, indexed bitmap heap scan **0.032 ms**. This is a synthetic local query comparison, not production p95 or a promise of an application-wide speedup.
- New migration applied successfully on disposable PostgreSQL. Index creation has a write/storage cost and takes build locks; production scheduling depends on actual table size.
- The installed Prisma/pg adapter emits a query-concurrency deprecation warning during some integration flows. The suites pass; dependencies were not upgraded or patched as part of this change.

## Removed or corrected redundancy

- Deleted the old homepage client gate and nine duplicate loading re-export files.
- Replaced per-section protected shells with a shared shell. Existing pages/CSS moved; there are no duplicate old route trees.
- Removed repeated admin authentication and the redundant combined-report service wrapper.
- Replaced the old cache read/write implementation, rather than retaining two cache systems.
- Extracted chart code from its old module and share one maintenance loop between web and worker processes.
- Removed redundant mutation-triggered route refreshes.
- Corrected stale documentation claiming a deployed cron Blueprint and obsolete frontend/admin-demo configuration.
- Retained the owner's untracked planning documents unchanged; they are not executable application code.

## Remaining live rollout

1. Deploy the backend first, including migration `20261020000000_read_performance`. This adds the count/status endpoints the frontend expects. Production start still runs `prisma migrate deploy`.
2. Deploy the frontend with its Singapore function configuration. Verify the actual execution region and database/session/cache latency; `vercel.json` does not move Render or Redis.
3. Verify Render's current service region/plan and both Redis locations. Provision an always-on API if idle spin-up must be eliminated. Moving a database/Redis instance requires a separate provider-specific migration; no URLs were guessed or replaced locally.
4. If using a separate worker, deploy `npm run jobs:worker` with the API's required server configuration and `DATABASE_POOL_MAX=2`. Confirm its maintenance heartbeat before setting `EMBEDDED_MAINTENANCE=false` on the web service. See [maintenance](maintenance.md).
5. After rollout, collect live login-to-dashboard, section navigation, save confirmation and scan turnaround on the user's actual device/network. Local timings do not establish browser INP/LCP or live performance.

Hosting integrations were discovered but were not connected during implementation. Vercel, Render and Neon account access is needed to finish the account-level verification and rollout.

## Provider references

- [Vercel function regions](https://vercel.com/docs/functions/configuring-functions/region): source configuration selects the next deployment region.
- [Render Free idle behavior](https://render.com/docs/free#spinning-down-on-idle): application code cannot remove the platform's idle spin-up.
- [PostgreSQL trigram indexes](https://www.postgresql.org/docs/17/pgtrgm.html): GIN supports the existing ILIKE substring queries.
- [Neon extension support](https://neon.com/blog/ten-most-popular-postgres-extensions): pg_trgm is available on Neon.
