import {
  AuthProvider,
  EventStatus,
  type Prisma,
  UserRole,
  UserStatus,
} from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { isQuickAccessAccount } from '../../shared/security/quick-access.js';

import type { ProfileInput, UserListQuery } from './users.schemas.js';
import { dateRange } from '../../shared/responses/read-contracts.js';
import { writeNotification } from '../notifications/notifications.service.js';

export const userSummarySelect = {
  id: true,
  email: true,
  displayName: true,
  phone: true,
  address: true,
  city: true,
  postalCode: true,
  country: true,
  role: true,
  status: true,
  createdAt: true,
  emailVerifiedAt: true,
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
    select: {
      ...userSummarySelect,
      passwordHash: true,
      identities: { where: { provider: AuthProvider.GOOGLE }, select: { id: true }, take: 1 },
    },
  });
  if (!user) throw userNotFound();
  const { identities, passwordHash, ...profile } = user;
  return {
    ...profile,
    googleLinked: identities.length > 0,
    passwordLoginEnabled: !!passwordHash,
    isQuickAccess: isQuickAccessAccount(profile),
  };
};

export const updateProfile = async (userId: string, input: ProfileInput) => {
  const identity = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (isQuickAccessAccount(identity))
    throw new AppError({
      statusCode: 403,
      code: 'SHARED_ACCOUNT_PROTECTED',
      message: 'Profile and contact changes are disabled for the shared quick-login account.',
    });
  await getPrisma().user.update({
    where: { id: userId },
    data: Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Prisma.UserUpdateInput,
    select: userSummarySelect,
  });
  return getProfile(userId);
};

export const listUsers = async (query: UserListQuery) => {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.startAfter || query.startBefore ? { createdAt: dateRange(query) } : {}),
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: query.limit,
    }),
    database.user.count({ where }),
  ]);

  return { users, page: query.page, limit: query.limit, total };
};

export const changeUserRole = async (
  actorId: string,
  userId: string,
  role: UserRole,
  reason?: string,
) =>
  serializableTransaction(async (tx) => {
    const target = await findActiveUser(tx, userId);
    if (target.role === UserRole.ADMIN) {
      throw conflict(
        'ADMIN_ROLE_PROTECTED',
        'Administrator roles cannot be changed here',
        'Administrator accounts are managed through secure seeding only.',
      );
    }
    if (target.role === role) {
      const safeUser = await tx.user.findUniqueOrThrow({
        where: { id: target.id },
        select: userSummarySelect,
      });
      return { ...safeUser, changed: false };
    }

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
    const audit = await tx.auditLog.create({
      data: {
        actorId,
        action: 'USER_ROLE_CHANGED',
        entityType: 'USER',
        entityId: target.id,
        metadata: { from: target.role, to: role, ...(reason ? { reason } : {}) },
      },
    });
    await writeNotification(tx, {
      userId: target.id,
      type: 'ROLE_CHANGED',
      title: 'Your EventGate role changed',
      body: `Your role changed from ${target.role} to ${role}. Your current account opens the matching workspace.`,
      actionPath: role === 'ORGANIZER' ? '/organizer' : '/account',
      sourceKey: `role-change:${audit.id}`,
    });
    return { ...updated, changed: true };
  });

export const changeUserStatus = async (
  actorId: string,
  userId: string,
  status: UserStatus,
  reason?: string,
) =>
  serializableTransaction(async (tx) => {
    const target = await findActiveUser(tx, userId);
    if (target.status === status) {
      const safeUser = await tx.user.findUniqueOrThrow({
        where: { id: target.id },
        select: userSummarySelect,
      });
      return { ...safeUser, changed: false };
    }
    if (status === UserStatus.SUSPENDED) await protectLastActiveAdmin(tx, target);
    if (actorId === userId && status !== UserStatus.ACTIVE) {
      throw conflict(
        'SELF_ACTION_FORBIDDEN',
        'Cannot deactivate your own account',
        'Ask another administrator to manage this account.',
      );
    }

    const updated = await tx.user.update({
      where: { id: target.id },
      data: { status },
      select: userSummarySelect,
    });
    if (status !== UserStatus.ACTIVE) {
      await tx.refreshSession.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'USER_STATUS_CHANGED',
        entityType: 'USER',
        entityId: target.id,
        metadata: { from: target.status, to: status, ...(reason ? { reason } : {}) },
      },
    });
    return { ...updated, changed: true };
  });

export const softDeleteUser = async (actorId: string, userId: string, reason?: string) =>
  serializableTransaction(async (tx) => {
    const target = await findActiveUser(tx, userId);
    await protectLastActiveAdmin(tx, target);
    if (actorId === userId) {
      throw conflict(
        'SELF_ACTION_FORBIDDEN',
        'Cannot delete your own account',
        'Ask another administrator to manage this account.',
      );
    }
    if (target.role === UserRole.ORGANIZER) {
      const eventCount = await tx.event.count({
        where: {
          organizerId: target.id,
          deletedAt: null,
          status: { in: [EventStatus.DRAFT, EventStatus.PUBLISHED] },
        },
      });
      if (eventCount > 0) {
        throw conflict(
          'ORGANIZER_HAS_EVENTS',
          'Organizer has nonterminal events',
          'Cancel or complete the organizer’s events first.',
        );
      }
    }
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
        metadata: { previousStatus: target.status, ...(reason ? { reason } : {}) },
      },
    });
  });
