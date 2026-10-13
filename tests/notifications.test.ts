import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  notification: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  notificationPreference: { upsert: vi.fn() },
  notificationDelivery: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  user: { findUniqueOrThrow: vi.fn() },
  emailVerification: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../src/lib/prisma.js', () => ({ getPrisma: () => db }));
vi.mock('../src/config/env.js', () => ({
  env: {
    RESEND_API_KEY: 'test-only',
    EMAIL_FROM: 'test@example.test',
    JWT_REFRESH_SECRET: 'test-only-verification-key',
    FRONTEND_URL: 'https://frontend.example',
  },
}));
const {
  validNotificationPath,
  notificationConsent,
  tokenHash,
  tokenMatches,
  verificationToken,
  listNotifications,
  readNotification,
  confirmEmail,
  writeNotification,
} = await import('../src/modules/notifications/notifications.service.js');
const { sendEmail, canRetryEmail, deliverNotification } =
  await import('../src/modules/notifications/notification-delivery.js');
const id = '123e4567-e89b-42d3-a456-426614174000';
const defaults = {
  inAppEnabled: true,
  emailEnabled: false,
  bookingUpdates: true,
  savedEventReminders: true,
  waitlistAlerts: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  db.$transaction.mockImplementation((operation) =>
    Array.isArray(operation) ? Promise.all(operation) : operation(db),
  );
  db.$queryRaw.mockResolvedValue([]);
});
describe('notification safety boundaries', () => {
  it('allows only local record destinations and applies independent consent', () => {
    expect(validNotificationPath(`/orders/${id}`)).toBe(true);
    expect(validNotificationPath(`/events/example/tickets?tierId=${id}`)).toBe(true);
    expect(
      validNotificationPath(`/events/example/tickets?tierId=${id}&next=https://evil.test`),
    ).toBe(false);
    for (const path of [
      '//evil.test',
      'https://evil.test',
      '/orders/invalid',
      '/account?token=secret',
      '/account/../admin',
    ])
      expect(validNotificationPath(path)).toBe(false);
    expect(notificationConsent(defaults, 'BOOKING_PAID', 'IN_APP')).toBe(true);
    expect(notificationConsent(defaults, 'BOOKING_PAID', 'EMAIL')).toBe(false);
    expect(
      notificationConsent({ ...defaults, bookingUpdates: false }, 'REFUND_UPDATE', 'IN_APP'),
    ).toBe(false);
  });
  it('binds verification proof to one user and rejects used, expired and foreign links', async () => {
    const token = verificationToken(id, 'owner'),
      hash = tokenHash(token);
    expect(hash).not.toContain(token);
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches(verificationToken(id, 'other'), hash)).toBe(false);
    for (const record of [
      { userId: 'other', consumedAt: null, expiresAt: new Date(Date.now() + 60000) },
      { userId: 'owner', consumedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
      { userId: 'owner', consumedAt: null, expiresAt: new Date(0) },
    ]) {
      db.emailVerification.findUnique.mockResolvedValue({ ...record, id, tokenHash: hash });
      await expect(confirmEmail('owner', token)).rejects.toMatchObject({
        code: 'VERIFICATION_INVALID',
      });
    }
    expect(db.emailVerification.updateMany).not.toHaveBeenCalled();
  });
  it('keeps all list/count/read operations owner-filtered and badge aggregate unfiltered', async () => {
    db.notification.findMany.mockResolvedValue([]);
    db.notification.count.mockResolvedValue(0);
    await listNotifications('owner', { page: 1, limit: 20, read: 'unread', type: 'BOOKING_PAID' });
    expect(db.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'owner', type: 'BOOKING_PAID', readAt: null }),
      }),
    );
    expect(db.notification.count.mock.calls[1]?.[0].where).toMatchObject({
      userId: 'owner',
      readAt: null,
    });
    expect(db.notification.count.mock.calls[1]?.[0].where).not.toHaveProperty('type');
    db.notification.updateMany.mockResolvedValue({ count: 0 });
    await expect(readNotification('owner', id)).rejects.toMatchObject({ statusCode: 404 });
    expect(db.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'owner', id }) }),
    );
  });
  it('uses immutable source and channel upserts without sending email inside transactions', async () => {
    db.notificationPreference.upsert.mockResolvedValue(defaults);
    db.notification.upsert.mockResolvedValue({ id });
    db.user.findUniqueOrThrow.mockResolvedValue({
      status: 'ACTIVE',
      deletedAt: null,
      emailVerifiedAt: null,
    });
    const input = {
      userId: 'owner',
      type: 'BOOKING_PAID',
      title: 'Confirmed',
      body: 'Open your booking.',
      actionPath: `/orders/${id}`,
      sourceKey: 'order:once',
    };
    await writeNotification(db as never, input);
    await writeNotification(db as never, input);
    expect(db.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_sourceKey: { userId: 'owner', sourceKey: 'order:once' } },
        update: {},
      }),
    );
    expect(db.notificationDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({ channel: 'IN_APP', state: 'SENT' }),
      }),
    );
    expect(db.notificationDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({ channel: 'EMAIL', state: 'CANCELLED' }),
      }),
    );
  });
  it('uses the provider key and preserves ambiguous outcomes with bounded retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      from: 'test@example.test',
      to: 'user@example.test',
      subject: 'Update',
      text: 'Safe body',
      key: 'notice:stable',
    };
    expect(await sendEmail(input)).toMatchObject({ state: 'UNKNOWN' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'notice:stable' }),
      }),
    );
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 }),
    );
    expect(await sendEmail(input)).toEqual({ state: 'SENT', id: 'provider-id' });
    expect(canRetryEmail(5, new Date())).toBe(false);
    expect(canRetryEmail(1, new Date(Date.now() - 24 * 3600000))).toBe(false);
  });
  it('does not relabel an uncertain send as cancelled after consent is withdrawn', async () => {
    db.notificationDelivery.findUnique.mockResolvedValue({
      id,
      channel: 'EMAIL',
      state: 'UNKNOWN',
      nextAttemptAt: new Date(0),
      recipient: 'user@example.test',
      notification: {
        type: 'BOOKING_PAID',
        user: {
          email: 'user@example.test',
          status: 'ACTIVE',
          deletedAt: null,
          emailVerifiedAt: new Date(),
          notificationPreference: defaults,
        },
      },
      verification: null,
    });
    const adapter = vi.fn();
    await deliverNotification(id, adapter);
    expect(adapter).not.toHaveBeenCalled();
    expect(db.notificationDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'UNKNOWN', nextAttemptAt: null }),
      }),
    );
  });
});
