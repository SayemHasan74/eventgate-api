import { EventStatus, Prisma, UserRole, UserStatus } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import type { ProfileInput, UserListQuery } from './users.schemas.js';

export const userSummarySelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  status: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const userNotFound = (): AppError =>
  new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'User not found',
    errors: [{ code: 'NOT_FOUND', message: 'User not found.' }],
  });

const conflict = (code: string, message: string, detail: string): AppError =>
  new AppError({
    statusCode: 409,
    code,
    message,
    errors: [{ code, message: detail }],
  });

const findActiveUser = async (tx: Prisma.TransactionClient, userId: string) => {
  const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw userNotFound();
  return user;
};

const protectLastActiveAdmin = async (
  tx: Prisma.TransactionClient,
  user: { role: UserRole; status: UserStatus },
) => {
  if (user.role !== UserRole.ADMIN || user.status !== UserStatus.ACTIVE) return;

  const activeAdminCount = await tx.user.count({
    where: { role: UserRole.ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
  });
  if (activeAdminCount <= 1) {
    throw conflict(
      'LAST_ACTIVE_ADMIN',
      'Cannot modify the last active admin',
      'Create another active admin through secure seeding first.',
    );
  }
};

export const getProfile = async (userId: string) => {
  const user = await getPrisma().user.findFirst({
    where: { id: userId, deletedAt: null },
    select: userSummarySelect,
  });
  if (!user) throw userNotFound();
  return user;
};

export const updateProfile = async (userId: string, input: ProfileInput) =>
  getPrisma().user.update({
    where: { id: userId },
    data: { displayName: input.displayName },
    select: userSummarySelect,
  });

export const listUsers = async (query: UserListQuery) => {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: 'insensitive' } },
            { displayName: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const skip = (query.page - 1) * query.limit;
  const database = getPrisma();
  const [users, total] = await database.$transaction([
    database.user.findMany({
      where,
      select: userSummarySelect,
      orderBy: { createdAt: 'desc' },
      skip,
      take: query.limit,
    }),
    database.user.count({ where }),
  ]);

  return { users, page: query.page, limit: query.limit, total };
};

export const changeUserRole = async (actorId: string, userId: string, role: UserRole) =>
  getPrisma().$transaction(
    async (tx) => {
      const target = await findActiveUser(tx, userId);
      if (target.role === UserRole.ADMIN) {
        throw conflict(
          'ADMIN_ROLE_PROTECTED',
          'Administrator roles cannot be changed here',
          'Administrator accounts are managed through secure seeding only.',
        );
      }
      if (target.role === role) return { ...target, changed: false };

      if (target.role === UserRole.ORGANIZER && role === UserRole.ATTENDEE) {
        const nonterminalEventCount = await tx.event.count({
          where: {
            organizerId: target.id,
            deletedAt: null,
            status: { in: [EventStatus.DRAFT, EventStatus.PUBLISHED] },
          },
        });
        if (nonterminalEventCount > 0) {
          throw conflict(
            'ORGANIZER_HAS_EVENTS',
            'Organizer has nonterminal events',
            'Cancel or complete the organizer’s events first.',
          );
        }
      }

      const updated = await tx.user.update({
        where: { id: target.id },
        data: { role },
        select: userSummarySelect,
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'USER_ROLE_CHANGED',
          entityType: 'USER',
          entityId: target.id,
          metadata: { from: target.role, to: role },
        },
      });
      return { ...updated, changed: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

export const changeUserStatus = async (actorId: string, userId: string, status: UserStatus) =>
  getPrisma().$transaction(
    async (tx) => {
      const target = await findActiveUser(tx, userId);
      if (target.status === status) return { ...target, changed: false };
      if (status === UserStatus.SUSPENDED) await protectLastActiveAdmin(tx, target);

      const updated = await tx.user.update({
        where: { id: target.id },
        data: { status },
        select: userSummarySelect,
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'USER_STATUS_CHANGED',
          entityType: 'USER',
          entityId: target.id,
          metadata: { from: target.status, to: status },
        },
      });
      return { ...updated, changed: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

export const softDeleteUser = async (actorId: string, userId: string) =>
  getPrisma().$transaction(
    async (tx) => {
      const target = await findActiveUser(tx, userId);
      await protectLastActiveAdmin(tx, target);
      const deletedAt = new Date();
      await tx.user.update({
        where: { id: target.id },
        data: { status: UserStatus.DELETED, deletedAt },
      });
      await tx.refreshSession.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: deletedAt },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'USER_DELETED',
          entityType: 'USER',
          entityId: target.id,
          metadata: { previousStatus: target.status },
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
