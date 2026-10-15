import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { env } from '../../config/env.js';
import { sendError } from '../responses/api-response.js';
import { verifyAccessToken } from '../../modules/auth/token.service.js';

const sharedOptions = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
};

export const apiRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 15 * 60 * 1000,
  limit: env.API_RATE_LIMIT_MAX,
  identifier: 'api',
  keyGenerator: async (request) => {
    const token = request.header('authorization')?.match(/^Bearer\s+(.+)$/iu)?.[1];
    if (token) {
      try {
        const claims = await verifyAccessToken(token);
        return claims.sessionFamilyId
          ? `session:${claims.userId}:${claims.sessionFamilyId}`
          : `user:${claims.userId}`;
      } catch {
        // Unverified tokens must never create arbitrary rate-limit buckets.
      }
    }
    return ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? 'unknown');
  },
  handler: (_request, response) => {
    sendError(response, 429, 'Too many requests', [
      { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
    ]);
  },
});

export const authRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  identifier: 'authentication',
  skipSuccessfulRequests: true,
  handler: (_request, response) => {
    sendError(response, 429, 'Too many authentication attempts', [
      {
        code: 'AUTH_RATE_LIMITED',
        message: 'Too many authentication attempts. Please try again later.',
      },
    ]);
  },
});

export const quickAccessRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  identifier: 'quick-access',
  handler: (_request, response) => {
    sendError(response, 429, 'Too many quick-access requests', [
      {
        code: 'QUICK_ACCESS_RATE_LIMITED',
        message: 'Please wait before starting another shared-account session.',
      },
    ]);
  },
});
