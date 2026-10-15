import { z } from 'zod';
import { authRateLimiter } from '../../shared/security/rate-limit.js';
import { changePassword } from '../auth/password.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';

import {
  editProfile,
  editUserRole,
  editUserStatus,
  readProfile,
  readUsers,
  removeUser,
} from './users.controller.js';
import {
  profileSchema,
  userIdParamsSchema,
  userListQuerySchema,
  userRoleSchema,
  userStatusSchema,
  userDeleteSchema,
} from './users.schemas.js';

const usersRouter = Router();
usersRouter.use(authenticate);
usersRouter.get('/me', readProfile);
usersRouter.patch('/me', validate({ body: profileSchema }), editProfile);

usersRouter.post(
  '/me/password',
  authRateLimiter,
  validate({
    body: z
      .object({
        currentPassword: z.string().min(1).max(128),
        password: z.string().min(12).max(128),
      })
      .strict(),
  }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Password changed',
      await changePassword(r.auth.id, r.body.currentPassword, r.body.password),
    ),
);
const adminRouter = Router();
adminRouter.use(authenticate, authorize(UserRole.ADMIN));
adminRouter.get('/users', validate({ query: userListQuerySchema }), readUsers);
adminRouter.patch(
  '/users/:userId/role',
  validate({ params: userIdParamsSchema, body: userRoleSchema }),
  editUserRole,
);
adminRouter.patch(
  '/users/:userId/status',
  validate({ params: userIdParamsSchema, body: userStatusSchema }),
  editUserStatus,
);
adminRouter.delete(
  '/users/:userId',
  validate({ params: userIdParamsSchema, body: userDeleteSchema }),
  removeUser,
);

export { adminRouter, usersRouter };
