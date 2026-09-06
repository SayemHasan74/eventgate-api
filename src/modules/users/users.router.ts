import { Router } from 'express';
import { z } from 'zod';
import { UserRole, UserStatus } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendSuccess } from '../../shared/responses/api-response.js';

const usersRouter = Router();
const profileSchema = z.object({ displayName: z.string().trim().min(2).max(120) }).strict();
const idSchema = z.object({ userId: z.string().uuid() }).strict();
const roleSchema = z.object({ role: z.enum([UserRole.ATTENDEE, UserRole.ORGANIZER]) }).strict();
const statusSchema = z
  .object({ status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]) })
  .strict();

usersRouter.get('/me', authenticate, async (request, response) => {
  sendSuccess(response, 200, 'Profile retrieved', request.auth);
});
usersRouter.patch(
  '/me',
  authenticate,
  validate({ body: profileSchema }),
  async (request, response) => {
    const user = await getPrisma().user.update({
      where: { id: request.auth.id },
      data: { displayName: request.body.displayName },
      select: { id: true, email: true, displayName: true, role: true },
    });
    sendSuccess(response, 200, 'Profile updated', user);
  },
);

const adminRouter = Router();
adminRouter.use(authenticate, authorize(UserRole.ADMIN));
adminRouter.get('/users', async (_request, response) => {
  const users = await getPrisma().user.findMany({
    select: { id: true, email: true, displayName: true, role: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  sendSuccess(response, 200, 'Users retrieved', users);
});
adminRouter.patch(
  '/users/:userId/role',
  validate({ params: idSchema, body: roleSchema }),
  async (request, response) => {
    const database = getPrisma();
    const userId = request.params.userId as string;
    const target = await database.user.findUnique({ where: { id: userId } });
    if (!target || target.deletedAt)
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'User not found',
        errors: [{ code: 'NOT_FOUND', message: 'User not found.' }],
      });
    if (target.role === UserRole.ORGANIZER && request.body.role === UserRole.ATTENDEE) {
      const activeEvents = await database.event.count({
        where: { organizerId: target.id, status: { in: ['DRAFT', 'PUBLISHED'] } },
      });
      if (activeEvents)
        throw new AppError({
          statusCode: 409,
          code: 'ORGANIZER_HAS_EVENTS',
          message: 'Organizer has nonterminal events',
          errors: [
            {
              code: 'ORGANIZER_HAS_EVENTS',
              message: 'Cancel or complete the organizer’s events first.',
            },
          ],
        });
    }
    const user = await database.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { role: request.body.role },
        select: { id: true, email: true, displayName: true, role: true, status: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: request.auth.id,
          action: 'USER_ROLE_CHANGED',
          entityType: 'USER',
          entityId: target.id,
          metadata: { from: target.role, to: request.body.role },
        },
      });
      return updated;
    });
    sendSuccess(response, 200, 'User role updated', user);
  },
);
adminRouter.patch(
  '/users/:userId/status',
  validate({ params: idSchema, body: statusSchema }),
  async (request, response) => {
    const database = getPrisma();
    const userId = request.params.userId as string;
    const target = await database.user.findUnique({ where: { id: userId } });
    if (!target || target.deletedAt)
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'User not found',
        errors: [{ code: 'NOT_FOUND', message: 'User not found.' }],
      });
    if (
      target.role === UserRole.ADMIN &&
      target.status === UserStatus.ACTIVE &&
      request.body.status === UserStatus.SUSPENDED
    ) {
      const count = await database.user.count({
        where: { role: UserRole.ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
      });
      if (count <= 1)
        throw new AppError({
          statusCode: 409,
          code: 'LAST_ACTIVE_ADMIN',
          message: 'Cannot suspend the last active admin',
          errors: [{ code: 'LAST_ACTIVE_ADMIN', message: 'Promote another active admin first.' }],
        });
    }
    const user = await database.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { status: request.body.status },
        select: { id: true, email: true, displayName: true, role: true, status: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: request.auth.id,
          action: 'USER_STATUS_CHANGED',
          entityType: 'USER',
          entityId: target.id,
          metadata: { from: target.status, to: request.body.status },
        },
      });
      return updated;
    });
    sendSuccess(response, 200, 'User status updated', user);
  },
);
adminRouter.delete('/users/:userId', validate({ params: idSchema }), async (request, response) => {
  const database = getPrisma();
  const userId = request.params.userId as string;
  const target = await database.user.findUnique({ where: { id: userId } });
  if (!target || target.deletedAt)
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'User not found',
      errors: [{ code: 'NOT_FOUND', message: 'User not found.' }],
    });
  if (target.role === UserRole.ADMIN && target.status === UserStatus.ACTIVE) {
    const count = await database.user.count({
      where: { role: UserRole.ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
    });
    if (count <= 1)
      throw new AppError({
        statusCode: 409,
        code: 'LAST_ACTIVE_ADMIN',
        message: 'Cannot delete the last active admin',
        errors: [{ code: 'LAST_ACTIVE_ADMIN', message: 'Promote another active admin first.' }],
      });
  }
  await database.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { status: UserStatus.DELETED, deletedAt: new Date() },
    });
    await tx.refreshSession.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: request.auth.id,
        action: 'USER_DELETED',
        entityType: 'USER',
        entityId: target.id,
      },
    });
  });
  sendSuccess(response, 200, 'User deleted', null);
});

export { adminRouter, usersRouter };
