import { rateLimit } from 'express-rate-limit';

import { env } from '../../config/env.js';
import { sendError } from '../responses/api-response.js';

const sharedOptions = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
};

export const apiRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: 15 * 60 * 1000,
  limit: env.API_RATE_LIMIT_MAX,
  identifier: 'api',
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
  handler: (_request, response) => {
    sendError(response, 429, 'Too many authentication attempts', [
      {
        code: 'AUTH_RATE_LIMITED',
        message: 'Too many authentication attempts. Please try again later.',
      },
    ]);
  },
});
