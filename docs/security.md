# HTTP security

EventGate applies the following protections before application routes:

- Helmet security headers.
- An explicit CORS allowlist from `CORS_ORIGINS`, with credentials enabled for allowed browser clients only.
- JSON request bodies limited to 100 KB.
- SSLCommerz callback form bodies limited to 16 KB and 50 parameters. Callback routes are parsed separately from normal JSON APIs.
- An IP-based API limit of 100 requests per 15 minutes by default, with standards-based `RateLimit` headers. Authentication routes use the separate 10-attempt limit defined now and mounted in Part 5.
- Pino redaction for credentials, tokens, QR credentials, cookies, and gateway secrets.

`TRUST_PROXY_HOPS` defaults to `0` for local development. Set it to the exact number of trusted reverse proxies in production. The supplied Render configuration uses `1`, so Express and rate limiting use the real client IP from Render's forwarded header.

All route-level validation uses the reusable `validate` middleware. It accepts Zod schemas for `body`, `params`, and `query`, returns the standard `400` error envelope, and assigns parsed values for controllers. Mutation schemas must use Zod's strict object mode so unexpected sensitive fields are rejected.
