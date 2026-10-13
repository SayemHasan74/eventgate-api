import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emptyCommandSchema, emptyQuerySchema } from '../../shared/responses/read-contracts.js';
import { sendSuccess, sendList } from '../../shared/responses/api-response.js';
import { paginationMeta } from '../../shared/responses/pagination.js';
import {
  waitlistQuery,
  listWaitlists,
  waitlistMembership,
  joinWaitlist,
  leaveWaitlist,
} from './waitlists.service.js';
export const waitlistsRouter = Router();
const path = '/events/:eventId/ticket-tiers/:tierId/waitlist';
const params = z.object({ eventId: z.string().uuid(), tierId: z.string().uuid() }).strict();
waitlistsRouter.use(path, (_request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store');
  next();
});
waitlistsRouter.get(
  path,
  authenticate,
  authorize('ATTENDEE'),
  validate({ params, query: emptyQuerySchema }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Waitlist membership retrieved',
      await waitlistMembership(r.auth.id, r.params.eventId as string, r.params.tierId as string),
    ),
);
waitlistsRouter.put(
  path,
  authenticate,
  authorize('ATTENDEE'),
  validate({ params, query: emptyQuerySchema, body: emptyCommandSchema }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Waitlist joined',
      await joinWaitlist(r.auth.id, r.params.eventId as string, r.params.tierId as string),
    ),
);
waitlistsRouter.delete(
  path,
  authenticate,
  authorize('ATTENDEE'),
  validate({ params, query: emptyQuerySchema, body: emptyCommandSchema }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Waitlist left',
      await leaveWaitlist(r.auth.id, r.params.eventId as string, r.params.tierId as string),
    ),
);
waitlistsRouter.get(
  '/users/me/waitlists',
  authenticate,
  authorize('ATTENDEE'),
  validate({ query: waitlistQuery }),
  async (r, s) => {
    const query = waitlistQuery.parse(r.query),
      result = await listWaitlists(r.auth.id, query);
    sendList(s, 'Waitlists retrieved', result.entries, paginationMeta(query, result.total));
  },
);
