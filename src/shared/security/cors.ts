import type { CorsOptions } from 'cors';

import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

const allowedOrigins = new Set(
  env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(
      new AppError({
        statusCode: 403,
        code: 'CORS_ORIGIN_NOT_ALLOWED',
        message: 'Origin is not allowed',
        errors: [
          {
            code: 'CORS_ORIGIN_NOT_ALLOWED',
            message: 'This origin is not allowed to call the API.',
          },
        ],
      }),
    );
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
  exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After', 'X-Request-Id'],
  maxAge: 600,
  optionsSuccessStatus: 204,
};
