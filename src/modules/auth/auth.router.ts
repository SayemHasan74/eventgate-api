import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimiter } from '../../shared/security/rate-limit.js';
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
authRouter.post('/demo', authRateLimiter, validate({ body: demoLoginSchema }), demoLoginController);
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

export { authRouter };
