import pino from 'pino';

import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.passwordHash',
      'req.body.accessToken',
      'req.body.refreshToken',
      'req.body.idToken',
      'req.body.qrToken',
      'req.body.storePassword',
      'req.body.store_passwd',
      'req.body.apiKey',
      'req.body.clientSecret',
      'res.headers.set-cookie',
      'password',
      'passwordHash',
      'accessToken',
      'refreshToken',
      'qrToken',
      'storePassword',
      'store_passwd',
      'apiKey',
      'clientSecret',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'eventgate-api',
    environment: env.NODE_ENV,
  },
});
