import { createHmac, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { isQuickAccessAccount } from '../../shared/security/quick-access.js';
import {
  emailAvailable,
  verificationKey,
  tokenHash,
  tokenMatches,
  writeNotification,
} from '../notifications/notifications.service.js';

export function passwordResetToken(id: string, userId: string) {
  const key = verificationKey();
  if (!key) throw new Error('Email recovery signing is not configured.');
  return `${id}.${createHmac('sha256', key).update(`eventgate-password-reset:${id}:${userId}`).digest('base64url')}`;
}
const generic = {
  message:
    'If this address belongs to an eligible account, a password reset email has been queued.',
};
export async function requestPasswordReset(email: string) {
  if (!emailAvailable())
    throw new AppError({
      statusCode: 503,
      code: 'EMAIL_UNAVAILABLE',
      message:
        'Email recovery is unavailable until the administrator configures the email provider. Existing sign-in remains available.',
    });
  const user = await getPrisma().user.findUnique({ where: { email } });
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    user.deletedAt ||
    isQuickAccessAccount(user) ||
    !user.passwordHash
  )
    return generic;
  await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${user.id}::uuid FOR UPDATE`;
    const recent = await tx.passwordReset.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60000) } },
    });
    if (
      recent ||
      (await tx.passwordReset.count({
        where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3600000) } },
      })) >= 5
    )
      return;
    await tx.passwordReset.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const id = randomUUID();
    await tx.passwordReset.create({
      data: {
        id,
        userId: user.id,
        tokenHash: tokenHash(passwordResetToken(id, user.id)),
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    await writeNotification(
      tx,
      {
        userId: user.id,
        type: 'PASSWORD_RESET',
        title: 'Password reset requested',
        body: 'A password reset was requested. Use the private emailed link within 30 minutes. Ignore it if you did not request this.',
        actionPath: '/account/profile',
        sourceKey: `password-reset:${id}`,
      },
      undefined,
      id,
    );
  });
  return generic;
}
async function replacePassword(tx: Prisma.TransactionClient, userId: string, passwordHash: string) {
  await tx.user.update({
    where: { id: userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  await tx.refreshSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await tx.passwordReset.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await tx.auditLog.create({
    data: { actorId: userId, action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: userId },
  });
}
export async function resetPassword(token: string, password: string) {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await serializableTransaction(async (tx) => {
    const reset = await tx.passwordReset.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: true },
    });
    if (
      !reset ||
      reset.consumedAt ||
      reset.expiresAt <= new Date() ||
      !tokenMatches(token, reset.tokenHash) ||
      reset.user.status !== 'ACTIVE' ||
      reset.user.deletedAt ||
      isQuickAccessAccount(reset.user)
    )
      throw new AppError({
        statusCode: 400,
        code: 'RESET_INVALID',
        message: 'This reset link is invalid, expired, or already used.',
      });
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${reset.userId}::uuid FOR UPDATE`;
    const consumed = await tx.passwordReset.updateMany({
      where: { id: reset.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new AppError({
        statusCode: 409,
        code: 'RESET_USED',
        message: 'This link was already used.',
      });
    await replacePassword(tx, reset.userId, hash);
  });
  return { message: 'Password changed. Sign in again on each device.' };
}
export async function changePassword(userId: string, currentPassword: string, password: string) {
  const user = await getPrisma().user.findUniqueOrThrow({ where: { id: userId } });
  if (isQuickAccessAccount(user))
    throw new AppError({
      statusCode: 403,
      code: 'SHARED_ACCOUNT_PROTECTED',
      message: 'Shared account credentials cannot be changed.',
    });
  if (
    !user.passwordHash ||
    !(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))
  )
    throw new AppError({
      statusCode: 400,
      code: 'PASSWORD_INCORRECT',
      message: 'Your current password is incorrect.',
    });
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId}::uuid FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (
      current.passwordHash !== user.passwordHash ||
      current.status !== 'ACTIVE' ||
      current.deletedAt
    )
      throw new AppError({
        statusCode: 409,
        code: 'CREDENTIALS_CHANGED',
        message: 'Account credentials changed. Sign in again.',
      });
    await replacePassword(tx, userId, hash);
  });
  return { message: 'Password changed. Sign in again on each device.' };
}
