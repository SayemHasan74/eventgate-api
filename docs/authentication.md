# Password authentication and sessions

## Endpoints

| Method | Path                    | Purpose                                               |
| ------ | ----------------------- | ----------------------------------------------------- |
| `POST` | `/api/v1/auth/register` | Creates an `ATTENDEE` account and starts a session.   |
| `POST` | `/api/v1/auth/login`    | Signs in an existing password account.                |
| `POST` | `/api/v1/auth/refresh`  | Rotates a refresh token and returns a new token pair. |
| `POST` | `/api/v1/auth/logout`   | Revokes the supplied refresh session.                 |

Registration accepts only `email`, `displayName`, and `password`. The strict Zod schema rejects caller-supplied roles, account status, ownership fields, and other unknown values. Passwords must be 12–128 characters and are stored as Argon2id hashes.

Every successful registration and login returns this shape inside the standard API envelope:

```json
{
  "user": {
    "id": "uuid",
    "email": "attendee@example.com",
    "displayName": "Attendee",
    "role": "ATTENDEE"
  },
  "accessToken": "signed-jwt",
  "refreshToken": "opaque-random-token",
  "accessTokenExpiresIn": 900
}
```

Access tokens are HS256 JWTs with issuer and audience checks and expire after 15 minutes. Refresh tokens are random 256-bit opaque values, expire after seven days, and are stored only as SHA-256 hashes. Each refresh creates a replacement session in the same family and revokes the old session. Reusing an already-rotated token revokes every still-active session in that family and requires a new sign-in.

Logout is intentionally idempotent: an unknown or already-revoked refresh token still returns `200` without revealing session state.

## Tests

`npm test` always runs the JWT unit test. Authentication integration tests require `TEST_DATABASE_URL` for a dedicated PostgreSQL database whose URL contains `eventgate_test`; otherwise they are explicitly skipped. Before running them, apply the Prisma migration to that dedicated database:

```bash
TEST_DATABASE_URL='postgresql://eventgate:eventgate@localhost:5432/eventgate_test?schema=public' \
DATABASE_URL='postgresql://eventgate:eventgate@localhost:5432/eventgate_test?schema=public' \
npm run db:migrate

TEST_DATABASE_URL='postgresql://eventgate:eventgate@localhost:5432/eventgate_test?schema=public' npm test
```
