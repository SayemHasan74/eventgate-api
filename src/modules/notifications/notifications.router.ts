import { Router } from 'express';
import { z } from 'zod';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { verifiedVisitorIp } from '../../shared/security/proxy-identity.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emptyQuerySchema, emptyCommandSchema } from '../../shared/responses/read-contracts.js';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { sendList, sendSuccess, sendError } from '../../shared/responses/api-response.js';
import { getPrisma } from '../../lib/prisma.js';
import {
  notificationQuerySchema,
  preferenceSchema,
  listNotifications,
  readNotification,
  preferences,
  updatePreferences,
  requestEmailVerification,
  confirmEmail,
  emailAvailable,
} from './notifications.service.js';
import { deliverySafeSelect } from './notification-delivery.js';
const notificationsRouter = Router();
notificationsRouter.use(authenticate);
notificationsRouter.get('/', validate({ query: notificationQuerySchema }), async (r, s) => {
  const query = notificationQuerySchema.parse(r.query),
    result = await listNotifications(r.auth.id, query);
  sendList(
    s,
    'Notifications retrieved',
    result.notifications,
    paginationMeta(query, result.total),
    { unread: result.unread },
  );
});
notificationsRouter.patch(
  '/:id/read',
  validate({
    params: z.object({ id: z.string().uuid() }).strict(),
    query: emptyQuerySchema,
    body: emptyCommandSchema,
  }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Notification read',
      await readNotification(r.auth.id, r.params.id as string),
    ),
);
notificationsRouter.post(
  '/read-all',
  validate({ query: emptyQuerySchema, body: emptyCommandSchema }),
  async (r, s) => sendSuccess(s, 200, 'Notifications read', await readNotification(r.auth.id)),
);
const notificationAccountRouter = Router();
notificationAccountRouter.get(
  '/users/me/notification-preferences',
  authenticate,
  validate({ query: emptyQuerySchema }),
  async (r, s) =>
    sendSuccess(s, 200, 'Notification preferences retrieved', await preferences(r.auth.id)),
);
notificationAccountRouter.patch(
  '/users/me/notification-preferences',
  authenticate,
  validate({ query: emptyQuerySchema, body: preferenceSchema }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Notification preferences saved',
      await updatePreferences(r.auth.id, r.body),
    ),
);
const verificationLimit = rateLimit({
  windowMs: 3600000,
  limit: 5,
  keyGenerator: (request) => ipKeyGenerator(verifiedVisitorIp(request) ?? request.ip ?? 'unknown'),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_r, s) => {
    sendError(s, 429, 'Please wait before requesting another verification email', [
      { code: 'VERIFICATION_RATE_LIMITED', message: 'Please try again later.' },
    ]);
  },
});
notificationAccountRouter.post(
  '/users/me/email-verification',
  authenticate,
  verificationLimit,
  validate({ query: emptyQuerySchema, body: emptyCommandSchema }),
  async (r, s) =>
    sendSuccess(s, 202, 'Verification request received', await requestEmailVerification(r.auth.id)),
);
notificationAccountRouter.post(
  '/users/me/email-verification/confirm',
  authenticate,
  validate({
    query: emptyQuerySchema,
    body: z.object({ token: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/) }).strict(),
  }),
  async (r, s) =>
    sendSuccess(s, 200, 'Email verified', await confirmEmail(r.auth.id, r.body.token)),
);
const deliveryQuery = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
notificationAccountRouter.get(
  '/admin/reports/notification-deliveries',
  authenticate,
  authorize('ADMIN'),
  validate({ query: deliveryQuery }),
  async (r, s) => {
    const query = deliveryQuery.parse(r.query),
      db = getPrisma(),
      where = {
        channel: 'EMAIL' as const,
        state: { in: ['FAILED', 'UNKNOWN'] as ('FAILED' | 'UNKNOWN')[] },
      };
    const [rows, total] = await db.$transaction([
      db.notificationDelivery.findMany({
        where,
        select: deliverySafeSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.notificationDelivery.count({ where }),
    ]);
    sendList(s, 'Email incidents retrieved', rows, paginationMeta(query, total), {
      emailAvailable: emailAvailable() ? 1 : 0,
    });
  },
);
export { notificationsRouter, notificationAccountRouter };
