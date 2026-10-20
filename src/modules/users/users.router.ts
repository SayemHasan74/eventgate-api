import { z } from 'zod';
import { isQuickAccessAccount } from '../../shared/security/quick-access.js';
import { authRateLimiter } from '../../shared/security/rate-limit.js';
import { changePassword } from '../auth/password.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
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
// Authentication already reads current role, status and token version from the database.
// Identity checks need no second profile/Google-identity query.
usersRouter.get('/me/identity', (request, response) => {
  sendSuccess(response, 200, 'Identity retrieved', {
    ...request.auth,
    isQuickAccess: isQuickAccessAccount(request.auth),
  });
});
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
