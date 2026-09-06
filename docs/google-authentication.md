# Google authentication

EventGate accepts Google **ID tokens** only. It does not accept an unverified email address or Google access token as proof of identity.

| Method | Path                       | Authentication      | Purpose                                                            |
| ------ | -------------------------- | ------------------- | ------------------------------------------------------------------ |
| `POST` | `/api/v1/auth/google`      | No                  | Verifies a Google ID token and starts a session.                   |
| `POST` | `/api/v1/auth/google/link` | Bearer access token | Links a verified Google identity to the current EventGate account. |

Both endpoints accept a strict JSON body: `{ "idToken": "Google ID token" }`.

The server uses `google-auth-library` and `OAuth2Client.verifyIdToken({ idToken, audience })`. Google validates the token signature, issuer, audience, and expiry. EventGate additionally requires a stable `sub` subject and `email_verified: true`. The database stores `sub` as `AuthIdentity.providerSubject`; email is not used as the identity key.

When a verified Google subject is new, EventGate creates an `ATTENDEE` account. When its verified email matches an existing password account, the API returns `409 GOOGLE_IDENTITY_NOT_LINKED`. The account owner must first sign in using the existing password and then call `/api/v1/auth/google/link` with their Bearer token. This prevents email-only account takeover.

## GCP configuration

1. Create or select a Google Cloud project.
2. Configure the OAuth consent screen and add test users while the app is in testing mode.
3. Create an OAuth 2.0 **Web application** client ID in Google Cloud Console.
4. Add the real client origin that obtains the ID token to the client's authorized JavaScript origins.
5. Set `GOOGLE_CLIENT_ID` to that Web client ID in local and Render environment configuration. Do not commit client secrets or ID tokens.
6. Obtain a fresh Google ID token from that authorized client and send it to the endpoint over HTTPS.

Google documents that `verifyIdToken` checks the signature, `aud`, `iss`, and `exp` claims, and recommends storing `sub` because it is the stable Google-account identifier. See [Google’s server-side ID-token verification guide](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## Verification status

Unit tests use isolated fake Google clients to cover rejected audience, expired-token, and unverified-email cases. The account-collision integration test requires `TEST_DATABASE_URL`, as described in [password authentication](authentication.md). A real Google verification smoke test has **not** run because no GCP Web client ID or authorized test account has been provided.
