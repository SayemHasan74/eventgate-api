import argon2 from 'argon2';

import { UserRole, UserStatus } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { AppError, isAppError } from '../../shared/errors/app-error.js';
import type { DemoLoginInput, LoginInput, RegisterInput } from './auth.schemas.js';
import { isQuickAccessAccount, quickAccessEmail } from '../../shared/security/quick-access.js';
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
  isQuickAccess?: boolean;
  tokenVersion?: number;
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
  isQuickAccess: isQuickAccessAccount(user),
});

export const createAuthResult = async (
  user: PublicUser,
  refreshToken: string,
  sessionFamilyId?: string,
): Promise<AuthResult> => ({
  user: toPublicUser(user),
  accessToken: await signAccessToken({
    userId: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
    ...(isQuickAccessAccount(user) && sessionFamilyId ? { sessionFamilyId } : {}),
  }),
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

    return createAuthResult(user, session.token, session.familyId);
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

export const loginDemo = async ({ role }: DemoLoginInput): Promise<AuthResult> => {
  if (env.PUBLIC_DEMO_ENABLED !== 'true') {
    throw new AppError({
      statusCode: 404,
      code: 'DEMO_LOGIN_DISABLED',
      message: 'Demo login is not enabled',
      errors: [{ code: 'DEMO_LOGIN_DISABLED', message: 'Demo login is unavailable.' }],
    });
  }

  const email = quickAccessEmail(role);
  if (!email) {
    throw new AppError({
      statusCode: 503,
      code: 'DEMO_LOGIN_NOT_CONFIGURED',
      message: 'Demo login is not configured',
      errors: [{ code: 'DEMO_LOGIN_NOT_CONFIGURED', message: 'A demo account is missing.' }],
    });
  }

  const user = await getPrisma().user.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true, role: true, status: true, deletedAt: true },
  });
  if (!user || user.role !== role) throw invalidCredentials();
  assertActiveUser(user);
  return createSessionForUser(user, 'AUTH_DEMO_LOGGED_IN', { method: 'demo', role });
};

export const createSessionForUser = async (
  user: PublicUser,
  action: string,
  metadata: Record<string, string>,
): Promise<AuthResult> => {
  const session = createRefreshToken();
  const sessionId = createSessionId();

  const activeUser = await serializableTransaction(async (transaction) => {
    const currentUser = await transaction.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        tokenVersion: true,
        role: true,
        status: true,
        deletedAt: true,
      },
    });
    assertActiveUser(currentUser);
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
    return currentUser;
  });

  return createAuthResult(activeUser, session.token, session.familyId);
};

export const refresh = async (refreshToken: string): Promise<AuthResult> => {
  const tokenHash = hashRefreshToken(refreshToken);
  const replacement = createRefreshToken();
  const replacementSessionId = createSessionId();
  const now = new Date();

  type RefreshOutcome =
    | { user: PublicUser; familyId: string; error?: never }
    | { error: AppError; user?: never; familyId?: never };
  const outcome = await serializableTransaction<RefreshOutcome>(async (transaction) => {
    const currentSession = await transaction.refreshSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            tokenVersion: true,
            role: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!currentSession) {
      return {
        error: new AppError({
          statusCode: 401,
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Invalid refresh token',
          errors: [{ code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid.' }],
        }),
      };
    }

    const revokeFamily = async (action: string) => {
      await transaction.refreshSession.updateMany({
        where: { familyId: currentSession.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.auditLog.create({
        data: {
          actorId: currentSession.userId,
          action,
          entityType: 'REFRESH_SESSION',
          entityId: currentSession.id,
          metadata: { familyId: currentSession.familyId },
        },
      });
    };

    if (currentSession.revokedAt) {
      await revokeFamily('AUTH_REFRESH_REUSE_DETECTED');
      return {
        error: new AppError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_REUSED',
          message: 'Refresh token reuse detected',
          errors: [{ code: 'REFRESH_TOKEN_REUSED', message: 'Sign in again to continue.' }],
        }),
      };
    }

    // The original family row is retained, so no schema migration is needed.
    // This also caps previously rolling families at their original seven days.
    const firstSession = await transaction.refreshSession.findFirstOrThrow({
      where: { familyId: currentSession.familyId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { createdAt: true, expiresAt: true },
    });
    const absoluteExpiry = new Date(
      Math.min(
        currentSession.expiresAt.getTime(),
        firstSession.expiresAt.getTime(),
        firstSession.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000,
      ),
    );
    if (absoluteExpiry <= now) {
      await revokeFamily('AUTH_REFRESH_EXPIRED');
      return {
        error: new AppError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_EXPIRED',
          message: 'Refresh token has expired',
          errors: [{ code: 'REFRESH_TOKEN_EXPIRED', message: 'Sign in again to continue.' }],
        }),
      };
    }

    if (currentSession.user.status !== UserStatus.ACTIVE || currentSession.user.deletedAt) {
      await revokeFamily('AUTH_REFRESH_ACCOUNT_INACTIVE');
      return {
        error: new AppError({
          statusCode: 403,
          code: 'ACCOUNT_INACTIVE',
          message: 'Account is not active',
          errors: [{ code: 'ACCOUNT_INACTIVE', message: 'This account cannot sign in.' }],
        }),
      };
    }

    const rotation = await transaction.refreshSession.updateMany({
      where: { id: currentSession.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, replacedBySessionId: replacementSessionId },
    });

    if (rotation.count !== 1) {
      await revokeFamily('AUTH_REFRESH_REUSE_DETECTED');
      return {
        error: new AppError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_REUSED',
          message: 'Refresh token reuse detected',
          errors: [{ code: 'REFRESH_TOKEN_REUSED', message: 'Sign in again to continue.' }],
        }),
      };
    }

    await transaction.refreshSession.create({
      data: {
        id: replacementSessionId,
        userId: currentSession.userId,
        familyId: currentSession.familyId,
        tokenHash: replacement.hash,
        expiresAt: absoluteExpiry,
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

    return { user: currentSession.user, familyId: currentSession.familyId };
  });

  // Throw only after security writes have committed.
  if (outcome.error) throw outcome.error;
  return createAuthResult(outcome.user, replacement.token, outcome.familyId);
};

export const logout = async (refreshToken: string): Promise<void> => {
  const tokenHash = hashRefreshToken(refreshToken);
  const now = new Date();

  await serializableTransaction(async (transaction) => {
    const session = await transaction.refreshSession.findUnique({ where: { tokenHash } });
    if (!session) {
      return;
    }

    const revoked = await transaction.refreshSession.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count === 0) return;
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
