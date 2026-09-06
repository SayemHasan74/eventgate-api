import { Router } from 'express';

import { validate } from '../../middleware/validate.js';

import { readPublicEvent, readPublicEvents } from './public-events.controller.js';
import { discoveryQuerySchema, eventSlugParamsSchema } from './public-events.schemas.js';

const publicEventsRouter = Router();
publicEventsRouter.get('/', validate({ query: discoveryQuerySchema }), readPublicEvents);
publicEventsRouter.get('/:slug', validate({ params: eventSlugParamsSchema }), readPublicEvent);

export { publicEventsRouter };
