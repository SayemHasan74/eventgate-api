import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { getManagedEvent, listManagedEvents } from '../events/events.service.js';
import { eventIdParamsSchema, managedEventQuerySchema } from '../events/events.schemas.js';
import { requestEventCancellation } from '../events/events.controller.js';
import {
  getAdminUser,
  getPayment,
  listPayments,
  paymentListQuerySchema,
  attendeeOverview,
  organizerOverview,
} from './workspace-reads.service.js';

const empty = z.object({}).strict();
const adminReadsRouter = Router();
adminReadsRouter.use(authenticate, authorize('ADMIN'));
adminReadsRouter.get(
  '/events',
  validate({ query: managedEventQuerySchema }),
  async (request, response) => {
    const query = managedEventQuerySchema.parse(request.query);
    const result = await listManagedEvents(request.auth, query);
    sendList(
      response,
      'Events retrieved',
      result.events,
      paginationMeta(query, result.total),
      result.summary,
    );
  },
);
adminReadsRouter.get(
  '/events/:eventId',
  validate({ params: eventIdParamsSchema, query: empty }),
  async (request, response) =>
    sendSuccess(
      response,
      200,
      'Event retrieved',
      await getManagedEvent(request.auth, request.params.eventId as string, true),
    ),
);
adminReadsRouter.post(
  '/events/:eventId/cancel',
  validate({ params: eventIdParamsSchema, query: empty, body: empty.default({}) }),
  requestEventCancellation,
);
adminReadsRouter.get(
  '/payments',
  validate({ query: paymentListQuerySchema }),
  async (request, response) => {
    const query = paymentListQuerySchema.parse(request.query);
    const result = await listPayments(query);
    sendList(response, 'Payments retrieved', result.payments, paginationMeta(query, result.total));
  },
);
adminReadsRouter.get(
  '/payments/:attemptId',
  validate({ params: z.object({ attemptId: z.string().uuid() }).strict(), query: empty }),
  async (request, response) =>
    sendSuccess(
      response,
      200,
      'Payment retrieved',
      await getPayment(request.params.attemptId as string),
    ),
);
adminReadsRouter.get(
  '/users/:userId',
  validate({ params: z.object({ userId: z.string().uuid() }).strict(), query: empty }),
  async (request, response) =>
    sendSuccess(
      response,
      200,
      'User retrieved',
      await getAdminUser(request.params.userId as string),
    ),
);

const overviewRouter = Router();
overviewRouter.get(
  '/users/me/overview',
  authenticate,
  authorize('ATTENDEE'),
  validate({ query: empty }),
  async (request, response) =>
    sendSuccess(
      response,
      200,
      'Attendee overview retrieved',
      await attendeeOverview(request.auth.id),
    ),
);
overviewRouter.get(
  '/organizer/overview',
  authenticate,
  authorize('ORGANIZER', 'ADMIN'),
  validate({ query: empty }),
  async (request, response) =>
    sendSuccess(
      response,
      200,
      'Organizer overview retrieved',
      await organizerOverview(request.auth.id, request.auth.role),
    ),
);
export { adminReadsRouter, overviewRouter };
