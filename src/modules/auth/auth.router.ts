import { z } from 'zod';
import { requestPasswordReset, resetPassword } from './password.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimiter, quickAccessRateLimiter } from '../../shared/security/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import {
  loginController,
  logoutController,
  googleLinkController,
  googleLoginController,
  demoLoginController,
  googleConfigController,
  refreshController,
  registerController,
} from './auth.controller.js';
import {
  googleIdTokenSchema,
  demoLoginSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from './auth.schemas.js';

const authRouter = Router();

authRouter.post(
  '/register',
  authRateLimiter,
  validate({ body: registerSchema }),
  registerController,
);
authRouter.post('/login', authRateLimiter, validate({ body: loginSchema }), loginController);
authRouter.post(
  '/demo',
  quickAccessRateLimiter,
  validate({ body: demoLoginSchema }),
  demoLoginController,
);
authRouter.get('/google/config', googleConfigController);
authRouter.post(
  '/google',
  authRateLimiter,
  validate({ body: googleIdTokenSchema }),
  googleLoginController,
);
authRouter.post(
  '/google/link',
  authenticate,
  authRateLimiter,
  validate({ body: googleIdTokenSchema }),
  googleLinkController,
);
authRouter.post('/refresh', validate({ body: refreshSchema }), refreshController);
authRouter.post('/logout', validate({ body: logoutSchema }), logoutController);

authRouter.post(
  '/request-password-reset',
  authRateLimiter,
  validate({
    body: z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict(),
  }),
  async (r, s) =>
    sendSuccess(s, 202, 'Recovery request received', await requestPasswordReset(r.body.email)),
);
authRouter.post(
  '/reset-password',
  authRateLimiter,
  validate({
    body: z
      .object({
        token: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
        password: z.string().min(12).max(128),
      })
      .strict(),
  }),
  async (r, s) =>
    sendSuccess(s, 200, 'Password changed', await resetPassword(r.body.token, r.body.password)),
);
export { authRouter };
