import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emptyQuerySchema } from '../../shared/responses/read-contracts.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import {
  preferences,
  updatePreferences,
  recommendedEvents,
  preferenceInput,
  recommendationQuery,
} from './recommendations.service.js';

export const recommendationsRouter = Router();
const noStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store');
  next();
};
recommendationsRouter.get(
  '/users/me/event-preferences',
  noStore,
  authenticate,
  authorize('ATTENDEE'),
  validate({ query: emptyQuerySchema }),
  async (r, s) => sendSuccess(s, 200, 'Event preferences retrieved', await preferences(r.auth.id)),
);
recommendationsRouter.patch(
  '/users/me/event-preferences',
  noStore,
  authenticate,
  authorize('ATTENDEE'),
  validate({ query: emptyQuerySchema, body: preferenceInput }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Event preferences saved',
      await updatePreferences(r.auth.id, preferenceInput.parse(r.body)),
    ),
);
recommendationsRouter.get(
  '/events/recommended',
  noStore,
  authenticate,
  authorize('ATTENDEE'),
  validate({ query: recommendationQuery }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Events retrieved',
      await recommendedEvents(r.auth.id, recommendationQuery.parse(r.query).limit),
    ),
);
