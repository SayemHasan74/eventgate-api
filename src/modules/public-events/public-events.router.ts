import { Router } from 'express';

import { validate } from '../../middleware/validate.js';

import { readPublicEvent, readPublicEvents } from './public-events.controller.js';
import { discoveryQuerySchema, eventSlugParamsSchema } from './public-events.schemas.js';
import { getEventFacets, getPublicAvailability } from './public-events.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import { emptyQuerySchema } from '../../shared/responses/read-contracts.js';

const publicEventsRouter = Router();
publicEventsRouter.get('/', validate({ query: discoveryQuerySchema }), readPublicEvents);
publicEventsRouter.get(
  '/facets',
  validate({ query: emptyQuerySchema }),
  async (_request, response) =>
    sendSuccess(response, 200, 'Event facets retrieved', await getEventFacets()),
);
publicEventsRouter.get(
  '/:slug/availability',
  validate({ params: eventSlugParamsSchema, query: emptyQuerySchema }),
  async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    sendSuccess(
      response,
      200,
      'Availability retrieved',
      await getPublicAvailability(request.params.slug as string),
    );
  },
);
publicEventsRouter.get(
  '/:slug',
  validate({ params: eventSlugParamsSchema, query: emptyQuerySchema }),
  readPublicEvent,
);

export { publicEventsRouter };
