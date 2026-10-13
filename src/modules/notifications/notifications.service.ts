import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
export const notificationQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    read: z.enum(['all', 'unread', 'read']).default('all'),
    type: z
      .string()
      .regex(/^[A-Z_]{1,80}$/)
      .optional(),
  })
  .strict();
export const preferenceSchema = z
  .object({
    inAppEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    bookingUpdates: z.boolean().optional(),
    savedEventReminders: z.boolean().optional(),
    waitlistAlerts: z.boolean().optional(),
    marketingEmail: z.boolean().optional(),
    personalizedEmail: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one preference.');
export function validNotificationPath(path: string) {
  return (
    /^\/(?:account(?:\/profile)?|organizer|notifications|saved-events|waitlists)$/.test(path) ||
    /^\/(?:orders|refunds|tickets)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      path,
    ) ||
    /^\/events\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)
  );
}
export const verificationKey = () => env.EMAIL_VERIFICATION_SECRET ?? env.JWT_REFRESH_SECRET;
export const emailAvailable = () => !!(env.RESEND_API_KEY && env.EMAIL_FROM && verificationKey());
export const verificationToken = (id: string, userId: string) => {
  const key = verificationKey();
  if (!key) throw new Error('Email verification signing is not configured.');
  return `${id}.${createHmac('sha256', key)
    .update(`eventgate-email-verification:${id}:${userId}`)
    .digest('base64url')}`;
};
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const tokenMatches = (value: string, hash: string) => {
  const expected = Buffer.from(hash, 'hex'),
    actual = Buffer.from(tokenHash(value), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
type Category = 'bookingUpdates' | 'savedEventReminders' | 'waitlistAlerts' | 'security';
export function notificationCategory(type: string): Category {
  return type.includes('WAITLIST')
    ? 'waitlistAlerts'
    : type.includes('SAVED')
      ? 'savedEventReminders'
      : type === 'ROLE_CHANGED' || type === 'EMAIL_VERIFICATION'
        ? 'security'
        : 'bookingUpdates';
}
export function notificationConsent(
  preference: {
    inAppEnabled: boolean;
    emailEnabled: boolean;
    bookingUpdates: boolean;
    savedEventReminders: boolean;
    waitlistAlerts: boolean;
  },
  type: string,
  channel: 'IN_APP' | 'EMAIL',
) {
  const category = notificationCategory(type);
  return (
    (channel === 'EMAIL' ? preference.emailEnabled : preference.inAppEnabled) &&
    (category === 'security' || preference[category])
  );
}
const safeText = (text: string, max: number) =>
  [...text.replace(/https?:\/\/\S+/gi, '[link omitted]')]
    .filter((character) => character.charCodeAt(0) >= 32 || character === '\n')
    .join('')
    .slice(0, max);
export async function writeNotification(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    actionPath: string;
    sourceKey: string;
  },
  verificationId?: string,
) {
  if (!validNotificationPath(input.actionPath)) throw new Error('Unsafe notification action path.');
  const preference = await tx.notificationPreference.upsert({
    where: { userId: input.userId },
    update: {},
    create: { userId: input.userId },
  });
  const notification = await tx.notification.upsert({
    where: { userId_sourceKey: { userId: input.userId, sourceKey: input.sourceKey } },
    update: {},
    create: { ...input, title: safeText(input.title, 180), body: safeText(input.body, 1000) },
  });
  const user = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { status: true, deletedAt: true, emailVerifiedAt: true },
  });
  const active = user.status === 'ACTIVE' && !user.deletedAt;
  for (const channel of ['IN_APP', 'EMAIL'] as const) {
    const allowed =
      active &&
      ((verificationId && channel === 'EMAIL') ||
        notificationConsent(preference, input.type, channel));
    await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: notification.id, channel } },
      update: {},
      create: {
        notificationId: notification.id,
        channel,
        idempotencyKey: `notice:${notification.id}:${channel}`,
        state: !allowed ? 'CANCELLED' : channel === 'IN_APP' ? 'SENT' : 'PENDING',
        nextAttemptAt: allowed && channel === 'EMAIL' ? new Date() : null,
        error: allowed ? null : 'CONSENT_OR_ACCOUNT_DISABLED',
        ...(verificationId && channel === 'EMAIL' ? { verificationId } : {}),
      },
    });
  }
  return notification;
}
export async function writeRefundNotice(
  tx: Prisma.TransactionClient,
  refundId: string,
  status: string,
  source: string,
) {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    select: { id: true, order: { select: { attendeeId: true, eventNameSnapshot: true } } },
  });
  await writeNotification(tx, {
    userId: refund.order.attendeeId,
    type: 'REFUND_UPDATE',
    title: 'Refund status updated',
    body: `${refund.order.eventNameSnapshot}: ${status.replaceAll('_', ' ')}. Check the persisted refund timeline. Processing is not settlement.`,
    actionPath: `/refunds/${refund.id}`,
    sourceKey: `refund:${refund.id}:${source}`,
  });
}
const noticeSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  actionPath: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;
export async function listNotifications(
  userId: string,
  query: z.infer<typeof notificationQuerySchema>,
) {
  const db = getPrisma();
  const base = {
    userId,
    deliveries: { some: { channel: 'IN_APP' as const, state: 'SENT' as const } },
  };
  const where = {
    ...base,
    ...(query.type ? { type: query.type } : {}),
    ...(query.read === 'unread'
      ? { readAt: null }
      : query.read === 'read'
        ? { readAt: { not: null } }
        : {}),
  };
  const [notifications, total, unread] = await db.$transaction([
    db.notification.findMany({
      where,
      select: noticeSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.notification.count({ where }),
    db.notification.count({ where: { ...base, readAt: null } }),
  ]);
  return { notifications, total, unread };
}
export async function readNotification(userId: string, id?: string) {
  const result = await getPrisma().notification.updateMany({
    where: {
      userId,
      ...(id ? { id } : {}),
      deliveries: { some: { channel: 'IN_APP', state: 'SENT' } },
    },
    data: { readAt: new Date() },
  });
  if (id && !result.count)
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Notification not found.' });
  return { updated: result.count };
}
export async function preferences(userId: string) {
  const db = getPrisma();
  const [preference, user] = await Promise.all([
    db.notificationPreference.upsert({ where: { userId }, update: {}, create: { userId } }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { emailVerifiedAt: true } }),
  ]);
  return {
    ...preference,
    emailVerifiedAt: user.emailVerifiedAt,
    emailAvailable: emailAvailable(),
    emailConfigurationMessage: emailAvailable()
      ? null
      : 'Email is disabled until the server email provider/sender is configured. In-app notifications remain available.',
  };
}
export async function updatePreferences(userId: string, input: z.infer<typeof preferenceSchema>) {
  const data = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Record<string, boolean>;
  await getPrisma().notificationPreference.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
  return preferences(userId);
}
export async function requestEmailVerification(userId: string) {
  const generic = {
    message:
      'If this account is eligible and email is configured, a verification email is queued. Sign in before opening the emailed link.',
  };
  if (!emailAvailable()) return generic;
  await serializableTransaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== 'ACTIVE' || user.deletedAt || user.emailVerifiedAt) return;
    const recent = await tx.emailVerification.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < 60000) return;
    if (
      (await tx.emailVerification.count({
        where: { userId, createdAt: { gt: new Date(Date.now() - 3600000) } },
      })) >= 5
    )
      return;
    const id = randomUUID(),
      token = verificationToken(id, userId);
    await tx.emailVerification.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.emailVerification.create({
      data: {
        id,
        userId,
        email: user.email,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    await writeNotification(
      tx,
      {
        userId,
        type: 'EMAIL_VERIFICATION',
        title: 'Email verification requested',
        body: 'Use the verification link in your email within 30 minutes. No subscription is enabled by verifying your address.',
        actionPath: '/account/profile',
        sourceKey: `verification:${id}`,
      },
      id,
    );
  });
  return generic;
}
export async function confirmEmail(userId: string, token: string) {
  return serializableTransaction(async (tx) => {
    const record = await tx.emailVerification.findUnique({
      where: { tokenHash: tokenHash(token) },
    });
    if (
      !record ||
      record.userId !== userId ||
      record.consumedAt ||
      record.expiresAt <= new Date() ||
      !tokenMatches(token, record.tokenHash)
    )
      throw new AppError({
        statusCode: 400,
        code: 'VERIFICATION_INVALID',
        message:
          'Verification link is invalid, expired, already used, or belongs to another account.',
      });
    const used = await tx.emailVerification.updateMany({
      where: { id: record.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (used.count !== 1)
      throw new AppError({
        statusCode: 409,
        code: 'VERIFICATION_USED',
        message: 'This link was already used.',
      });
    const changed = await tx.user.updateMany({
      where: { id: userId, email: record.email, status: 'ACTIVE', deletedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    if (changed.count !== 1)
      throw new AppError({
        statusCode: 403,
        code: 'ACCOUNT_INACTIVE',
        message: 'This account cannot verify that address.',
      });
    return { verified: true };
  });
}
