import 'dotenv/config';

import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  SSLCOMMERZ_STORE_ID: z.string().min(1).optional(),
  SSLCOMMERZ_STORE_PASSWORD: z.string().min(1).optional(),
  SSLCOMMERZ_IS_LIVE: z.enum(['true', 'false']).optional(),
  SSLCOMMERZ_SUCCESS_URL: z.string().url().optional(),
  SSLCOMMERZ_FAIL_URL: z.string().url().optional(),
  SSLCOMMERZ_CANCEL_URL: z.string().url().optional(),
  SSLCOMMERZ_IPN_URL: z.string().url().optional(),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const details = parsedEnvironment.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');

  throw new Error(`Invalid environment configuration. ${details}`);
}

export const env = parsedEnvironment.data;
