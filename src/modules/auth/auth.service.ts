import argon2 from 'argon2';

import { UserRole, UserStatus } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError, isAppError } from '../../shared/errors/app-error.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import {
  createRefreshToken,
  createSessionId,
  hashRefreshToken,
  signAccessToken,
} from './token.service.js';

export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
};

export type AuthResult = {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
};

const toPublicUser = (user: PublicUser): PublicUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
});

export const createAuthResult = async (
  user: PublicUser,
  refreshToken: string,
): Promise<AuthResult> => ({
  user: toPublicUser(user),
  accessToken: await signAccessToken({ userId: user.id, role: user.role }),
  refreshToken,
  accessTokenExpiresIn: 15 * 60,
});

const invalidCredentials = (): AppError =>
  new AppError({
    statusCode: 401,
    code: 'INVALID_CREDENTIALS',
    message: 'Invalid email or password',
    errors: [{ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' }],
  });

const assertActiveUser = (user: { status: UserStatus; deletedAt: Date | null }): void => {
  if (user.status !== UserStatus.ACTIVE || user.deletedAt) {
    throw new AppError({
      statusCode: 403,
      code: 'ACCOUNT_INACTIVE',
      message: 'Account is not active',
      errors: [{ code: 'ACCOUNT_INACTIVE', message: 'This account cannot sign in.' }],
    });
  }
};

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

export const register = async (input: RegisterInput): Promise<AuthResult> => {
  const database = getPrisma();
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  const session = createRefreshToken();
  const sessionId = createSessionId();

  try {
    const user = await database.$transaction(async (transaction) => {
      const existingUser = await transaction.user.findUnique({ where: { email: input.email } });
      if (existingUser) {
        throw new AppError({
          statusCode: 409,
          code: 'EMAIL_ALREADY_REGISTERED',
          message: 'Email is already registered',
          errors: [
            {
              field: 'body.email',
              code: 'EMAIL_ALREADY_REGISTERED',
              message: 'Use another email.',
            },
          ],
        });
      }

      const createdUser = await transaction.user.create({
        data: {
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          role: UserRole.ATTENDEE,
        },
        select: { id: true, email: true, displayName: true, role: true },
      });

      await transaction.refreshSession.create({
        data: {
          id: sessionId,
          userId: createdUser.id,
          familyId: session.familyId,
          tokenHash: session.hash,
          expiresAt: session.expiresAt,
        },
      });

      await transaction.auditLog.create({
        data: {
          actorId: createdUser.id,
          action: 'AUTH_REGISTERED',
          entityType: 'USER',
          entityId: createdUser.id,
          metadata: { method: 'password' },
        },
      });

      return createdUser;
    });

    return createAuthResult(user, session.token);
  } catch (error) {
    if (isAppError(error)) {
      throw error;
    }

    if (isUniqueConstraintError(error)) {
      throw new AppError({
        statusCode: 409,
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'Email is already registered',
        errors: [
          { field: 'body.email', code: 'EMAIL_ALREADY_REGISTERED', message: 'Use another email.' },
        ],
        cause: error,
      });
    }

    throw error;
  }
};

export const login = async (input: LoginInput): Promise<AuthResult> => {
  const database = getPrisma();
  const user = await database.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      status: true,
      deletedAt: true,
      passwordHash: true,
    },
  });

  if (!user?.passwordHash) {
    throw invalidCredentials();
  }

  const passwordMatches = await argon2.verify(user.passwordHash, input.password).catch(() => false);
  if (!passwordMatches) {
    throw invalidCredentials();
  }

  assertActiveUser(user);
  return createSessionForUser(user, 'AUTH_LOGGED_IN', { method: 'password' });
};

export const createSessionForUser = async (
  user: PublicUser,
  action: string,
  metadata: Record<string, string>,
): Promise<AuthResult> => {
  const database = getPrisma();
  const session = createRefreshToken();
  const sessionId = createSessionId();

  await database.$transaction(async (transaction) => {
    await transaction.refreshSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        familyId: session.familyId,
        tokenHash: session.hash,
        expiresAt: session.expiresAt,
      },
    });
    await transaction.auditLog.create({
      data: {
        actorId: user.id,
        action,
        entityType: 'REFRESH_SESSION',
        entityId: sessionId,
        metadata,
      },
    });
  });

  return createAuthResult(user, session.token);
};

export const refresh = async (refreshToken: string): Promise<AuthResult> => {
  const database = getPrisma();
  const tokenHash = hashRefreshToken(refreshToken);
  const replacement = createRefreshToken();
  const replacementSessionId = createSessionId();
  const now = new Date();

  const user = await database.$transaction(async (transaction) => {
    const currentSession = await transaction.refreshSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            role: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!currentSession) {
      throw new AppError({
        statusCode: 401,
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid refresh token',
        errors: [{ code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid.' }],
      });
    }

    if (currentSession.revokedAt) {
      await transaction.refreshSession.updateMany({
        where: { familyId: currentSession.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.auditLog.create({
        data: {
          actorId: currentSession.userId,
          action: 'AUTH_REFRESH_REUSE_DETECTED',
          entityType: 'REFRESH_SESSION',
          entityId: currentSession.id,
          metadata: { familyId: currentSession.familyId },
        },
      });
      throw new AppError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_REUSED',
        message: 'Refresh token reuse detected',
        errors: [{ code: 'REFRESH_TOKEN_REUSED', message: 'Sign in again to continue.' }],
      });
    }

    if (currentSession.expiresAt <= now) {
      await transaction.refreshSession.updateMany({
        where: { familyId: currentSession.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      throw new AppError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired',
        errors: [{ code: 'REFRESH_TOKEN_EXPIRED', message: 'Sign in again to continue.' }],
      });
    }

    assertActiveUser(currentSession.user);

    const rotation = await transaction.refreshSession.updateMany({
      where: { id: currentSession.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, replacedBySessionId: replacementSessionId },
    });

    if (rotation.count !== 1) {
      await transaction.refreshSession.updateMany({
        where: { familyId: currentSession.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      throw new AppError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_REUSED',
        message: 'Refresh token reuse detected',
        errors: [{ code: 'REFRESH_TOKEN_REUSED', message: 'Sign in again to continue.' }],
      });
    }

    await transaction.refreshSession.create({
      data: {
        id: replacementSessionId,
        userId: currentSession.userId,
        familyId: currentSession.familyId,
        tokenHash: replacement.hash,
        expiresAt: replacement.expiresAt,
      },
    });
    await transaction.auditLog.create({
      data: {
        actorId: currentSession.userId,
        action: 'AUTH_REFRESH_ROTATED',
        entityType: 'REFRESH_SESSION',
        entityId: replacementSessionId,
        metadata: { replacedSessionId: currentSession.id },
      },
    });

    return currentSession.user;
  });

  return createAuthResult(user, replacement.token);
};

export const logout = async (refreshToken: string): Promise<void> => {
  const database = getPrisma();
  const tokenHash = hashRefreshToken(refreshToken);
  const now = new Date();

  await database.$transaction(async (transaction) => {
    const session = await transaction.refreshSession.findUnique({ where: { tokenHash } });
    if (!session || session.revokedAt) {
      return;
    }

    await transaction.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });
    await transaction.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'AUTH_LOGGED_OUT',
        entityType: 'REFRESH_SESSION',
        entityId: session.id,
      },
    });
  });
};
