import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { env } from '../../config/env.js';
import { reminderStillRelevant } from '../saved-events/reminders.service.js';
import { waitlistAlertStillRelevant } from '../waitlists/availability.service.js';
import {
  emailAvailable,
  notificationConsent,
  verificationToken,
  tokenMatches,
  writeNotification,
} from './notifications.service.js';
export type EmailResult =
  { state: 'SENT'; id: string } | { state: 'PENDING' | 'UNKNOWN' | 'FAILED'; error: string };
export async function sendEmail(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  key: string;
}): Promise<EmailResult> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.key,
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      id?: unknown;
      name?: unknown;
    } | null;
    if (
      response.ok &&
      typeof payload?.id === 'string' &&
      payload.id.length > 0 &&
      payload.id.length <= 255
    )
      return { state: 'SENT', id: payload.id };
    if (
      response.status === 429 ||
      (response.status === 409 && payload?.name === 'concurrent_idempotent_requests')
    )
      return { state: 'PENDING', error: 'EMAIL_PROVIDER_RETRY_LATER' };
    if (response.status >= 400 && response.status < 500)
      return { state: 'FAILED', error: 'EMAIL_PROVIDER_REJECTED_CHECK_CONFIGURATION' };
    return { state: 'UNKNOWN', error: 'EMAIL_PROVIDER_OUTCOME_UNCONFIRMED' };
  } catch {
    return { state: 'UNKNOWN', error: 'EMAIL_PROVIDER_OUTCOME_UNCONFIRMED' };
  }
}
export const canRetryEmail = (attempts: number, firstAttemptAt: Date, now = new Date()) =>
  attempts < 5 && now.getTime() - firstAttemptAt.getTime() < 23 * 3600000;
export async function deliverNotification(id: string, adapter = sendEmail) {
  const claimed = await serializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "NotificationDelivery" WHERE "id" = ${id}::uuid FOR UPDATE`,
    );
    const delivery = await tx.notificationDelivery.findUnique({
      where: { id },
      include: {
        notification: { include: { user: { include: { notificationPreference: true } } } },
        verification: true,
      },
    });
    if (
      !delivery ||
      delivery.channel !== 'EMAIL' ||
      ['SENT', 'FAILED', 'CANCELLED'].includes(delivery.state)
    )
      return null;
    const now = new Date();
    if (delivery.state === 'SENDING' && delivery.leaseExpiresAt && delivery.leaseExpiresAt > now)
      return null;
    if (delivery.nextAttemptAt && delivery.nextAttemptAt > now) return null;
    if (delivery.state === 'UNKNOWN' && !delivery.nextAttemptAt) return null;
    const user = delivery.notification.user,
      preference = user.notificationPreference;
    const reminderEligible =
      !delivery.notification.reminderJobId ||
      !!(await tx.job
        .findUnique({
          where: { id: delivery.notification.reminderJobId },
          select: { payload: true },
        })
        .then((job) => (job ? reminderStillRelevant(tx, job, user.id, now) : null)));
    const eligible =
      (delivery.notification.type !== 'WAITLIST_STOCK_ALERT' ||
        (await waitlistAlertStillRelevant(tx, user.id, delivery.notification.sourceKey))) &&
      reminderEligible &&
      user.status === 'ACTIVE' &&
      !user.deletedAt &&
      (!delivery.recipient || delivery.recipient === user.email) &&
      (delivery.verification
        ? delivery.verification.email === user.email &&
          !delivery.verification.consumedAt &&
          delivery.verification.expiresAt > now
        : !!user.emailVerifiedAt &&
          !!preference &&
          notificationConsent(preference, delivery.notification.type, 'EMAIL'));
    if (!emailAvailable() || !eligible) {
      await tx.notificationDelivery.update({
        where: { id },
        data: {
          state: ['UNKNOWN', 'SENDING'].includes(delivery.state) ? 'UNKNOWN' : 'CANCELLED',
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: !emailAvailable() ? 'EMAIL_DISABLED' : 'CONSENT_ACCOUNT_OR_VERIFICATION_BLOCKED',
        },
      });
      return null;
    }
    const first = delivery.firstAttemptAt ?? now;
    if (!canRetryEmail(delivery.attempts, first, now)) {
      await tx.notificationDelivery.update({
        where: { id },
        data: {
          state: delivery.state === 'PENDING' ? 'FAILED' : 'UNKNOWN',
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: 'EMAIL_RETRY_LIMIT_OR_IDEMPOTENCY_WINDOW_EXPIRED',
        },
      });
      return null;
    }
    const leaseToken = randomUUID();
    const updated = await tx.notificationDelivery.update({
      where: { id },
      data: {
        state: 'SENDING',
        attempts: { increment: 1 },
        firstAttemptAt: first,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 90000),
        recipient: delivery.recipient ?? user.email,
        sender: delivery.sender ?? env.EMAIL_FROM!,
        baseUrl: delivery.baseUrl ?? env.FRONTEND_URL.replace(/\/$/, ''),
      },
    });
    return { ...updated, notification: delivery.notification, verification: delivery.verification };
  });
  if (claimed) {
    let text = `${claimed.notification.body}\n\nOpen EventGate: ${claimed.baseUrl}${claimed.notification.actionPath}`;
    if (claimed.verification) {
      const token = verificationToken(claimed.verification.id, claimed.verification.userId);
      if (!tokenMatches(token, claimed.verification.tokenHash)) {
        await getPrisma().notificationDelivery.updateMany({
          where: { id, leaseToken: claimed.leaseToken, state: 'SENDING' },
          data: {
            state: 'CANCELLED',
            nextAttemptAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            error: 'VERIFICATION_KEY_CHANGED',
          },
        });
        return;
      }
      text = `Verify your EventGate email within 30 minutes. Sign in as this account, then open:\n${claimed.baseUrl}/account/verify-email#token=${token}\n\nVerification does not enable email subscriptions. Ignore this if you did not request it.`;
    }
    const result = await adapter({
      from: claimed.sender!,
      to: claimed.recipient!,
      subject: claimed.notification.title,
      text,
      key: claimed.idempotencyKey,
    });
    const retry =
      result.state !== 'SENT' &&
      result.state !== 'FAILED' &&
      canRetryEmail(claimed.attempts, claimed.firstAttemptAt!);
    await getPrisma().notificationDelivery.updateMany({
      where: {
        id,
        state: 'SENDING',
        leaseToken: claimed.leaseToken,
        leaseExpiresAt: { gt: new Date() },
      },
      data: {
        state: result.state === 'PENDING' && !retry ? 'FAILED' : result.state,
        providerMessageId: result.state === 'SENT' ? result.id : null,
        error: result.state === 'SENT' ? null : result.error,
        nextAttemptAt: retry
          ? new Date(Date.now() + Math.min(60000 * 2 ** (claimed.attempts - 1), 900000))
          : null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }
  return getPrisma().notificationDelivery.findUnique({
    where: { id },
    select: { state: true, nextAttemptAt: true },
  });
}
export async function notifyCancellation(job: {
  id: string;
  leaseToken: string | null;
  payload: Prisma.JsonValue;
}) {
  const payload = job.payload as { eventId?: string; cursor?: string };
  if (!payload.eventId) throw new Error('Cancellation notification source missing.');
  const eventId = payload.eventId;
  return serializableTransaction(
    async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        select: { id: true, title: true, status: true },
      });
      if (!event || event.status !== 'CANCELLED') return true;
      const users = await tx.user.findMany({
        where: {
          ...(payload.cursor ? { id: { gt: payload.cursor } } : {}),
          orders: { some: { eventId: event.id, tickets: { some: {} } } },
        },
        select: {
          id: true,
          orders: {
            where: { eventId: event.id, tickets: { some: {} } },
            select: { id: true },
            take: 1,
            orderBy: { id: 'asc' },
          },
        },
        orderBy: { id: 'asc' },
        take: 10,
      });
      for (const user of users)
        await writeNotification(tx, {
          userId: user.id,
          type: 'EVENT_CANCELLED',
          title: 'Event cancelled',
          body: `${event.title} was cancelled. Check your booking and refund timeline; provider settlement may still be pending.`,
          actionPath: `/orders/${user.orders[0]!.id}`,
          sourceKey: `event-cancel:${event.id}`,
        });
      if (users.length) {
        const updated = await tx.job.updateMany({
          where: {
            id: job.id,
            status: 'RUNNING',
            leaseToken: job.leaseToken,
            leaseExpiresAt: { gt: new Date() },
          },
          data: { payload: { eventId: event.id, cursor: users.at(-1)!.id } },
        });
        if (updated.count !== 1) throw new Error('Notification fanout lease lost.');
      }
      return users.length < 10;
    },
    { timeout: 15000 },
  );
}
export const deliverySafeSelect = {
  id: true,
  state: true,
  channel: true,
  attempts: true,
  nextAttemptAt: true,
  firstAttemptAt: true,
  error: true,
  providerMessageId: true,
  createdAt: true,
  notification: { select: { type: true, title: true, userId: true } },
} satisfies Prisma.NotificationDeliverySelect;
