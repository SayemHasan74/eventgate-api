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
} from './users.schemas.js';

const usersRouter = Router();
usersRouter.use(authenticate);
usersRouter.get('/me', readProfile);
usersRouter.patch('/me', validate({ body: profileSchema }), editProfile);

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
adminRouter.delete('/users/:userId', validate({ params: userIdParamsSchema }), removeUser);

export { adminRouter, usersRouter };
