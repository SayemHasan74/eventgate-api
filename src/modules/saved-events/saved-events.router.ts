import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emptyQuerySchema, emptyCommandSchema } from '../../shared/responses/read-contracts.js';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import {
  savedQuery,
  saveInput,
  listSavedEvents,
  savedMembership,
  savedMemberships,
  membershipBatchQuery,
  saveEvent,
  removeSavedEvent,
} from './saved-events.service.js';
export const savedEventsRouter = Router();
savedEventsRouter.use(authenticate, authorize('ATTENDEE'));
const params = z.object({ eventId: z.string().uuid() }).strict();
savedEventsRouter.get('/', validate({ query: savedQuery }), async (r, s) => {
  const query = savedQuery.parse(r.query),
    result = await listSavedEvents(r.auth.id, query);
  sendList(s, 'Saved events retrieved', result.rows, paginationMeta(query, result.total));
});
savedEventsRouter.get('/memberships', validate({ query: membershipBatchQuery }), async (r, s) =>
  sendSuccess(
    s,
    200,
    'Saved states retrieved',
    await savedMemberships(r.auth.id, membershipBatchQuery.parse(r.query).eventIds),
  ),
);
savedEventsRouter.get('/:eventId', validate({ params, query: emptyQuerySchema }), async (r, s) =>
  sendSuccess(
    s,
    200,
    'Saved state retrieved',
    await savedMembership(r.auth.id, r.params.eventId as string),
  ),
);
savedEventsRouter.put(
  '/:eventId',
  validate({ params, query: emptyQuerySchema, body: saveInput }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Event saved',
      await saveEvent(r.auth.id, r.params.eventId as string, r.body),
    ),
);
savedEventsRouter.delete(
  '/:eventId',
  validate({ params, query: emptyQuerySchema, body: emptyCommandSchema }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Event removed',
      await removeSavedEvent(r.auth.id, r.params.eventId as string),
    ),
);
