import { OAuth2Client } from 'google-auth-library';

import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

type GooglePayload = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
};

type GoogleIdTokenClient = {
  verifyIdToken(input: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): GooglePayload | undefined }>;
};

export type VerifiedGoogleIdentity = {
  subject: string;
  email: string;
  displayName: string;
};

export class GoogleTokenVerifier {
  public constructor(private readonly client: GoogleIdTokenClient = new OAuth2Client()) {}

  public async verify(idToken: string): Promise<VerifiedGoogleIdentity> {
    if (!env.GOOGLE_CLIENT_ID) {
      throw new AppError({
        statusCode: 503,
        code: 'GOOGLE_AUTH_NOT_CONFIGURED',
        message: 'Google authentication is not configured',
        errors: [{ code: 'GOOGLE_AUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID is missing.' }],
      });
    }

    let payload: GooglePayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (cause) {
      throw new AppError({
        statusCode: 401,
        code: 'INVALID_GOOGLE_ID_TOKEN',
        message: 'Invalid or expired Google ID token',
        errors: [
          { code: 'INVALID_GOOGLE_ID_TOKEN', message: 'Google ID token verification failed.' },
        ],
        cause,
      });
    }

    if (!payload?.sub || !payload.email) {
      throw new AppError({
        statusCode: 401,
        code: 'INVALID_GOOGLE_ID_TOKEN',
        message: 'Invalid Google ID token claims',
        errors: [
          { code: 'INVALID_GOOGLE_ID_TOKEN', message: 'Google subject and email are required.' },
        ],
      });
    }

    if (payload.email_verified !== true) {
      throw new AppError({
        statusCode: 401,
        code: 'GOOGLE_EMAIL_NOT_VERIFIED',
        message: 'Google email is not verified',
        errors: [
          {
            code: 'GOOGLE_EMAIL_NOT_VERIFIED',
            message: 'Use a Google account with a verified email.',
          },
        ],
      });
    }

    const email = payload.email.trim().toLowerCase();
    const fallbackName = email.split('@')[0] ?? 'Google user';

    return {
      subject: payload.sub,
      email,
      displayName: (payload.name?.trim() || fallbackName).slice(0, 120),
    };
  }
}

export const googleTokenVerifier = new GoogleTokenVerifier();
