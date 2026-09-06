import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimiter } from '../../shared/security/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import {
  loginController,
  logoutController,
  googleLinkController,
  googleLoginController,
  refreshController,
  registerController,
} from './auth.controller.js';
import {
  googleIdTokenSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from './auth.schemas.js';

const authRouter = Router();

authRouter.use(authRateLimiter);
authRouter.post('/register', validate({ body: registerSchema }), registerController);
authRouter.post('/login', validate({ body: loginSchema }), loginController);
authRouter.post('/google', validate({ body: googleIdTokenSchema }), googleLoginController);
authRouter.post(
  '/google/link',
  authenticate,
  validate({ body: googleIdTokenSchema }),
  googleLinkController,
);
authRouter.post('/refresh', validate({ body: refreshSchema }), refreshController);
authRouter.post('/logout', validate({ body: logoutSchema }), logoutController);

export { authRouter };
