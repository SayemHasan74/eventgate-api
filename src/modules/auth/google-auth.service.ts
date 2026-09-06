import { AuthProvider, UserRole, UserStatus } from '../../generated/prisma/client.js';
import type { VerifiedGoogleIdentity } from '../../integrations/google/google-token-verifier.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError, isAppError } from '../../shared/errors/app-error.js';
import { createRefreshToken, createSessionId } from './token.service.js';
import {
  createAuthResult,
  createSessionForUser,
  type AuthResult,
  type PublicUser,
} from './auth.service.js';

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

export const loginWithGoogle = async (identity: VerifiedGoogleIdentity): Promise<AuthResult> => {
  const database = getPrisma();
  const existingIdentity = await database.authIdentity.findUnique({
    where: {
      provider_providerSubject: {
        provider: AuthProvider.GOOGLE,
        providerSubject: identity.subject,
      },
    },
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

  if (existingIdentity) {
    assertActiveUser(existingIdentity.user);
    await database.authIdentity.update({
      where: { id: existingIdentity.id },
      data: { providerEmail: identity.email },
    });
    return createSessionForUser(existingIdentity.user, 'AUTH_LOGGED_IN', { method: 'google' });
  }

  const existingEmailAccount = await database.user.findUnique({ where: { email: identity.email } });
  if (existingEmailAccount) {
    throw new AppError({
      statusCode: 409,
      code: 'GOOGLE_IDENTITY_NOT_LINKED',
      message: 'Google identity is not linked to this account',
      errors: [
        {
          code: 'GOOGLE_IDENTITY_NOT_LINKED',
          message:
            'Sign in with your existing account, then link Google from an authenticated request.',
        },
      ],
    });
  }

  const refreshSession = createRefreshToken();
  const refreshSessionId = createSessionId();

  try {
    const user = await database.$transaction(async (transaction) => {
      const createdUser = await transaction.user.create({
        data: {
          email: identity.email,
          displayName: identity.displayName,
          role: UserRole.ATTENDEE,
          identities: {
            create: {
              provider: AuthProvider.GOOGLE,
              providerSubject: identity.subject,
              providerEmail: identity.email,
            },
          },
        },
        select: { id: true, email: true, displayName: true, role: true },
      });

      await transaction.refreshSession.create({
        data: {
          id: refreshSessionId,
          userId: createdUser.id,
          familyId: refreshSession.familyId,
          tokenHash: refreshSession.hash,
          expiresAt: refreshSession.expiresAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorId: createdUser.id,
          action: 'AUTH_REGISTERED',
          entityType: 'USER',
          entityId: createdUser.id,
          metadata: { method: 'google' },
        },
      });

      return createdUser;
    });

    return createAuthResult(user, refreshSession.token);
  } catch (error) {
    if (isAppError(error)) {
      throw error;
    }

    if (isUniqueConstraintError(error)) {
      throw new AppError({
        statusCode: 409,
        code: 'GOOGLE_ACCOUNT_CONFLICT',
        message: 'Google account cannot be used to create a session',
        errors: [
          {
            code: 'GOOGLE_ACCOUNT_CONFLICT',
            message: 'Sign in with your existing account and link Google.',
          },
        ],
        cause: error,
      });
    }

    throw error;
  }
};

export const linkGoogleIdentity = async (
  user: PublicUser,
  identity: VerifiedGoogleIdentity,
): Promise<{ alreadyLinked: boolean }> => {
  const database = getPrisma();

  return database.$transaction(async (transaction) => {
    const existingIdentity = await transaction.authIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: AuthProvider.GOOGLE,
          providerSubject: identity.subject,
        },
      },
    });

    if (existingIdentity?.userId === user.id) {
      await transaction.authIdentity.update({
        where: { id: existingIdentity.id },
        data: { providerEmail: identity.email },
      });
      return { alreadyLinked: true };
    }

    if (existingIdentity) {
      throw new AppError({
        statusCode: 409,
        code: 'GOOGLE_IDENTITY_IN_USE',
        message: 'Google identity is already linked',
        errors: [{ code: 'GOOGLE_IDENTITY_IN_USE', message: 'Use a different Google account.' }],
      });
    }

    await transaction.authIdentity.create({
      data: {
        userId: user.id,
        provider: AuthProvider.GOOGLE,
        providerSubject: identity.subject,
        providerEmail: identity.email,
      },
    });
    await transaction.auditLog.create({
      data: {
        actorId: user.id,
        action: 'AUTH_GOOGLE_LINKED',
        entityType: 'USER',
        entityId: user.id,
        metadata: { provider: 'GOOGLE' },
      },
    });

    return { alreadyLinked: false };
  });
};
