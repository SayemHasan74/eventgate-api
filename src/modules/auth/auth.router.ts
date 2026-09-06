import { Router } from 'express';

import { authRateLimiter } from '../../shared/security/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import {
  loginController,
  logoutController,
  refreshController,
  registerController,
} from './auth.controller.js';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from './auth.schemas.js';

const authRouter = Router();

authRouter.use(authRateLimiter);
authRouter.post('/register', validate({ body: registerSchema }), registerController);
authRouter.post('/login', validate({ body: loginSchema }), loginController);
authRouter.post('/refresh', validate({ body: refreshSchema }), refreshController);
authRouter.post('/logout', validate({ body: logoutSchema }), logoutController);

export { authRouter };
