import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

const accessTokenLifetimeSeconds = 15 * 60;
const refreshTokenLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1000;
const issuer = 'eventgate-api';
const audience = 'eventgate-api-client';

const getAccessSecret = (): Uint8Array => {
  if (!env.JWT_ACCESS_SECRET) {
    throw new AppError({
      statusCode: 503,
      code: 'AUTH_CONFIGURATION_ERROR',
      message: 'Authentication is not configured',
      errors: [{ code: 'AUTH_CONFIGURATION_ERROR', message: 'JWT access secret is missing.' }],
    });
  }

  return new TextEncoder().encode(env.JWT_ACCESS_SECRET);
};

export type AccessTokenClaims = {
  userId: string;
  role: string;
};

export const signAccessToken = async (claims: AccessTokenClaims): Promise<string> =>
  new SignJWT({ role: claims.role, tokenType: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${accessTokenLifetimeSeconds}s`)
    .sign(getAccessSecret());

export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  try {
    const { payload } = await jwtVerify(token, getAccessSecret(), { issuer, audience });

    if (payload.tokenType !== 'access' || !payload.sub || typeof payload.role !== 'string') {
      throw new Error('Invalid access-token claims.');
    }

    return { userId: payload.sub, role: payload.role };
  } catch (cause) {
    if (cause instanceof AppError) {
      throw cause;
    }

    throw new AppError({
      statusCode: 401,
      code: 'INVALID_ACCESS_TOKEN',
      message: 'Invalid or expired access token',
      errors: [{ code: 'INVALID_ACCESS_TOKEN', message: 'Bearer token is invalid or expired.' }],
      cause,
    });
  }
};

export const createRefreshToken = (): {
  token: string;
  hash: string;
  familyId: string;
  expiresAt: Date;
} => {
  const token = randomBytes(32).toString('base64url');

  return {
    token,
    hash: hashRefreshToken(token),
    familyId: randomUUID(),
    expiresAt: new Date(Date.now() + refreshTokenLifetimeMilliseconds),
  };
};

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const createSessionId = (): string => randomUUID();
